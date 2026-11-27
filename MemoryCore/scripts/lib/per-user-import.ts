/**
 * 按人分库导入（docs/per-user-stores-v3-design.md §9）。
 *
 * 把主库里按人存的行**复制**进各自的 `users/<uid>/vectors.db`，并把 2026-09
 * （Gen B）遗留的按人旧库原地接管：由引擎自己的初始化完成 schema 迁移，再把
 * 没有归属的旧行挂到本人名下。
 *
 * 安全约定：
 *   1. **主库只用只读连接打开**——本库对主库零写入，回滚开关时主库不缺数据。
 *   2. 默认 dry-run：不建目录、不以写方式打开任何库，只报告计划。
 *   3. `confirm: true` 才落盘；可重复执行（按 record_id / JSONL 行 id 去重）。
 *   4. 不迁场景块、画像、checkpoint；owner 的行与 default 桶留在主库。
 *
 * 每个用户：
 *   (1) 建 users/<uid>/ 及子目录
 *   (2) 引擎打开 users/<uid>/vectors.db（新建或原地迁移）
 *   (3) 从只读主库逐行复制该 uid 的 L0 / L1（INSERT OR IGNORE）
 *   (4) 改挂：库里所有行的 user_id 置为本人（按人库里所有行都属于这个人）
 *   (5) 引擎重建全文索引（引擎自己的分词）
 *   (6) 对话 / 记忆留档（JSONL）按行 userId 拆到用户目录
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Logger } from "../../src/core/types.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { DEFAULT_USER_ID, normalizeUserId } from "../../src/utils/user-id.js";
import { initDataDirectories } from "../../src/utils/pipeline-factory.js";

const SILENT_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
/** Busy timeout for writable connections: the gateway may hold the same file open. */
const BUSY_TIMEOUT_MS = 5_000;

type Table = "l0_conversations" | "l1_records";

/** Explicit column lists: never `SELECT *` (root and user schemas may gain columns). */
const COLUMNS: Record<Table, readonly string[]> = {
  l0_conversations: [
    "record_id", "session_key", "session_id", "role", "message_text", "recorded_at", "timestamp",
    "team_id", "user_id", "agent_id", "task_id",
  ],
  l1_records: [
    "record_id", "content", "type", "priority", "scene_name", "session_key", "session_id",
    "timestamp_str", "timestamp_start", "timestamp_end", "created_time", "updated_time", "metadata_json",
    "team_id", "user_id", "agent_id", "task_id", "version",
  ],
};

const JSONL_DIRS = ["conversations", "records"] as const;

export interface ImportOptions {
  /** Data directory of the gateway (`<baseDir>/vectors.db` is the root store). */
  baseDir: string;
  /** uids that keep the main store (`multiUser.ownerUserIds`). */
  owners?: string[];
  /** `false` (default) = dry-run. */
  confirm?: boolean;
  /** Progress lines. */
  log?: (line: string) => void;
  /** Engine store logger (schema-migration notices). Silent by default. */
  logger?: Logger;
}

export interface UserVerify {
  userL0: number;
  userL1: number;
  /** Rows in the user store whose `user_id` is the uid. */
  userL0Owned: number;
  userL1Owned: number;
  /** Rows of each table that the engine's full-text index holds — one per row once the rebuild is complete. */
  ftsL0: number;
  ftsL1: number;
  ok: boolean;
}

export interface UserImportReport {
  uid: string;
  /** `users/<uid>/vectors.db` existed before this run and still had the pre-isolation schema. */
  legacy: boolean;
  /** Rows the root store holds for this uid. */
  rootL0: number;
  rootL1: number;
  /** JSONL lines (both mirror dirs) the plan would append. */
  jsonlLinesToCopy: number;
  copiedL0: number;
  copiedL1: number;
  relabelledL0: number;
  relabelledL1: number;
  jsonlLinesCopied: number;
  /** Present after a confirm run. */
  verify?: UserVerify;
}

