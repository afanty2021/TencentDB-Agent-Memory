/**
 * Import library tests on a fixture that mirrors the two data generations
 * (docs/per-user-stores-v3-design.md §1.4, §9):
 *   - a ROOT store in the current schema with rows for alice / bob / an
 *     owner / the default bucket, plus the standalone JSONL mirrors;
 *   - a Gen B-era per-user store (legacy schema: no isolation columns, FTS
 *     tables without them either) with rows that carry no user at all.
 * Fixture rows are synthetic; nothing here reads a real store.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { importPerUserStores, rootIntact, type ImportReport } from "../../scripts/lib/per-user-import.js";

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-per-user-import-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function cols(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function count(dbPath: string, sql: string, ...params: (string | number)[]): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare(sql).get(...params) as { n: number }).n);
  } finally {
    db.close();
  }
}

function jsonlLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
}

// ── fixture: root store (current schema) ──────────────────────────────

function insertL0(db: DatabaseSync, r: { id: string; session: string; user: string; text: string; at: string }): void {
  db.prepare(
    "INSERT INTO l0_conversations (record_id, session_key, session_id, role, message_text, recorded_at, timestamp, team_id, user_id, agent_id, task_id) " +
    "VALUES (?, ?, ?, 'user', ?, ?, 0, 'default', ?, 'default', '')",
  ).run(r.id, r.session, r.session, r.text, r.at, r.user);
}

function insertL1(db: DatabaseSync, r: { id: string; session: string; user: string; content: string }): void {
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, session_key, session_id, created_time, updated_time, team_id, user_id, agent_id, version) " +
    "VALUES (?, ?, 'episodic', ?, ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'default', ?, 'default', 1)",
  ).run(r.id, r.content, r.session, r.session, r.user);
}

function makeRoot(baseDir: string): void {
  const dbPath = path.join(baseDir, "vectors.db");
  const store = new VectorStore(dbPath, 0, SILENT);
  store.init();
  const db = new DatabaseSync(dbPath);
  insertL0(db, { id: "m-a1", session: "s-a", user: "alice", text: "the raven ledger is kept in the attic", at: "2026-11-01T00:00:00.000Z" });
  insertL0(db, { id: "m-a2", session: "s-a", user: "alice", text: "second round for alice", at: "2026-11-01T00:00:01.000Z" });
  insertL0(db, { id: "m-b1", session: "s-b", user: "bob", text: "the falcon manifest is filed at noon", at: "2026-11-02T00:00:00.000Z" });
  insertL0(db, { id: "m-o1", session: "s-o", user: "huangzhengbo", text: "owner only row", at: "2026-11-03T00:00:00.000Z" });
  insertL0(db, { id: "m-d1", session: "s-d", user: "default", text: "cron row", at: "2026-11-03T00:00:00.000Z" });
  insertL1(db, { id: "mem-a1", session: "s-a", user: "alice", content: "alice keeps the raven ledger" });
  db.close();
  store.rebuildFtsIndex(); // the root's FTS rows exist, as they do in a live store
  store.close();

  // Standalone JSONL mirrors — same field names as handleConversationAdd / l1-writer.
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  fs.mkdirSync(path.join(baseDir, "conversations"));
  fs.mkdirSync(path.join(baseDir, "records"));
  fs.writeFileSync(path.join(baseDir, "conversations", "2026-11-01.jsonl"),
    line({ id: "m-a1", sessionKey: "s-a", sessionId: "s-a", teamId: "default", userId: "alice", agentId: "default", role: "user", content: "(synthetic)", recordedAt: "2026-11-01T00:00:00.000Z", timestamp: 0 }) +
    line({ id: "m-a2", sessionKey: "s-a", sessionId: "s-a", teamId: "default", userId: "alice", agentId: "default", role: "user", content: "(synthetic)", recordedAt: "2026-11-01T00:00:01.000Z", timestamp: 0 }));
  fs.writeFileSync(path.join(baseDir, "conversations", "2026-11-02.jsonl"),
    line({ id: "m-b1", sessionKey: "s-b", sessionId: "s-b", teamId: "default", userId: "bob", agentId: "default", role: "user", content: "(synthetic)", recordedAt: "2026-11-02T00:00:00.000Z", timestamp: 0 }));
  fs.writeFileSync(path.join(baseDir, "conversations", "2026-11-03.jsonl"),
    line({ id: "m-o1", sessionKey: "s-o", sessionId: "s-o", teamId: "default", userId: "huangzhengbo", agentId: "default", role: "user", content: "(synthetic)", recordedAt: "2026-11-03T00:00:00.000Z", timestamp: 0 }));
  fs.writeFileSync(path.join(baseDir, "records", "2026-11-01.jsonl"),
    line({ id: "mem-a1", sessionKey: "s-a", sessionId: "s-a", teamId: "default", userId: "alice", agentId: "default", content: "(synthetic)", version: 1 }));
}

// ── fixture: Gen B-era per-user store (legacy schema) ─────────────────

/**
 * The real legacy object set, structure only (review I6): all four live
 * 2026-09 per-user stores are identical — 41 objects = these top-level
 * objects plus the fts5/vec0 shadow tables and sqlite_sequence that SQLite
 * auto-creates for the virtual tables. Captured with a read-only
 * `mode=ro&immutable=1` connection in
 * `docs/plans/2026-11-27-per-user-stores-v3.review/evidence/live-legacy-legacyuser-ddl.sql`
 * (identical across legacyuser/cedar/maple/walnut). The import flow was run
 * against this exact object set during review: in-place adoption succeeds,
 * the vec0 tables survive as dead tables, and the numbers below match.
 */
