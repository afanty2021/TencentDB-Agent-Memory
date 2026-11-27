/**
 * 按人分库导入 CLI（docs/per-user-stores-v3-design.md §9、§13.1）。逻辑在
 * scripts/lib/per-user-import.ts；本文件只解析参数、打印报告、设退出码。
 *
 *   node --import tsx scripts/import-per-user-stores.ts --data-dir <baseDir> [--owners a,b]            # dry-run
 *   node --import tsx scripts/import-per-user-stores.ts --data-dir <baseDir> [--owners a,b] --confirm  # 执行
 *
 * 退出码：0 = 自检通过；1 = 自检未通过（不要开启 multiUser）；2 = 用法错误。
 * 主库始终只读打开，本脚本对主库零写入。
 */
import { importPerUserStores } from "./lib/per-user-import.js";

const USAGE =
  "用法: node --import tsx scripts/import-per-user-stores.ts --data-dir <baseDir> [--owners a,b] [--confirm]";

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const baseDir = argValue("data-dir");
  const ownersArg = argValue("owners");
  const confirm = process.argv.includes("--confirm");
  if (!baseDir || baseDir.startsWith("--")) {
    console.error(USAGE);
    process.exit(2);
  }

  const report = await importPerUserStores({
    baseDir,
    owners: ownersArg ? ownersArg.split(",").map((s) => s.trim()).filter(Boolean) : [],
    confirm,
    log: (line) => console.log(line),
    logger: {
      debug: () => {},
      info: (message) => console.log(`  [engine] ${message}`),
      warn: (message) => console.log(`  [engine] WARN ${message}`),
      error: (message) => console.log(`  [engine] ERROR ${message}`),
    },
  });

  console.log(`\n== ${report.confirm ? "已执行" : "dry-run（加 --confirm 执行）"} ==`);
  const head = ["uid".padEnd(18), "store".padEnd(8), "root L0/L1".padEnd(14)];
  if (report.confirm) head.push("copied L0/L1".padEnd(14), "relabel L0/L1".padEnd(16));
  head.push("jsonl lines");
  console.log(head.join(""));
  for (const u of report.users) {
    const cells = [u.uid.padEnd(18), (u.legacy ? "legacy" : "new").padEnd(8), `${u.rootL0}/${u.rootL1}`.padEnd(14)];
    if (report.confirm) cells.push(`${u.copiedL0}/${u.copiedL1}`.padEnd(14), `${u.relabelledL0}/${u.relabelledL1}`.padEnd(16));
    cells.push(String(report.confirm ? u.jsonlLinesCopied : u.jsonlLinesToCopy));
    console.log(cells.join(""));
    if (u.verify && !u.verify.ok) {
      console.log(`  ✗ 自检未通过：user L0/L1 = ${u.verify.userL0}/${u.verify.userL1}，其中归属本人 = ${u.verify.userL0Owned}/${u.verify.userL1Owned}，主库该人 = ${u.rootL0}/${u.rootL1}`);
    }
  }
  console.log(
    `\n主库行数：L0 ${report.rootTotalsBefore.l0} / L1 ${report.rootTotalsBefore.l1}` +
    (report.confirm ? ` → 执行后 L0 ${report.rootTotalsAfter.l0} / L1 ${report.rootTotalsAfter.l1}` : "") +
    "（主库只读打开，本脚本不写主库）",
  );
  if (!report.ok) {
    console.error("\n✗ 自检未通过（见上）。不要开启 multiUser；先核对备份与 --owners。");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ 导入失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
