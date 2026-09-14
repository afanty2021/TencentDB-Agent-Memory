/**
 * Multi-user gateway E2E — real gateway process, real HTTP.
 *
 * Unlike `multi-user.test.ts` (in-process `TdaiGateway` instances), this suite
 * boots the actual server (`node --import tsx src/gateway/server.ts`) as a
 * subprocess and drives it over HTTP, exactly like the Hermes provider does:
 *
 *   - user "a" captures 3 rounds, user "b" captures 2 rounds
 *   - `users/a/vectors.db` and `users/b/vectors.db` exist on disk
 *   - a/b `/search/conversations` results are mutually invisible
 *   - the root (main) store holds no teacher data
 *   - `user_id=wendy.li` (invalid uid) fails closed to the main store
 *   - `/seed` with a regular user id → 403, without → 200
 *   - with `TDAI_MULTI_USER` off, the same requests all land in the main store
 *
 * Environment red lines (this machine runs a production gateway):
 *   - the test gateways bind 127.0.0.1:18420 / 18421, never 8420
 *     (`startGateway` hard-refuses port 8420)
 *   - `TDAI_DATA_DIR` always points at a `fs.mkdtemp` directory under
 *     `os.tmpdir()` — never at `~/.memory-tencentdb` — and is removed after
 *     the run (`startGateway` refuses any data dir outside the tmpdir)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "gateway", "server.ts");

/** Test-only ports — deliberately far from the production gateway on 8420. */
const PORT_MULTI_USER = 18420;
const PORT_LEGACY = 18421;

const GATEWAY_STARTUP_TIMEOUT_MS = 45_000;
const CAPTURE_RECORDED_TIMEOUT_MS = 15_000;

interface CaptureResponseJson {
  l0_recorded: number;
  scheduler_notified: boolean;
}

interface ConversationSearchResponseJson {
  results: string;
  total: number;
}

interface SeedResponseJson {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}

interface GatewayHandle {
  baseUrl: string;
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
  dumpLogs: () => string;
}

const spawnedGateways: GatewayHandle[] = [];
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const gw of spawnedGateways) {
    await gw.stop().catch(() => {});
  }
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — leftover temp dirs must not fail the suite.
    }
  }
});

// ============================
// Helpers
// ============================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Boot the real gateway server as a subprocess.
 *
 * The environment passed to the child is scrubbed of every `TDAI_*` /
 * `MEMORY_TENCENTDB_*` variable first, so a developer shell (or this
 * machine's production gateway setup) cannot leak config into the test, then
 * the test's own values are injected. `TDAI_GATEWAY_CONFIG` points at an
 * empty JSON file so no machine-level `tdai-gateway.yaml` is picked up.
 */
async function startGateway(opts: { port: number; multiUser?: boolean; ownerUserIds?: string[] }): Promise<GatewayHandle> {
  const { port, multiUser = false, ownerUserIds = [] } = opts;

  // Red lines: never the production port, never outside the tmpdir.
  if (port === 8420) throw new Error("Refusing to start a test gateway on the production port 8420");
  const dataDir = makeTmpDir();
  if (!dataDir.startsWith(os.tmpdir())) throw new Error(`Refusing data dir outside tmpdir: ${dataDir}`);

  // Empty config file → fully env-driven, no host machine config leakage.
  fs.writeFileSync(path.join(dataDir, "gateway-config.json"), "{}");

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("TDAI_") || key.startsWith("MEMORY_TENCENTDB_") || key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  env.TDAI_GATEWAY_HOST = "127.0.0.1";
  env.TDAI_GATEWAY_PORT = String(port);
  env.TDAI_DATA_DIR = dataDir;
  env.TDAI_GATEWAY_CONFIG = path.join(dataDir, "gateway-config.json");
  if (multiUser) {
    env.TDAI_MULTI_USER = "true";
    if (ownerUserIds.length > 0) env.TDAI_MULTI_USER_OWNERS = ownerUserIds.join(",");
  }

  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const collect = (chunk: Buffer, sink: string[]) => {
    sink.push(chunk.toString("utf-8"));
    if (sink.length > 500) sink.shift(); // bounded — logs are diagnostics only
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdoutChunks));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderrChunks));

  const handle: GatewayHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    dumpLogs: () =>
      [`--- stdout ---`, ...stdoutChunks.slice(-40), `--- stderr ---`, ...stderrChunks.slice(-40)].join("\n"),
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        killTimer.unref?.();
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
  spawnedGateways.push(handle);

  // Wait for GET /health to answer (tsx compile + core init take a moment).
  const deadline = Date.now() + GATEWAY_STARTUP_TIMEOUT_MS;
  let lastError: unknown = new Error("gateway never became healthy");
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early (code=${child.exitCode})\n${handle.dumpLogs()}`);
    }
    try {
      const res = await fetch(`${handle.baseUrl}/health`);
      if (res.ok) return handle;
      lastError = new Error(`/health returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new Error(`gateway on :${port} not healthy after ${GATEWAY_STARTUP_TIMEOUT_MS}ms: ${lastError}\n${handle.dumpLogs()}`);
}