const LEGACY_DDL = `
CREATE TABLE embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
CREATE TABLE l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      );
CREATE VIRTUAL TABLE l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        );
CREATE VIRTUAL TABLE l0_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[1024] distance_metric=cosine,
          recorded_at TEXT DEFAULT ''
        );
CREATE VIRTUAL TABLE l1_fts USING fts5(
          content,
          content_original UNINDEXED,
          record_id UNINDEXED,
          type UNINDEXED,
          priority UNINDEXED,
          scene_name UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          timestamp_str UNINDEXED,
          timestamp_start UNINDEXED,
          timestamp_end UNINDEXED,
          metadata_json UNINDEXED
        );
CREATE TABLE l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      );
CREATE VIRTUAL TABLE l1_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[1024] distance_metric=cosine,
          updated_time TEXT DEFAULT ''
        );
CREATE INDEX idx_l0_recorded ON l0_conversations(recorded_at);
CREATE INDEX idx_l0_session ON l0_conversations(session_key);
CREATE INDEX idx_l0_session_id ON l0_conversations(session_id);
CREATE INDEX idx_l0_timestamp ON l0_conversations(timestamp);
CREATE INDEX idx_l1_scene ON l1_records(scene_name);
CREATE INDEX idx_l1_session_id ON l1_records(session_id);
CREATE INDEX idx_l1_session_key ON l1_records(session_key);
CREATE INDEX idx_l1_session_updated ON l1_records(session_id, updated_time);
CREATE INDEX idx_l1_sessionkey_updated ON l1_records(session_key, updated_time);
CREATE INDEX idx_l1_ts_end ON l1_records(timestamp_end);
CREATE INDEX idx_l1_ts_start ON l1_records(timestamp_start);
CREATE INDEX idx_l1_type ON l1_records(type);
`;