export interface ImportReport {
  confirm: boolean;
  /**
   * Every user verified (all her root rows present, every row hers, every row
   * full-text-indexed) and the root totals unchanged. Always `true` for a dry-run.
   */
  ok: boolean;
  /** Candidate ids that are not valid uids (cannot be routed to) — left untouched. */
  skippedInvalidUids: number;
  rootTotalsBefore: { l0: number; l1: number };
  rootTotalsAfter: { l0: number; l1: number };
  users: UserImportReport[];
}

// ── small sqlite / fs helpers ─────────────────────────────────────────

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function scalar(db: DatabaseSync, sql: string, ...params: string[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

function rootTotals(root: DatabaseSync): { l0: number; l1: number } {
  return {
    l0: scalar(root, "SELECT COUNT(*) AS n FROM l0_conversations"),
    l1: scalar(root, "SELECT COUNT(*) AS n FROM l1_records"),
  };
}

/** A per-user DB that predates the isolation columns (Gen B era) — the engine's init() migrates it in place. */
function isLegacyStore(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return !tableColumns(db, "l0_conversations").includes("user_id");
  } finally {
    db.close();
  }
}

/** Open with the engine (creating or migrating the schema), run `fn`, close. */
function withEngineStore<T>(dbPath: string, logger: Logger, fn: (store: VectorStore) => T): T {
  const store = new VectorStore(dbPath, 0, logger);
  try {
    store.init();
    if (store.isDegraded()) throw new Error(`engine store came up degraded: ${dbPath}`);
    return fn(store);
  } finally {
    store.close();
  }
}

function readJsonlLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim().length > 0);
}