async function postJson<T>(base: string, pathname: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function searchConversations(
  base: string,
  query: string,
  userId?: string,
): Promise<ConversationSearchResponseJson> {
  const { status, json } = await postJson<ConversationSearchResponseJson>(base, "/search/conversations", {
    query,
    limit: 20,
    ...(userId !== undefined ? { user_id: userId } : {}),
  });
  expect(status, `/search/conversations status`).toBe(200);
  return json;
}

/**
 * POST /capture, retrying until `l0_recorded > 0`.
 *
 * The first capture of a session applies the cold-start guard
 * (`pluginStartTimestamp` = Date.now() as the cursor floor) while message
 * timestamps are assigned at extraction time inside the checkpoint lock —
 * on the rare millisecond where both land on the same value, the round is
 * legitimately filtered out (l0_recorded=0, cursor unchanged). Retrying the
 * same request is therefore safe and matches how a client would observe the
 * `{"l0_recorded":...}` contract.
 */
async function captureRound(
  base: string,
  body: { user_content: string; assistant_content: string; session_key: string; user_id?: string },
): Promise<CaptureResponseJson> {
  const deadline = Date.now() + CAPTURE_RECORDED_TIMEOUT_MS;
  let lastRecorded = 0;
  while (Date.now() < deadline) {
    const { status, json } = await postJson<CaptureResponseJson>(base, "/capture", body);
    expect(status, "/capture status").toBe(200);
    lastRecorded = json.l0_recorded;
    if (lastRecorded > 0) return json;
    await sleep(50);
  }
  throw new Error(`capture for session=${body.session_key} never recorded L0 (last l0_recorded=${lastRecorded})`);
}

function readAllJsonl(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("\n");
}

/**
 * Count `l0_conversations` rows for the given session keys, reading the
 * gateway's SQLite file directly. `node:sqlite` is unflagged from node 23.4
 * but needs `--experimental-sqlite` on the 22.x line — try plain first, then
 * flagged.
 */
async function countL0Rows(dbPath: string, sessionKeys: string[]): Promise<number> {
  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    'const db = new DatabaseSync(process.argv[1], { readOnly: true });',
    "const keys = process.argv.slice(2);",
    "const placeholders = keys.map(() => \"?\").join(\",\");",
    'const row = db.prepare(`SELECT COUNT(*) AS n FROM l0_conversations WHERE session_key IN (${placeholders})`).get(...keys);',
    "console.log(String(row.n));",
  ].join("\n");
  for (const flags of [[], ["--experimental-sqlite"]]) {
    const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [...flags, "-e", script, dbPath, ...sessionKeys], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    });
    if (result.status === 0) {
      const n = Number.parseInt(result.stdout.trim(), 10);
      expect(Number.isFinite(n), `sqlite count parsed from "${result.stdout.trim()}"`).toBe(true);
      return n;
    }
    if (!/node:sqlite|--experimental-sqlite/i.test(result.stderr)) {
      throw new Error(`sqlite count failed: ${result.stderr.trim()}`);
    }
  }
  throw new Error("could not query node:sqlite (tried plain and --experimental-sqlite)");
}

// ============================
// The e2e scenarios
// ============================

