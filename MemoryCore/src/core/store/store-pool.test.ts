import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import { StorePool } from "./store-pool.js";

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const dataDirs: string[] = [];

function makePool(): { pool: StorePool; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-store-pool-"));
  dataDirs.push(dataDir);
  const pool = new StorePool({
    mode: "sqlite",
    memoryCfg: parseConfig({}),
    dataDir,
    logger: SILENT,
  });
  return { pool, dataDir };
}

/** Close without the 30 s grace delay (CR-5 delayed close would otherwise hold the test process). */
async function closePool(pool: StorePool): Promise<void> {
  pool.setGraceCloseDelay(0);
  await pool.closeAll();
}

afterEach(async () => {
  while (dataDirs.length) {
    fs.rmSync(dataDirs.pop()!, { recursive: true, force: true });
  }
});

describe("StorePool sqlite paths", () => {
  it("\"default\" instance → <dataDir>/vectors.db", async () => {
    const { pool, dataDir } = makePool();
    await pool.getStore("default", null, null);
    expect(fs.existsSync(path.join(dataDir, "vectors.db"))).toBe(true);
    await closePool(pool);
  });

  it("user-scoped instance → <dataDir>/users/<uid>/vectors.db", async () => {
    const { pool, dataDir } = makePool();
    await pool.getStore("user:legacyuser", null, null);
    expect(fs.existsSync(path.join(dataDir, "users", "legacyuser", "vectors.db"))).toBe(true);
    // It is a real, initialized store: the L0 table is there.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "users", "legacyuser", "vectors.db"), { readOnly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'l0_conversations'").all() as unknown[]);
    expect(tables).toHaveLength(1);
    db.close();
    await closePool(pool);
  });

  it("two users get two files; other instances keep instances/<id>/", async () => {
    const { pool, dataDir } = makePool();
    await pool.getStore("user:a", null, null);
    await pool.getStore("user:b", null, null);
    await pool.getStore("svc-1", null, null);
    expect(fs.existsSync(path.join(dataDir, "users", "a", "vectors.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "users", "b", "vectors.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "instances", "svc-1", "vectors.db"))).toBe(true);
    await closePool(pool);
  });
});