function jsonlField(line: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(line) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

interface JsonlCopyPlan {
  sub: (typeof JSONL_DIRS)[number];
  name: string;
  /** Lines to append (not already present in the target, by line id). */
  lines: string[];
}

/**
 * Which root JSONL lines belong to `uid` and are not yet in her mirror files. Read-only.
 *
 * The mirror line's `userId` is the record's raw value — the same spelling as
 * the store row it mirrors — so the predicate compares normalized forms, like
 * the store-row discovery does.
 */
function planJsonlCopy(baseDir: string, uid: string): JsonlCopyPlan[] {
  const plan: JsonlCopyPlan[] = [];
  const userDir = path.join(baseDir, "users", uid);
  for (const sub of JSONL_DIRS) {
    const srcDir = path.join(baseDir, sub);
    if (!fs.existsSync(srcDir)) continue;
    for (const name of fs.readdirSync(srcDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const mine = readJsonlLines(path.join(srcDir, name)).filter((line) => normalizeUserId(jsonlField(line, "userId")) === uid);
      if (mine.length === 0) continue;
      const present = new Set(
        readJsonlLines(path.join(userDir, sub, name)).map((line) => jsonlField(line, "id")),
      );
      const lines = mine.filter((line) => !present.has(jsonlField(line, "id")));
      if (lines.length > 0) plan.push({ sub, name, lines });
    }
  }
  return plan;
}

/**
 * The root may only have grown while the import ran — the gateway keeps
 * writing to it (the owner's chat, anything else that still lands in the root
 * store). This script never deletes a root row, so any shrink is a defect.
 */
export function rootIntact(before: { l0: number; l1: number }, after: { l0: number; l1: number }): boolean {
  return after.l0 >= before.l0 && after.l1 >= before.l1;
}

// ── the import ────────────────────────────────────────────────────────

/**
 * The owners that take effect for a run: normalized the way the gateway
 * normalizes its routing owners (`resolveUserIdRouting`), so an entry matches
 * exactly the rows the gateway keeps in the main store. An entry that is not
 * a valid uid can never match anything — it is returned separately so the
 * caller can name it instead of dropping it silently.
 */
export function resolveOwners(raw: string[] | undefined): { owners: string[]; invalid: string[] } {
  const owners = new Set<string>();
  const invalid: string[] = [];
  for (const owner of raw ?? []) {
    const uid = normalizeUserId(owner);
    if (uid === null) invalid.push(owner);
    else owners.add(uid);
  }
  return { owners: [...owners].sort(), invalid };
}

export async function importPerUserStores(opts: ImportOptions): Promise<ImportReport> {
  const baseDir = path.resolve(opts.baseDir);
  const confirm = opts.confirm === true;
  const log = opts.log ?? (() => {});
  const logger = opts.logger ?? SILENT_LOGGER;
  const { owners: effectiveOwners, invalid: invalidOwners } = resolveOwners(opts.owners);
  const owners = new Set(effectiveOwners);
  // Say who keeps the main store before anything is read or written: an owner
  // missing from this list gets a store of her own (unreachable, but unintended).
  log(`· owners (kept in the root store): ${effectiveOwners.length > 0 ? effectiveOwners.join(", ") : "(none)"}`);
  if (invalidOwners.length > 0) {
    log(`· ignored ${invalidOwners.length} invalid --owners entry${invalidOwners.length === 1 ? "" : "ies"} (not a valid uid): ${invalidOwners.join(", ")}`);
  }

  const rootDbPath = path.join(baseDir, "vectors.db");
  if (!fs.existsSync(rootDbPath)) throw new Error(`root store not found: ${rootDbPath}`);

  // ── the ONLY connection to the root store in this file: read-only ──
  const root = new DatabaseSync(rootDbPath, { readOnly: true });
  try {
    for (const table of Object.keys(COLUMNS) as Table[]) {
      const have = tableColumns(root, table);
      const missing = COLUMNS[table].filter((c) => !have.includes(c));
      if (have.length === 0 || missing.length > 0) {
        throw new Error(`root store table ${table} lacks columns [${missing.join(", ")}] — wrong --data-dir?`);
      }
      // A column the root has and this list does not would be left behind in
      // every user store without a trace. Name it, so a schema that moved on
      // is seen in the dry-run rather than discovered later as missing data.
      const uncopied = have.filter((c) => !COLUMNS[table].includes(c));
      if (uncopied.length > 0) {
        log(`· root ${table} has column(s) the import does not copy: ${uncopied.join(", ")}`);
      }
    }
    const rootTotalsBefore = rootTotals(root);

    // ── discover users: root rows with a real uid ∪ existing per-user dirs ──
    const candidates = new Set<string>();
    for (const table of Object.keys(COLUMNS) as Table[]) {
      const rows = root.prepare(
        `SELECT DISTINCT user_id AS uid FROM ${table} WHERE user_id IS NOT NULL AND user_id NOT IN ('', 'default')`,
      ).all() as Array<{ uid: string }>;
      for (const row of rows) candidates.add(row.uid);
    }
    const usersDir = path.join(baseDir, "users");
    if (fs.existsSync(usersDir)) {
      for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(usersDir, entry.name, "vectors.db"))) {
          candidates.add(entry.name);
        }
      }
    }
    let skippedInvalidUids = 0;
    // One user = one store = one report row. Discovery saw the RAW stored
    // values while the gateway routes the NORMALIZED uid: group the candidates
    // by the uid they route to (two spellings of one uid land in one store).
    // The routing rules decide who gets a store at all — an id that is not a
    // valid uid cannot be routed to, and owners and the default bucket always
    // stay in the root, whatever spelling their rows were stored with.
    const rawCandidatesByUid = new Map<string, string[]>();
    for (const candidate of candidates) {
      const uid = normalizeUserId(candidate);
      if (uid === null) {
        skippedInvalidUids += 1;
      } else if (uid !== DEFAULT_USER_ID && !owners.has(uid)) {
        rawCandidatesByUid.set(uid, [...(rawCandidatesByUid.get(uid) ?? []), candidate]);
      }
    }
    if (skippedInvalidUids > 0) log(`· skipped ${skippedInvalidUids} candidate id(s) that are not valid uids`);

    const users: UserImportReport[] = [];
    const planned = [...rawCandidatesByUid].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [uid, rawCandidates] of planned) {
      // Every path/key/identifier below derives from the normalized uid; the
      // root copy predicate keeps binding the raw candidates, selecting exactly
      // the rows discovery found.
      const userDir = path.join(usersDir, uid);
      const userDbPath = path.join(userDir, "vectors.db");
      const existed = fs.existsSync(userDbPath);
      const rootCount = (table: Table): number => rawCandidates.reduce(
        (n, raw) => n + scalar(root, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, raw), 0);
      const report: UserImportReport = {
        uid,
        legacy: existed && isLegacyStore(userDbPath),
        rootL0: rootCount("l0_conversations"),
        rootL1: rootCount("l1_records"),
        jsonlLinesToCopy: 0,
        copiedL0: 0,
        copiedL1: 0,
        relabelledL0: 0,
        relabelledL1: 0,
        jsonlLinesCopied: 0,
      };
      const jsonlPlan = planJsonlCopy(baseDir, uid);
      report.jsonlLinesToCopy = jsonlPlan.reduce((n, item) => n + item.lines.length, 0);

      if (confirm) {
        // (1) layout
        initDataDirectories(userDir);
        // (2) engine open: create the store, or migrate a legacy one in place
        withEngineStore(userDbPath, logger, () => {});

        // (3) + (4) copy + relabel, atomically per user
        const user = new DatabaseSync(userDbPath, { timeout: BUSY_TIMEOUT_MS });
        try {
          user.exec("BEGIN");
          const copyRows = (table: Table): number => {
            const columns = COLUMNS[table];
            const insert = user.prepare(
              `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            );
            const rows = root.prepare(
              `SELECT ${columns.join(", ")} FROM ${table} WHERE user_id IN (${rawCandidates.map(() => "?").join(", ")})`,
            ).all(...rawCandidates) as Array<Record<string, unknown>>;
            let inserted = 0;
            for (const row of rows) {
              inserted += Number(insert.run(...columns.map((c) => row[c] ?? null)).changes);
            }
            return inserted;
          };
          report.copiedL0 = copyRows("l0_conversations");
          report.copiedL1 = copyRows("l1_records");
          report.relabelledL0 = Number(
            user.prepare("UPDATE l0_conversations SET user_id = ? WHERE user_id IS NOT ?").run(uid, uid).changes,
          );
          report.relabelledL1 = Number(
            user.prepare("UPDATE l1_records SET user_id = ? WHERE user_id IS NOT ?").run(uid, uid).changes,
          );
          user.exec("COMMIT");
        } catch (err) {
          try { user.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
          throw err;
        } finally {
          user.close();
        }

        // (5) FTS with the engine's own tokenizer
        withEngineStore(userDbPath, logger, (store) => { store.rebuildFtsIndex(); });

        // (6) JSONL mirrors
        for (const item of jsonlPlan) {
          fs.appendFileSync(path.join(userDir, item.sub, item.name), `${item.lines.join("\n")}\n`);
          report.jsonlLinesCopied += item.lines.length;
        }

        // self-check: everything the root holds for this uid is in her store,
        // every row is hers, and the full-text index holds every row
        const check = new DatabaseSync(userDbPath, { readOnly: true });
        try {
          const verify = {
            userL0: scalar(check, "SELECT COUNT(*) AS n FROM l0_conversations"),
            userL1: scalar(check, "SELECT COUNT(*) AS n FROM l1_records"),
            userL0Owned: scalar(check, "SELECT COUNT(*) AS n FROM l0_conversations WHERE user_id = ?", uid),
            userL1Owned: scalar(check, "SELECT COUNT(*) AS n FROM l1_records WHERE user_id = ?", uid),
            // rebuildFtsIndex() drops a row it cannot index with a WARN only:
            // an index shorter than its table means keyword recall silently
            // misses that row, so the index is counted like the rows are.
            ftsL0: scalar(check, "SELECT COUNT(*) AS n FROM l0_fts"),
            ftsL1: scalar(check, "SELECT COUNT(*) AS n FROM l1_fts"),
          };
          report.verify = {
            ...verify,
            ok: verify.userL0Owned === verify.userL0 && verify.userL1Owned === verify.userL1
              && verify.userL0Owned >= report.rootL0 && verify.userL1Owned >= report.rootL1
              && verify.ftsL0 === verify.userL0 && verify.ftsL1 === verify.userL1,
          };
        } finally {
          check.close();
        }
      }
      users.push(report);
    }

    const rootTotalsAfter = rootTotals(root);
    return {
      confirm,
      ok: rootIntact(rootTotalsBefore, rootTotalsAfter) && users.every((u) => !u.verify || u.verify.ok),
      skippedInvalidUids,
      rootTotalsBefore,
      rootTotalsAfter,
      users,
    };
  } finally {
    root.close();
  }
}
