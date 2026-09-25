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
 * 作用域（明示）：
 *   - 只动 sqlite `vectors.db` 的 `l0_conversations` / `l1_records` 两张基表
 *     的 `team_id` 列；vec0/FTS 表只按 record_id 键控（搜索滤镜水合走基表），
 *     无需同步。L2/L3 profile 行与文件**不动**——共享时代 persona 是跨用户
 *     共享物（冷启动语义，见设计文档 §5）。checkpoint 游标不动：已提取过的
 *     历史 L1 留在共享 persona 里（割接后本就不可见），新 L1 起按人分形。
 *   - tcvdb/mongo 部署如需同等归一，走各自的 update-by-filter（本脚本不覆盖）。
 *
 * 安全设计：
 *   1. **默认 dry-run**：只打印每表命中数与按 user_id 分布，不动数据。
 *   2. `--confirm` 才执行；单事务包裹（原子 + 幂等：WHERE 条件二次运行命中 0）。
 *   3. 只改 `team_id='default' AND user_id NOT IN ('', 'default')` 的行——
 *      匿名桶（user_id='default'）与真实 team 的行一概不碰。
 *   4. 建议先停网关（或低峰执行）+ 备份 vectors.db（`cp vectors.db
 *      vectors.db.bak-$(date +%s)`）。写门禁开启后新写入不可能再落共享桶。
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

const TABLES = ["l0_conversations", "l1_records"] as const;
const BACKFILL_WHERE =
  "team_id = 'default' AND user_id IS NOT NULL AND user_id <> '' AND user_id <> 'default'";

const db = new DatabaseSync(dbArg, confirm ? {} : { readOnly: true });
try {
  // 前置校验：两张基表与列都在（防指错库/老库缺列）。
  for (const table of TABLES) {
    let cols: Array<{ name: string }>;
    try {
      cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    } catch {
      console.error(`✗ 表 ${table} 不存在 —— 指错库？(${dbArg})`);
      process.exit(2);
    }
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("team_id") || !names.has("user_id")) {
      console.error(`✗ 表 ${table} 缺 team_id/user_id 列 —— 过老 schema？`);
      process.exit(2);
    }
  }

  const pendingCount = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${BACKFILL_WHERE}`).get() as { n: number }).n;

  const report = (label: string) => {
    console.log(`\n== ${label} ==`);
    for (const table of TABLES) {
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

  // 单事务：两表要么都回填要么都不动（node:sqlite 无 db.transaction 助手）。
  db.exec("BEGIN");
  try {
    for (const table of TABLES) {
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
  for (const table of TABLES) {
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
