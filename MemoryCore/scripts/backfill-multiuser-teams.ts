/**
 * 跨代回填：multiUser 割接前的 L0/L1 行归一到 per-user team 列（sqlite）。
 *
 * 背景（docs/v3-user-routing-design.md §5「跨代混合会话」）：
 *   割接前（multiUser.enabled=false）所有行落 `team_id="default"`（user_id
 *   已带真实身份）；割接后 subsume 写 `team_id={uid}`。L1 分组的 teamId 取
 *   组内首行的列——混合列的老会话会继续把新消息归入共享 scope。本脚本把
 *   割接前的行改写为 `team_id := user_id`，使两代列归一，混合长会话从下一
 *   轮提取起走 per-user scope。
 *
 * 作用域（明示，评审轮 5 修正 FTS 表述）：
 *   - 动 `vectors.db` 的 `l0_conversations` / `l1_records` 两张基表，**以及
 *     `l0_fts` / `l1_fts` 的同名列**——FTS 表的 team_id/user_id/agent_id 是
 *     UNINDEXED 冗余列，`searchL0Fts`/`searchL1Fts` 直接在 FTS 行上过滤
 *     （不经基表水合），只回填基表会造成两表可见性分叉。FTS 不可用的部署
 *     可能没有这两张表（建表失败 tolerated）——检测缺席即跳过该表。
 *     vec0 才是例外：只按 record_id 键控，向量搜索滤镜经 stmtGetMeta 从
 *     基表水合，无需同步。
 *   - L2/L3 profile 行与文件**不动**——共享时代 persona 是跨用户共享物
 *     （冷启动语义，见设计文档 §5）。checkpoint 游标不动：已提取过的历史
 *     L1 留在共享 persona 里（割接后本就不可见），新 L1 起按人分形。
 *   - tcvdb/mongo 部署如需同等归一，走各自的 update-by-filter（本脚本不覆盖）。
 *
 * 安全设计：
 *   1. **默认 dry-run**：只打印每表命中数与按 user_id 分布，不动数据。
 *   2. `--confirm` 才执行；单事务包裹（原子 + 幂等：WHERE 条件二次运行命中 0）。
 *   3. 只改 `team_id='default' AND user_id NOT IN ('', 'default')` 的行——
 *      匿名桶（user_id='default'）与真实 team 的行一概不碰。
 *   4. 建议先停网关（或低峰执行）+ 备份 vectors.db（`cp vectors.db
 *      vectors.db.bak-$(date +%s)`）。写门禁开启后 **v3 数据面**新写入不再
 *      落共享桶；但门禁只覆盖 v3（applyMultiUserV3Routing 仅挂 v3 路由），
 *      `/v2/conversation/add` 等直写方仍可写共享桶行——存在 /v2 写入方的
 *      部署，割接后需重跑本脚本（幂等）。
 *
 * ⚠️ 目标库路径：v3 数据面（插件流量）按 serviceId 走 store pool 实例路由，
 * 行落在 `<dataDir>/instances/<serviceId>/vectors.db`（standalone 也是，e2e
 * 实证）；v1 物理 core 面才落 `<dataDir>/users/<uid>/vectors.db` 或根库。
 * 回填 v3 数据请把 --db 指到**实例库**。路径不含 `/instances/` 时脚本会打
 * ⚠ 警示（根库/v1 库上执行会把共享行归到个人 scope），dry-run 命中数可
 * 自行验证指对了库。
 *
 * 用法（驱动与 store 同源：Node 内建 node:sqlite，无原生依赖）：
 *   node --import tsx scripts/backfill-multiuser-teams.ts --db <path/to/vectors.db>            # dry-run
 *   node --import tsx scripts/backfill-multiuser-teams.ts --db <path/to/vectors.db> --confirm  # 执行回填
 */
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith("--db="))?.slice(5)
  ?? args[args.indexOf("--db") + 1];
const confirm = args.includes("--confirm");