function makeLegacyUser(baseDir: string, uid: string): void {
  const dir = path.join(baseDir, "users", uid);
  fs.mkdirSync(dir, { recursive: true });
  // allowExtension at construction is what lets enableLoadExtension work —
  // the same flag the engine itself opens its connection with
  // (memory-store.ts: `new DbSync(dbPath, { allowExtension: true })`).
  const db = new DatabaseSync(path.join(dir, "vectors.db"), { allowExtension: true });
  // The vec0 virtual tables need the sqlite-vec extension at CREATE time —
  // the same loading path the engine itself uses (memory-store.ts loads it
  // only when dimensions > 0; this fixture loads it explicitly to BUILD the
  // tables, and the import path below then treats them as dead tables).
  const require = createRequire(import.meta.url);
  const sqliteVec = require("sqlite-vec") as { load: (db: DatabaseSync) => void };
  db.enableLoadExtension(true);
  sqliteVec.load(db);
  db.exec(LEGACY_DDL);
  db.prepare(
    "INSERT INTO l0_conversations (record_id, session_key, session_id, role, message_text, recorded_at, timestamp) " +
    "VALUES (?, ?, ?, 'user', ?, ?, 0)",
  ).run("g-1", "old-s", "old-s", "september message about listening drills", "2026-09-16T00:00:00.000Z");
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, session_key, session_id, created_time) " +
    "VALUES (?, ?, 'episodic', ?, ?, ?)",
  ).run("g-m1", "september memory about listening drills", "old-s", "old-s", "2026-09-16T00:00:00.000Z");
  db.close();
  fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
}

/** The full fixture: root store + JSONL mirrors + one legacy per-user store. */
function makeFixture(): string {
  const baseDir = tmp();
  makeRoot(baseDir);
  makeLegacyUser(baseDir, "legacyuser");
  return baseDir;
}

// ── fixture: root store holding a uid stored before normalization ─────

/**
 * Root rows whose stored `user_id` skips normalization (`Alice`): the
 * hypothetical the derivation must survive — the gateway routes the
 * normalized `alice`, so every path/key/identifier the import derives must
 * be normalized, while the root copy predicate keeps selecting exactly the
 * rows discovery found (the raw stored value). The JSONL mirror line
 * carries the normalized `userId`, as the gateway has written it since
 * routing normalization landed.
 */
function makeRootWithRawStoredUid(baseDir: string): void {
  const dbPath = path.join(baseDir, "vectors.db");
  const store = new VectorStore(dbPath, 0, SILENT);
  store.init();
  const db = new DatabaseSync(dbPath);
  insertL0(db, { id: "m-x1", session: "s-x", user: "Alice", text: "the heron ledger is kept in the attic", at: "2026-11-04T00:00:00.000Z" });
  insertL0(db, { id: "m-x2", session: "s-x", user: "Alice", text: "second round in the attic", at: "2026-11-04T00:00:01.000Z" });
  insertL1(db, { id: "mem-x1", session: "s-x", user: "Alice", content: "the heron ledger keeps itself" });
  db.close();
  store.rebuildFtsIndex();
  store.close();

  fs.mkdirSync(path.join(baseDir, "conversations"));
  fs.writeFileSync(path.join(baseDir, "conversations", "2026-11-04.jsonl"),
    `${JSON.stringify({ id: "m-x1", sessionKey: "s-x", sessionId: "s-x", teamId: "default", userId: "alice", agentId: "default", role: "user", content: "(synthetic)", recordedAt: "2026-11-04T00:00:00.000Z", timestamp: 0 })}\n`);
}

const summarize = (u: ImportReport["users"][number]) => ({
  uid: u.uid, legacy: u.legacy, rootL0: u.rootL0, rootL1: u.rootL1,
  copiedL0: u.copiedL0, copiedL1: u.copiedL1, relabelledL0: u.relabelledL0, relabelledL1: u.relabelledL1,
  jsonlLines: u.jsonlLinesCopied,
});