// deferred: TDAI_GATEWAY_API_KEY smoke coverage (401 on missing/wrong Bearer
// token, 200 on the correct one, /health reachable without auth) is
// intentionally NOT automated in this suite — plan §8 documents the manual
// one-off procedure. Automating it here would require a third gateway
// subprocess/port for the auth-enabled config; deferred until that cost is
// justified. Do not fake it with in-process checks.
describe("gateway multi-user e2e (real subprocess + HTTP)", () => {
  it("routes per-user captures to isolated stores, fails closed on invalid uids, and guards /seed", async () => {
    const gw = await startGateway({ port: PORT_MULTI_USER, multiUser: true, ownerUserIds: ["ops-admin"] });

    try {
      // ── user "a" captures 3 rounds, user "b" captures 2 rounds ──
      for (let round = 1; round <= 3; round++) {
        const res = await captureRound(gw.baseUrl, {
          user_id: "a",
          session_key: "sess-e2e-a-1",
          user_content: `round ${round} for user a: the depot password is magpie`,
          assistant_content: `ack round ${round} for user a`,
        });
        expect(res.l0_recorded).toBeGreaterThan(0);
      }
      for (let round = 1; round <= 2; round++) {
        const res = await captureRound(gw.baseUrl, {
          user_id: "b",
          session_key: "sess-e2e-b-1",
          user_content: `round ${round} for user b: the crane schedule is faxed at dawn`,
          assistant_content: `ack round ${round} for user b`,
        });
        expect(res.l0_recorded).toBeGreaterThan(0);
      }

      // ── owner uid and invalid uid (fail-closed) captures land in the main store ──
      const opsRes = await captureRound(gw.baseUrl, {
        user_id: "ops-admin", // listed in TDAI_MULTI_USER_OWNERS → main store
        session_key: "sess-e2e-ops-1",
        user_content: "ops round 1: the granite maintenance window is friday",
        assistant_content: "ack ops round 1",
      });
      expect(opsRes.l0_recorded).toBeGreaterThan(0);

      const wliRes = await captureRound(gw.baseUrl, {
        user_id: "wendy.li", // dot is outside ^[a-z0-9_-]{1,64}$ → main store, no stripping
        session_key: "sess-e2e-wli-1",
        user_content: "legacy round 1: the willow gate code is nine",
        assistant_content: "ack legacy round 1",
      });
      expect(wliRes.l0_recorded).toBeGreaterThan(0);

      // ── on-disk layout: users/a + users/b exist; owner/invalid never got one ──
      expect(fs.existsSync(path.join(gw.dataDir, "users", "a", "vectors.db"))).toBe(true);
      expect(fs.existsSync(path.join(gw.dataDir, "users", "b", "vectors.db"))).toBe(true);
      expect(fs.existsSync(path.join(gw.dataDir, "users", "ops-admin"))).toBe(false);
      expect(fs.existsSync(path.join(gw.dataDir, "users", "wendy.li"))).toBe(false);

      // ── /search/conversations isolation: a and b are mutually invisible ──
      const aSeesOwn = await searchConversations(gw.baseUrl, "magpie", "a");
      expect(aSeesOwn.total).toBeGreaterThan(0);
      expect(aSeesOwn.results).toContain("magpie");
      expect(aSeesOwn.results).toContain("sess-e2e-a-1");

      const aSeesB = await searchConversations(gw.baseUrl, "crane", "a");
      expect(aSeesB.total).toBe(0);
      expect(aSeesB.results).not.toContain("crane");

      const bSeesOwn = await searchConversations(gw.baseUrl, "crane", "b");
      expect(bSeesOwn.total).toBeGreaterThan(0);
      expect(bSeesOwn.results).toContain("crane");

      const bSeesA = await searchConversations(gw.baseUrl, "magpie", "b");
      expect(bSeesA.total).toBe(0);
      expect(bSeesA.results).not.toContain("magpie");

      // ── the main store holds no teacher data ──
      const mainSeesA = await searchConversations(gw.baseUrl, "magpie");
      expect(mainSeesA.total).toBe(0);
      const mainSeesB = await searchConversations(gw.baseUrl, "crane");
      expect(mainSeesB.total).toBe(0);

      const rootJsonl = readAllJsonl(path.join(gw.dataDir, "conversations"));
      expect(rootJsonl).not.toContain("sess-e2e-a-1");
      expect(rootJsonl).not.toContain("sess-e2e-b-1");
      // …but it does carry the fail-closed (owner + invalid uid) captures.
      expect(rootJsonl).toContain("sess-e2e-ops-1");
      expect(rootJsonl).toContain("sess-e2e-wli-1");

      // Same guarantee at the SQLite level: root vectors.db has zero rows for
      // the per-user (teacher) sessions, while the fail-closed captures ARE there.
      const rootVectorsDb = path.join(gw.dataDir, "vectors.db");
      expect(fs.existsSync(rootVectorsDb)).toBe(true);
      const teacherRows = await countL0Rows(rootVectorsDb, ["sess-e2e-a-1", "sess-e2e-b-1"]);
      expect(teacherRows).toBe(0);
      const failClosedRows = await countL0Rows(rootVectorsDb, ["sess-e2e-wli-1"]);
      expect(failClosedRows).toBeGreaterThan(0);

      // ── /seed: regular user → 403 with the exact guard body; main → 200 ──
      const seedPayload = {
        data: {
          sessions: [{
            sessionKey: "sess-e2e-seed-1",
            conversations: [[
              { role: "user", content: "seeded round: the cedar fence was repainted" },
              { role: "assistant", content: "ack seeded round" },
            ]],
          }],
        },
        // Keep the seed pipeline offline/deterministic: L0 only, no extraction.
        config_override: { extraction: { enabled: false } },
      };

      const forbidden = await postJson<SeedResponseJson & { error?: string }>(gw.baseUrl, "/seed", {
        ...seedPayload,
        user_id: "a",
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.json).toEqual({ error: "seed is not allowed for per-user stores" });
      // The 403 must not have seeded anything into the per-user store either.
      const seededIntoUserA = fs.readdirSync(path.join(gw.dataDir, "users", "a"))
        .filter((f) => f.startsWith("seed-"));
      expect(seededIntoUserA).toEqual([]);

      const allowed = await postJson<SeedResponseJson>(gw.baseUrl, "/seed", seedPayload);
      expect(allowed.status).toBe(200);
      expect(allowed.json.sessions_processed).toBe(1);
      expect(allowed.json.l0_recorded).toBeGreaterThan(0);
    } finally {
      await gw.stop();
    }
  });

  it("with TDAI_MULTI_USER off, the same requests all land in the main store", async () => {
    const gw = await startGateway({ port: PORT_LEGACY, multiUser: false });

    try {
      // Same capture request that created users/a/ when the switch was on…
      const res = await captureRound(gw.baseUrl, {
        user_id: "a",
        session_key: "sess-e2e-legacy-a-1",
        user_content: "legacy round 1: the quartz shipment arrives tuesday",
        assistant_content: "ack legacy round 1",
      });
      expect(res.l0_recorded).toBeGreaterThan(0);

      // …now lands in the main store, reachable with or without a user_id.
      const searchWithUser = await searchConversations(gw.baseUrl, "quartz", "a");
      expect(searchWithUser.total).toBeGreaterThan(0);
      const searchAnonymous = await searchConversations(gw.baseUrl, "quartz");
      expect(searchAnonymous.total).toBeGreaterThan(0);

      // No per-user directory is created at all.
      expect(fs.existsSync(path.join(gw.dataDir, "users"))).toBe(false);
      expect(readAllJsonl(path.join(gw.dataDir, "conversations"))).toContain("sess-e2e-legacy-a-1");

      // And /seed with a user_id is no longer refused (everything is the main pool).
      const seed = await postJson<SeedResponseJson>(gw.baseUrl, "/seed", {
        data: {
          sessions: [{
            sessionKey: "sess-e2e-legacy-seed-1",
            conversations: [[
              { role: "user", content: "legacy seeded round: the cedar crate is heavy" },
              { role: "assistant", content: "ack legacy seeded round" },
            ]],
          }],
        },
        user_id: "a",
        config_override: { extraction: { enabled: false } },
      });
      expect(seed.status).toBe(200);
      expect(seed.json.sessions_processed).toBe(1);
      expect(seed.json.l0_recorded).toBeGreaterThan(0);
    } finally {
      await gw.stop();
    }
  });
});