if (!dbArg || dbArg === "--confirm" || typeof dbArg !== "string") {
  console.error("用法: node --import tsx scripts/backfill-multiuser-teams.ts --db <path/to/vectors.db> [--confirm]");
  process.exit(2);
}

const BASE_TABLES = ["l0_conversations", "l1_records"] as const;
const FTS_TABLES = ["l0_fts", "l1_fts"] as const;
const BACKFILL_WHERE =
  "team_id = 'default' AND user_id IS NOT NULL AND user_id <> '' AND user_id <> 'default'";

if (!dbArg.replaceAll("\\", "/").includes("/instances/")) {
  console.warn("⚠ --db 路径不含 /instances/：v3 数据面行落 <dataDir>/instances/<serviceId>/vectors.db");
  console.warn("  （e2e 实证）。若指向根库或 v1 用户库，回填会把共享行归到个人 scope——");
  console.warn("  请先用 dry-run 命中数确认指对了库。");
}

const db = new DatabaseSync(dbArg, confirm ? {} : { readOnly: true });
try {
  // 前置校验：基表必须存在且列齐（防指错库/老库缺列）；FTS 表缺席 tolerated。
  // PRAGMA table_info 对不存在的表返回空集而非报错——以空集判缺席，报错文案
  // 才不会误归因为 schema 过老。
  const tableColumns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  const targets: string[] = [];
  for (const table of BASE_TABLES) {
    const cols = tableColumns(table);
    if (cols.length === 0) {
      console.error(`✗ 基表 ${table} 不存在 —— 指错库？(${dbArg})`);
      process.exit(2);
    }
    if (!cols.includes("team_id") || !cols.includes("user_id")) {
      console.error(`✗ 表 ${table} 缺 team_id/user_id 列 —— 过老 schema？`);
      process.exit(2);
    }
    targets.push(table);
  }
  for (const table of FTS_TABLES) {
    const cols = tableColumns(table);
    if (cols.length === 0) {
      console.log(`· ${table} 不存在（FTS 不可用部署）—— 跳过`);
    } else if (!cols.includes("team_id") || !cols.includes("user_id")) {
      console.warn(`⚠ ${table} 缺 team_id/user_id 列（过老 FTS schema）—— 跳过，基表照常回填`);
    } else {
      targets.push(table);
    }
  }

  const pendingCount = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${BACKFILL_WHERE}`).get() as { n: number }).n;

  const report = (label: string) => {
    console.log(`\n== ${label} ==`);
    for (const table of targets) {
      const total = pendingCount(table);
      console.log(`${table}: 待回填 ${total} 行`);
      if (total > 0) {
        const byUser = db.prepare(
          `SELECT user_id, COUNT(*) AS n FROM ${table} WHERE ${BACKFILL_WHERE} GROUP BY user_id ORDER BY n DESC LIMIT 20`,
        ).all() as Array<{ user_id: string; n: number }>;
        for (const row of byUser) console.log(`  ${row.user_id}: ${row.n}`);
        if (total > byUser.reduce((s, r) => s + r.n, 0)) console.log("  …(仅列前 20)");
      }
    }
  };

  report(confirm ? "执行前" : "dry-run（加 --confirm 执行）");
  if (!confirm) process.exit(0);

  // 单事务：基表 + FTS 表要么都回填要么都不动（node:sqlite 无 db.transaction 助手）。
  db.exec("BEGIN");
  try {
    for (const table of targets) {
      const changes = db.prepare(
        `UPDATE ${table} SET team_id = user_id WHERE ${BACKFILL_WHERE}`,
      ).run().changes;
      console.log(`✓ ${table}: 回填 ${changes} 行`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // 幂等自检：二次查询必须为 0
  for (const table of targets) {
    const left = pendingCount(table);
    if (left !== 0) {
      console.error(`✗ ${table} 仍有 ${left} 行待回填（异常，请检查并发写入）`);
      process.exit(1);
    }
  }
  console.log("✓ 幂等自检通过：无残留待回填行");
} finally {
  db.close();
}