describe("importPerUserStores", () => {
  it("dry-run reports the plan and creates nothing", async () => {
    const baseDir = makeFixture();

    const report = await importPerUserStores({ baseDir, owners: ["huangzhengbo"] });

    expect(report.confirm).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.rootTotalsBefore).toEqual({ l0: 5, l1: 1 });
    expect(report.rootTotalsAfter).toEqual({ l0: 5, l1: 1 });
    expect(report.skippedInvalidUids).toBe(0);
    expect(report.users.map((u) => [u.uid, u.legacy, u.rootL0, u.rootL1, u.jsonlLinesToCopy])).toEqual([
      ["alice", false, 2, 1, 3],
      ["bob", false, 1, 0, 1],
      ["legacyuser", true, 0, 0, 0],
    ]);
    // nothing created for new users
    expect(fs.existsSync(path.join(baseDir, "users", "alice"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "users", "bob"))).toBe(false);
    // the legacy store is untouched (still the old schema)
    const legacy = new DatabaseSync(path.join(baseDir, "users", "legacyuser", "vectors.db"), { readOnly: true });
    expect(cols(legacy, "l0_conversations")).not.toContain("user_id");
    legacy.close();
  });

  it("confirm copies root rows into per-user stores, adopts the legacy store in place, mirrors JSONL and rebuilds FTS — the root is untouched", async () => {
    const baseDir = makeFixture();

    const report = await importPerUserStores({ baseDir, owners: ["huangzhengbo"], confirm: true });

    expect(report.confirm).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.rootTotalsBefore).toEqual({ l0: 5, l1: 1 });
    expect(report.rootTotalsAfter).toEqual({ l0: 5, l1: 1 });
    const byUid = Object.fromEntries(report.users.map((u) => [u.uid, u]));
    expect([byUid.alice.copiedL0, byUid.alice.copiedL1, byUid.alice.relabelledL0, byUid.alice.relabelledL1, byUid.alice.jsonlLinesCopied])
      .toEqual([2, 1, 0, 0, 3]);
    expect([byUid.bob.copiedL0, byUid.bob.copiedL1, byUid.bob.jsonlLinesCopied]).toEqual([1, 0, 1]);
    expect([byUid.legacyuser.legacy, byUid.legacyuser.copiedL0, byUid.legacyuser.relabelledL0, byUid.legacyuser.relabelledL1])
      .toEqual([true, 0, 1, 1]);

    // column-level: copied rows keep team default and carry the uid
    const aliceDb = path.join(baseDir, "users", "alice", "vectors.db");
    const alice = new DatabaseSync(aliceDb, { readOnly: true });
    expect(alice.prepare("SELECT DISTINCT team_id, user_id FROM l0_conversations").all()).toEqual([{ team_id: "default", user_id: "alice" }]);
    alice.close();

    // the legacy store was upgraded in place by the engine's own migration, and its rows now belong to the user
    const legacyuserDb = path.join(baseDir, "users", "legacyuser", "vectors.db");
    const legacyuser = new DatabaseSync(legacyuserDb, { readOnly: true });
    expect(cols(legacyuser, "l0_conversations")).toContain("user_id");
    expect(cols(legacyuser, "l1_records")).toContain("version");
    expect(legacyuser.prepare("SELECT user_id, COUNT(*) AS n FROM l0_conversations GROUP BY user_id").all()).toEqual([{ user_id: "legacyuser", n: 1 }]);
    expect(legacyuser.prepare("SELECT user_id, COUNT(*) AS n FROM l1_records GROUP BY user_id").all()).toEqual([{ user_id: "legacyuser", n: 1 }]);

    // Real-shape pin (review I6): the vec0 vector tables, their shadow objects
    // and embedding_meta survive in-place adoption as dead tables — the import
    // runs VectorStore(…, 0), which never loads sqlite-vec (dimensions > 0
    // gate), and init() without providerInfo never drops vector tables. The
    // live legacy stores carry the same 1024-dim vec0 tables; the live root
    // store itself is an adopted Gen B-era database that has been running for
    // a month, so this path has production precedent.
    const objects = legacyuser
      .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = objects.map((o) => o.name);
    for (const expected of [
      "l0_vec", "l1_vec", "embedding_meta",
      "l0_vec_rowids", "l0_vec_chunks", "l1_vec_rowids", "l1_vec_chunks",
      "l0_fts_data", "l1_fts_idx",
      "idx_l0_recorded", "idx_l1_type", "idx_l1_sessionkey_updated",
    ]) {
      expect(names, expected).toContain(expected);
    }
    legacyuser.close();

    // FTS: copied and relabelled rows are searchable through the engine (jieba-segmented index)
    const aliceStore = new VectorStore(aliceDb, 0, SILENT);
    aliceStore.init();
    expect(aliceStore.searchL0Fts("raven", 20, { userId: "alice" }).map((r) => r.record_id)).toEqual(["m-a1"]);
    expect(aliceStore.searchL1Fts("raven", 20, { userId: "alice" }).map((r) => r.record_id)).toEqual(["mem-a1"]);
    aliceStore.close();
    const legacyuserStore = new VectorStore(legacyuserDb, 0, SILENT);
    legacyuserStore.init();
    expect(legacyuserStore.isDegraded()).toBe(false); // the real-shape adoption never degrades
    expect(legacyuserStore.searchL0Fts("listening", 20, { userId: "legacyuser" }).map((r) => r.record_id)).toEqual(["g-1"]);
    expect(legacyuserStore.searchL1Fts("listening", 20, { userId: "legacyuser" }).map((r) => r.record_id)).toEqual(["g-m1"]);
    legacyuserStore.close();

    // JSONL mirrors: only the user's own lines, under her own directory
    expect(jsonlLines(path.join(baseDir, "users", "alice", "conversations", "2026-11-01.jsonl"))).toBe(2);
    expect(jsonlLines(path.join(baseDir, "users", "alice", "records", "2026-11-01.jsonl"))).toBe(1);
    expect(jsonlLines(path.join(baseDir, "users", "bob", "conversations", "2026-11-02.jsonl"))).toBe(1);
    expect(fs.existsSync(path.join(baseDir, "users", "alice", "conversations", "2026-11-02.jsonl"))).toBe(false);

    // owners and the default bucket stay in the root — no store is created for them
    expect(fs.existsSync(path.join(baseDir, "users", "huangzhengbo"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "users", "default"))).toBe(false);
    expect(count(path.join(baseDir, "vectors.db"), "SELECT COUNT(*) AS n FROM l0_conversations")).toBe(5);
  });

  it("is idempotent: a second confirm copies, relabels and appends nothing", async () => {
    const baseDir = makeFixture();
    await importPerUserStores({ baseDir, owners: ["huangzhengbo"], confirm: true });
    const before = jsonlLines(path.join(baseDir, "users", "alice", "conversations", "2026-11-01.jsonl"));

    const second = await importPerUserStores({ baseDir, owners: ["huangzhengbo"], confirm: true });

    expect(second.ok).toBe(true);
    expect(second.users.map(summarize)).toEqual([
      { uid: "alice", legacy: false, rootL0: 2, rootL1: 1, copiedL0: 0, copiedL1: 0, relabelledL0: 0, relabelledL1: 0, jsonlLines: 0 },
      { uid: "bob", legacy: false, rootL0: 1, rootL1: 0, copiedL0: 0, copiedL1: 0, relabelledL0: 0, relabelledL1: 0, jsonlLines: 0 },
      { uid: "legacyuser", legacy: false, rootL0: 0, rootL1: 0, copiedL0: 0, copiedL1: 0, relabelledL0: 0, relabelledL1: 0, jsonlLines: 0 },
    ]);
    expect(jsonlLines(path.join(baseDir, "users", "alice", "conversations", "2026-11-01.jsonl"))).toBe(before);
    expect(count(path.join(baseDir, "users", "alice", "vectors.db"), "SELECT COUNT(*) AS n FROM l0_conversations")).toBe(2);
  });

  it("a re-run heals a damaged user store: a row deleted from her store is copied again from the root", async () => {
    const baseDir = makeFixture();
    await importPerUserStores({ baseDir, owners: ["huangzhengbo"], confirm: true });
    const aliceDb = path.join(baseDir, "users", "alice", "vectors.db");
    const db = new DatabaseSync(aliceDb);
    db.exec("DELETE FROM l0_conversations WHERE record_id = 'm-a2'");
    db.close();

    const report = await importPerUserStores({ baseDir, owners: ["huangzhengbo"], confirm: true });

    expect(report.ok).toBe(true);
    expect(report.users.find((u) => u.uid === "alice")!.copiedL0).toBe(1);
    expect(count(aliceDb, "SELECT COUNT(*) AS n FROM l0_conversations")).toBe(2);
  });

  it("rootIntact: the root may only have grown (the gateway writes to it while the import runs), never shrunk", () => {
    expect(rootIntact({ l0: 5, l1: 1 }, { l0: 5, l1: 1 })).toBe(true);
    expect(rootIntact({ l0: 5, l1: 1 }, { l0: 6, l1: 2 })).toBe(true);
    expect(rootIntact({ l0: 5, l1: 1 }, { l0: 4, l1: 1 })).toBe(false);
    expect(rootIntact({ l0: 5, l1: 1 }, { l0: 5, l1: 0 })).toBe(false);
  });

  it("skips owner uids and candidate ids that are not valid uids", async () => {
    const baseDir = tmp();
    makeRoot(baseDir);
    // A candidate directory whose name is not a valid uid (cannot be routed to) — left alone.
    makeLegacyUser(baseDir, "bad.id");

    const report = await importPerUserStores({ baseDir, owners: ["huangzhengbo"], confirm: true });

    expect(report.skippedInvalidUids).toBe(1);
    expect(report.users.map((u) => u.uid)).toEqual(["alice", "bob"]);
    expect(fs.existsSync(path.join(baseDir, "users", "huangzhengbo"))).toBe(false);
    const untouched = new DatabaseSync(path.join(baseDir, "users", "bad.id", "vectors.db"), { readOnly: true });
    expect(cols(untouched, "l0_conversations")).not.toContain("user_id");
    untouched.close();
  });

  it("imports a raw stored uid under its normalized directory: rows copied, JSONL mirror alongside", async () => {
    const baseDir = tmp();
    makeRootWithRawStoredUid(baseDir);

    const report = await importPerUserStores({ baseDir, confirm: true });

    // the report identifies the user by the normalized uid, never the raw stored value
    expect(report.ok).toBe(true);
    expect(report.users.map((u) => u.uid)).toEqual(["alice"]);
    // the store directory carries the NORMALIZED name — asserted via the real
    // directory entries (path lookups are case-insensitive on macOS, so an
    // existsSync("users/Alice") probe would silently hit "users/alice")
    expect(fs.readdirSync(path.join(baseDir, "users"))).toEqual(["alice"]);
    expect(fs.existsSync(path.join(baseDir, "users", "alice", "vectors.db"))).toBe(true);

    // the root copy predicate still binds the RAW stored value — every row lands
    const row = report.users[0];
    expect([row.rootL0, row.copiedL0, row.copiedL1, row.relabelledL0, row.relabelledL1, row.jsonlLinesCopied])
      .toEqual([2, 2, 1, 2, 1, 1]);
    expect(row.verify?.ok).toBe(true);
    const store = new DatabaseSync(path.join(baseDir, "users", "alice", "vectors.db"), { readOnly: true });
    try {
      expect(store.prepare("SELECT DISTINCT user_id FROM l0_conversations").all()).toEqual([{ user_id: "alice" }]);
      expect(store.prepare("SELECT DISTINCT user_id FROM l1_records").all()).toEqual([{ user_id: "alice" }]);
    } finally {
      store.close();
    }

    // the JSONL mirror follows the normalized directory and carries the normalized userId
    expect(fs.readdirSync(path.join(baseDir, "users", "alice", "conversations"))).toEqual(["2026-11-04.jsonl"]);
    const mirror = path.join(baseDir, "users", "alice", "conversations", "2026-11-04.jsonl");
    const lines = fs.readFileSync(mirror, "utf-8").split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id: string; userId: string })
      .map((l) => ({ id: l.id, userId: l.userId }));
    expect(lines).toEqual([{ id: "m-x1", userId: "alice" }]);
  });
});
