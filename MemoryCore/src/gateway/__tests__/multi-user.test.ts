import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { TdaiCore } from "../../core/tdai-core.js";
import { loadGatewayConfig } from "../config.js";
import type { GatewayConfig } from "../config.js";
import { TdaiGateway } from "../server.js";
import { applyMultiUserV3Routing, type V3IsolationCtx } from "../v2-router.js";

// ============================
// Isolated test environment
// ============================
// The gateway config loader picks up `tdai-gateway.yaml` from CWD or the
// default data dir if present — both stubbed to a per-test temp dir so no
// machine-level configuration can leak into these tests.

const tmpRoots: string[] = [];
let tmpRoot = "";
let warnSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-multi-user-"));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tmpRoot = makeTmpRoot();
  // Empty config file → deterministic base config, no host machine leakage.
  fs.writeFileSync(path.join(tmpRoot, "gateway-config.json"), "{}");
  vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway-config.json"));
  vi.stubEnv("TDAI_DATA_DIR", path.join(tmpRoot, "data"));
  delete process.env.TDAI_MULTI_USER;
  delete process.env.TDAI_MULTI_USER_OWNERS;

  // Mute the gateway's console logger to keep test output pristine; the warn
  // spy stays observable so tests can assert on normalization rejections.
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Config-load WARNs go to raw stderr (no logger exists yet) — same deal.
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterAll(() => {
  for (const dir of tmpRoots) {
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

let gwCounter = 0;

/** Memory config with background extraction off — captures then only write
 *  L0, keeping the unit test free of pipeline timers and LLM calls. */
function captureOnlyMemoryConfig(): MemoryTdaiConfig {
  return parseConfig({ extraction: { enabled: false } });
}

interface TestGateway {
  gw: TdaiGateway;
  resolve: (raw: unknown) => Promise<TdaiCore>;
  baseDir: string;
}

function makeGateway(multiUser: GatewayConfig["multiUser"]): TestGateway {
  const baseDir = path.join(tmpRoot, `gw-${++gwCounter}`);
  const gw = new TdaiGateway({
    data: { baseDir },
    multiUser,
    memory: captureOnlyMemoryConfig(),
  });
  const resolve = (gw as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })._resolveCore
    .bind(gw) as (raw: unknown) => Promise<TdaiCore>;
  return { gw, resolve, baseDir };
}

function readAllJsonl(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("\n");
}

// ============================
// Config loading
// ============================

describe("multiUser config loading", () => {
  it("defaults to disabled with an empty owner list", () => {
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: false, ownerUserIds: [] });
  });

  it("reads TDAI_MULTI_USER ('true'/'1' enable; other values do not)", () => {
    vi.stubEnv("TDAI_MULTI_USER", "true");
    expect(loadGatewayConfig().multiUser.enabled).toBe(true);
    vi.stubEnv("TDAI_MULTI_USER", "1");
    expect(loadGatewayConfig().multiUser.enabled).toBe(true);
    vi.stubEnv("TDAI_MULTI_USER", "TRUE");
    expect(loadGatewayConfig().multiUser.enabled).toBe(true);
    vi.stubEnv("TDAI_MULTI_USER", "yes");
    expect(loadGatewayConfig().multiUser.enabled).toBe(false);
    vi.stubEnv("TDAI_MULTI_USER", "false");
    expect(loadGatewayConfig().multiUser.enabled).toBe(false);
  });

  it("reads TDAI_MULTI_USER_OWNERS, normalizing entries and dropping invalid ones", () => {
    vi.stubEnv("TDAI_MULTI_USER", "true");
    vi.stubEnv("TDAI_MULTI_USER_OWNERS", "HuangZhengBo, wendy.li , Wang , dup , dup");
    const cfg = loadGatewayConfig();
    expect(cfg.multiUser.enabled).toBe(true);
    expect(cfg.multiUser.ownerUserIds).toEqual(["huangzhengbo", "wang", "dup"]);
    // The dropped invalid entry is announced (operator typo visibility).
    const dropWarn = stderrSpy.mock.calls.find((call) => String(call[0]).includes("dropping invalid multiUser.ownerUserIds entry"));
    expect(dropWarn).toBeTruthy();
    expect(String(dropWarn![0])).toContain("wendy.li");
  });

  it("reads yaml multiUser.enabled / multiUser.ownerUserIds", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "gateway.yaml"),
      ["multiUser:", "  enabled: true", '  ownerUserIds: ["HuangZhengBo", "bad.id"]'].join("\n"),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway.yaml"));
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: true, ownerUserIds: ["huangzhengbo"] });
  });

  it("prefers env over yaml for enabled, and yaml over env for ownerUserIds", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "gateway.yaml"),
      ["multiUser:", "  enabled: true", "  ownerUserIds: [yamlOwner]"].join("\n"),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway.yaml"));
    vi.stubEnv("TDAI_MULTI_USER", "false");
    vi.stubEnv("TDAI_MULTI_USER_OWNERS", "envOwner");
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: false, ownerUserIds: ["yamlowner"] });
  });

  it("lets partial constructor overrides patch multiUser without dropping siblings", () => {
    const cfg = loadGatewayConfig({ multiUser: { enabled: true, ownerUserIds: ["a_b"] } });
    expect(cfg.multiUser).toEqual({ enabled: true, ownerUserIds: ["a_b"] });
    expect(cfg.data.baseDir).toBeTruthy(); // sibling fields survive the merge
  });
});

// ============================
// Gateway core routing
// ============================

describe("TdaiGateway per-user core routing", () => {
  it("routes regular users to lazily-created cores rooted at <baseDir>/users/<uid>", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      const mainCore = await resolve(undefined);
      const wendy = await resolve("Wendy");

      expect(wendy).toBeInstanceOf(TdaiCore);
      expect(wendy).not.toBe(mainCore);

      // Normalized uid variants share one core (Map dedup + promise dedup).
      expect(await resolve("wendy")).toBe(wendy);
      expect(await resolve("  WENDY  ")).toBe(wendy);

      // A second user gets her own core.
      expect(await resolve("li-hua")).not.toBe(wendy);
      expect(await resolve("li-hua")).not.toBe(mainCore);

      // Per-user data layout: <baseDir>/users/<uid>/ (initialize() creates it).
      expect(fs.existsSync(path.join(baseDir, "users", "wendy"))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, "users", "li-hua"))).toBe(true);
    } finally {
      await gw.stop();
    }
  });

  it("keeps owner / 'default' alias / invalid / missing uids on the main core", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      const mainCore = await resolve(undefined);
      expect(await resolve("huangzhengbo")).toBe(mainCore);
      expect(await resolve("HuangZhengBo")).toBe(mainCore);
      expect(await resolve("default")).toBe(mainCore);
      expect(await resolve("wendy.li")).toBe(mainCore); // fail-closed, no stripping
      expect(await resolve("../etc/passwd")).toBe(mainCore);
      expect(await resolve(42)).toBe(mainCore);
      expect(await resolve("")).toBe(mainCore);

      // None of the above may create a per-user directory.
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("warns on normalization rejection, silently for owner and 'default'", async () => {
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      await resolve("huangzhengbo");
      await resolve("default");
      expect(warnSpy).not.toHaveBeenCalled();

      await resolve("wendy.li");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Invalid or missing user_id");
    } finally {
      await gw.stop();
    }
  });

  it("routes everything to the main core when the feature is off", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: false, ownerUserIds: [] });
    try {
      const mainCore = await resolve(undefined);
      expect(await resolve("wendy")).toBe(mainCore);
      expect(await resolve("wendy.li")).toBe(mainCore);
      expect(await resolve("Wendy")).toBe(mainCore);
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("isolates per-user stores: each user's capture lands only in its own directory", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const wendy = await resolve("wendy");
      const lihua = await resolve("li-hua");

      // startedAt in the past: L0 only records messages strictly newer than
      // the per-session cursor floor (= startedAt on first capture), and
      // synthetic messages are timestamped "now" when recorded.
      const startedAt = Date.now() - 60_000;
      const turn = (sessionKey: string) => ({
        userText: `hello from ${sessionKey}`,
        assistantText: "hi there",
        messages: [
          { role: "user", content: `hello from ${sessionKey}` },
          { role: "assistant", content: "hi there" },
        ],
        sessionKey,
        startedAt,
      });

      const wendyResult = await wendy.handleTurnCommitted(turn("sess-wendy-1"));
      expect(wendyResult.l0RecordedCount).toBeGreaterThan(0);
      const lihuaResult = await lihua.handleTurnCommitted(turn("sess-lihua-1"));
      expect(lihuaResult.l0RecordedCount).toBeGreaterThan(0);

      const wendyJsonl = readAllJsonl(path.join(baseDir, "users", "wendy", "conversations"));
      const lihuaJsonl = readAllJsonl(path.join(baseDir, "users", "li-hua", "conversations"));
      expect(wendyJsonl).toContain("sess-wendy-1");
      expect(wendyJsonl).not.toContain("sess-lihua-1");
      expect(lihuaJsonl).toContain("sess-lihua-1");
      expect(lihuaJsonl).not.toContain("sess-wendy-1");

      // The main store stays free of per-user captures.
      expect(readAllJsonl(path.join(baseDir, "conversations"))).not.toContain("sess-wendy-1");
      expect(readAllJsonl(path.join(baseDir, "conversations"))).not.toContain("sess-lihua-1");
    } finally {
      await gw.stop();
    }
  });

  it("stop() destroys every live per-user core", async () => {
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: [] });
    const wendy = await resolve("wendy");
    const lihua = await resolve("li-hua");
    const wendyDestroy = vi.spyOn(wendy, "destroy");
    const lihuaDestroy = vi.spyOn(lihua, "destroy");

    await gw.stop();

    expect(wendyDestroy).toHaveBeenCalled();
    expect(lihuaDestroy).toHaveBeenCalled();
  });

  it("awaits user-core initialization: a first-request search on a cold core is not the empty-results degradation", async () => {
    // TdaiCore.searchConversations/searchMemories do not await store readiness
    // internally — they degrade to {results: [], total: 0} when the
    // vectorStore is still undefined. _resolveCore must therefore await the
    // shared initialize() promise before handing the core to handlers.
    const baseDir = path.join(tmpRoot, `gw-${++gwCounter}`);
    const make = () =>
      new TdaiGateway({
        data: { baseDir },
        multiUser: { enabled: true, ownerUserIds: [] },
        memory: captureOnlyMemoryConfig(),
      });
    const startedAt = Date.now() - 60_000;

    // Gateway 1: capture data for wendy, then stop — destroy() closes the
    // store and resets the per-dataDir store cache, so gateway 2 starts cold.
    const gw1 = make();
    const wendy1 = await (gw1 as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })
      ._resolveCore.bind(gw1)("wendy");
    const capture = await wendy1.handleTurnCommitted({
      userText: "hello from sess-wendy-cold",
      assistantText: "hi there",
      messages: [
        { role: "user", content: "hello from sess-wendy-cold" },
        { role: "assistant", content: "hi there" },
      ],
      sessionKey: "sess-wendy-cold",
      startedAt,
    });
    expect(capture.l0RecordedCount).toBeGreaterThan(0);
    await gw1.stop();

    // Gateway 2 (same baseDir, empty userCores): wendy's FIRST request is a
    // search on a cold core. Before the fix the search ran before store init
    // completed and returned the {total: 0, strategy: "none"} degradation.
    const gw2 = make();
    try {
      const wendy2 = await (gw2 as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })
        ._resolveCore.bind(gw2)("wendy");
      expect(wendy2).not.toBe(wendy1); // fresh cold core, not the warmed one
      expect(wendy2.getVectorStore()).toBeDefined(); // store ready before search

      const result = await wendy2.searchConversations({ query: "hello from sess-wendy-cold" });
      expect(result.total).toBeGreaterThan(0);
    } finally {
      await gw2.stop();
    }
  });

  it("evicts the least-recently-used core beyond 64 users: map entry gone, on-disk data kept, re-resolve works, WARN logged", async () => {
    // Plan §7.2 scenario: the LRU bound reclaims in-memory handles only —
    // `users/<uid>/` on disk is never touched, and a later request for an
    // evicted user transparently re-creates the core over the same data.
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    const userCores = (gw as unknown as { userCores: Map<string, { core: TdaiCore }> }).userCores;
    try {
      // Give the first user (the future eviction victim) a durable marker.
      const first = await resolve("u-000");
      const capture = await first.handleTurnCommitted({
        userText: "hello from sess-u-000",
        assistantText: "hi there",
        messages: [
          { role: "user", content: "hello from sess-u-000" },
          { role: "assistant", content: "hi there" },
        ],
        sessionKey: "sess-u-000",
        startedAt: Date.now() - 60_000,
      });
      expect(capture.l0RecordedCount).toBeGreaterThan(0);

      // Push past the LRU capacity: u-000 + 64 more = 65 cores created,
      // so exactly one eviction fires (u-000 is the oldest by lastAccess).
      for (let i = 1; i <= 64; i++) {
        await resolve(`u-${String(i).padStart(3, "0")}`);
      }

      // Oldest core evicted from the map, capacity respected.
      expect(userCores.has("u-000")).toBe(false);
      expect(userCores.size).toBe(64);

      // The eviction was announced with a WARN.
      const evictWarn = warnSpy.mock.calls.find((call) => String(call[0]).includes("LRU evicted"));
      expect(evictWarn).toBeTruthy();
      expect(String(evictWarn![0])).toContain("uid=u-000");

      // On-disk data (directory + captured L0 jsonl) survives eviction.
      const firstUserDir = path.join(baseDir, "users", "u-000");
      expect(fs.existsSync(firstUserDir)).toBe(true);
      expect(readAllJsonl(path.join(firstUserDir, "conversations"))).toContain("sess-u-000");

      // Re-resolve IMMEDIATELY — while the background destroy (2s timeout
      // race) may still be draining. Eviction must reset the shared
      // store-init cache synchronously BEFORE the destroy starts, so the
      // fresh core cannot inherit store handles that destroy is about to
      // close. (The old test slept 250ms here, which masked exactly this
      // rebuild-window race.)
      const again = await resolve("u-000");
      expect(again).not.toBe(first);
      expect(userCores.get("u-000")?.core).toBe(again);

      // The fresh core is usable right away: its store holds the surviving
      // data (a stale/closed store handle would make this fail or degrade).
      // Polled because the capture path defers the L0 index write to a
      // background task — visibility is eventual even over a healthy store.
      const deadline = Date.now() + 5_000;
      let search = await again.searchConversations({ query: "hello from sess-u-000" });
      while (search.total === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        search = await again.searchConversations({ query: "hello from sess-u-000" });
      }
      expect(search.total).toBeGreaterThan(0);
      expect(readAllJsonl(path.join(firstUserDir, "conversations"))).toContain("sess-u-000");
    } finally {
      await gw.stop();
    }
  }, 120_000);

  it("dedups concurrent first requests across normalization: resolving 'w' and 'W' together yields one core, one initialization", async () => {
    // Plan §7.2 scenario: two simultaneous first requests whose raw ids
    // normalize to the same uid must share a single Map entry — no second
    // TdaiCore, no second initialize() racing the first.
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: [] });
    const userCores = (gw as unknown as { userCores: Map<string, { core: TdaiCore }> }).userCores;
    try {
      const [viaW, viaCapW] = await Promise.all([resolve("w"), resolve("W")]);

      // Shared identity — both raw ids got the SAME core instance.
      expect(viaCapW).toBe(viaW);

      // Exactly one entry, keyed by the normalized uid (one initialization).
      expect(userCores.size).toBe(1);
      expect(userCores.has("w")).toBe(true);
      expect(userCores.get("w")?.core).toBe(viaW);
    } finally {
      await gw.stop();
    }
  });
});

// ============================
// v3 data-plane per-user routing (design docs/v3-user-routing-design.md §4.2)
// ============================
// Two levels of pinning:
//   1. applyMultiUserV3Routing — the pure ctx rewrite (matrix below).
//   2. handleV2Route dispatch wiring — L0 rows land team_id=user_id and the
//      read filter drops the team dim (dispatch-level suite at the bottom).
// Real-gateway v3 assertions (L2 task key profile:team:{uid}) are a P1 e2e
// item; gateway.multi-user.e2e.test.ts currently covers the v1 physical-core
// surface only.

function ctx(overrides: Partial<V3IsolationCtx> = {}): V3IsolationCtx {
  // Shape resolveIsolation produces for a plugin call: team_id="default"
  // placeholder + real user, session defaulted.
  return { teamId: "default", userId: "alice", agentId: "default", sessionId: "default", ...overrides };
}

describe("applyMultiUserV3Routing (v3 data-plane per-user ctx rewrite)", () => {
  it("subsumes userId into the team slot on write endpoints when team is the placeholder", () => {
    const r = applyMultiUserV3Routing(ctx(), "/conversation/add");
    if (!r.ok) throw new Error("expected ok");
    expect(r.ctx.teamId).toBe("alice");
    expect(r.ctx.userId).toBe("alice");
    expect(r.ctx.agentId).toBe("default");
    expect(r.ctx.subsumedTeam).toBe(true);
  });

  it("subsumes on absent team_id (plugin omission) and on profile endpoints", () => {
    const omitted = applyMultiUserV3Routing(ctx({ teamId: undefined }), "/conversation/add");
    expect(omitted.ok && omitted.ctx.teamId).toBe("alice");
    expect(omitted.ok && omitted.ctx.subsumedTeam).toBe(true);
    // profile 面（core/scenario）同 subsume —— persona 读写都落在 team:{uid}
    for (const sub of ["/core/read", "/core/write", "/scenario/ls", "/scenario/write"] as const) {
      const r = applyMultiUserV3Routing(ctx(), sub);
      expect(r.ok && r.ctx.teamId).toBe("alice");
    }
  });

  it("keeps a real (non-placeholder) team_id untouched — team semantics win", () => {
    const r = applyMultiUserV3Routing(ctx({ teamId: "real-team" }), "/conversation/add");
    expect(r.ok && r.ctx.teamId).toBe("real-team");
    expect(r.ok && r.ctx.userId).toBe("alice");
    expect(r.ok && r.ctx.subsumedTeam).toBeUndefined();
  });

  it("normalizes user_id (ASCII trim + lowercase) before subsume", () => {
    const r = applyMultiUserV3Routing(ctx({ userId: "  Alice " }), "/conversation/add");
    expect(r.ok && r.ctx.teamId).toBe("alice");
    expect(r.ok && r.ctx.userId).toBe("alice");
  });

  it("rejects invalid user_id fail-closed without echoing the value", () => {
    for (const bad of ["wendy.li", "a|team:admin", "../etc/passwd", "x".repeat(65), ""]) {
      const r = applyMultiUserV3Routing(ctx({ userId: bad }), "/conversation/add");
      expect(r.ok).toBe(false);
      // 报字段名不报值（非空非法值不得回显；空串本身就是"值缺席"）
      if (!r.ok && bad !== "") expect(r.error).not.toContain(bad);
    }
  });

  it("strips teamId on L0/L1 user-scoped endpoints (reads + id deletes) so pre/post-cutover rows match", () => {
    for (const sub of [
      "/conversation/query", "/conversation/search", "/conversation/count", "/conversation/delete",
      "/atomic/query", "/atomic/search", "/atomic/count", "/atomic/delete",
    ] as const) {
      const r = applyMultiUserV3Routing(ctx(), sub);
      expect(r.ok && r.ctx.teamId).toBeUndefined();
      expect(r.ok && r.ctx.subsumedTeam).toBeUndefined();
      expect(r.ok && r.ctx.userId).toBe("alice");
    }
  });

  it("keeps 'default' placeholder user_id behavior unchanged (fail-open compat)", () => {
    // No explicit identity: subsume maps default→default (no-op), reads keep
    // the placeholder user filter. P0 stays fail-open; the write gate is P1.
    const write = applyMultiUserV3Routing(ctx({ userId: "default" }), "/conversation/add");
    expect(write.ok && write.ctx.teamId).toBe("default");
    expect(write.ok && write.ctx.userId).toBe("default");
    const read = applyMultiUserV3Routing(ctx({ userId: "default" }), "/conversation/query");
    expect(read.ok && read.ctx.teamId).toBeUndefined();
    expect(read.ok && read.ctx.userId).toBe("default");
  });
});

// ============================
// v3 dispatch wiring — handleV2Route + multiUserEnabled
// ============================
// Pins the dispatch-level contract end to end (design §6.1-2): the hook's
// conditions, ordering and the requestIsolation pipeline, against a fake L0
// store that persists/reports the same columns the real store does. The e2e
// file covers the v1 physical-core surface only — these are the only tests
// standing guard over the /v3 multiUser routing as of P0.

import { handleV2Route } from "../v2-router.js";

interface FakeL0Row {
  record_id: string; session_id: string; session_key: string;
  team_id: string; user_id: string; agent_id: string; task_id: string;
  role: string; message_text: string; recorded_at: string;
}

/** L0 store double: insert maps write records to row columns (like TCVDB),
 *  query applies only the filter dims the real store applies (undefined = 不限). */
function fakeL0Store() {
  const rows: FakeL0Row[] = [];
  const queryFilters: Array<Record<string, unknown>> = [];
  let idSeq = 0;
  return {
    rows,
    queryFilters,
    insertL0Batch: async (recs: Array<{ id: string; sessionKey: string; sessionId: string; teamId?: string; userId?: string; agentId?: string; taskId?: string; role: string; messageText: string; recordedAt: string }>) => {
      for (const r of recs) {
        rows.push({
          record_id: r.id, session_id: r.sessionId ?? "", session_key: r.sessionKey ?? "",
          team_id: r.teamId ?? "", user_id: r.userId ?? "", agent_id: r.agentId ?? "", task_id: r.taskId ?? "",
          role: r.role, message_text: r.messageText, recorded_at: r.recordedAt,
        });
      }
      return recs.length;
    },
    queryL0Paginated: async (f: { sessionId?: string; teamId?: string; userId?: string; agentId?: string; taskId?: string; limit?: number; offset?: number }) => {
      queryFilters.push({ ...f });
      const hit = rows.filter((r) =>
        (f.sessionId === undefined || r.session_id === f.sessionId)
        && (f.teamId === undefined || r.team_id === f.teamId)
        && (f.userId === undefined || r.user_id === f.userId)
        && (f.agentId === undefined || r.agent_id === f.agentId));
      const offset = f.offset ?? 0;
      return { rows: hit.slice(offset, offset + (f.limit ?? 20)), total: hit.length };
    },
    seedLegacyRow: (row: Partial<FakeL0Row>) => {
      rows.push({
        record_id: `legacy-${++idSeq}`, session_id: "s1", session_key: "s1",
        team_id: "default", user_id: "alice", agent_id: "default", task_id: "",
        role: "user", message_text: "legacy-era message", recorded_at: new Date().toISOString(),
        ...row,
      });
    },
  };
}

interface DispatchResult {
  status: number;
  body: { code?: number; message?: string; data?: Record<string, unknown> };
  assetRegistrations: number;
}

async function dispatchV3(
  store: ReturnType<typeof fakeL0Store>,
  subpath: string,
  body: Record<string, unknown>,
  opts: { multiUser?: boolean } = {},
): Promise<DispatchResult> {
  const sent: Array<{ status: number; body: unknown }> = [];
  let assetRegistrations = 0;
  const deps = {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    // Runtime default is OFF (server.ts injects the env-backed value).
    v3StrictIsolation: false,
    ...(opts.multiUser ? { multiUserEnabled: true } : {}),
    getMetadataService: () => ({
      ensureChatMemoryAsset: async () => { assetRegistrations++; },
    }),
  } as Parameters<typeof handleV2Route>[6];
  const req = {
    url: `/v3${subpath}`,
    headers: { authorization: "Bearer test-key", "x-tdai-service-id": "test-svc" },
  } as unknown as Parameters<typeof handleV2Route>[0];
  const res = {} as unknown as Parameters<typeof handleV2Route>[1];
  const handled = await handleV2Route(
    req, res, `/v3${subpath}`, "POST",
    async () => body,
    (_res, status, payload) => { sent.push({ status, body: payload }); },
    deps,
  );
  expect(handled).toBe(true);
  const last = sent[sent.length - 1] as { status: number; body: DispatchResult["body"] };
  return { status: last.status, body: last.body, assetRegistrations };
}

const addBody = (userId = "alice") => ({
  team_id: "default",
  user_id: userId,
  agent_id: "default",
  session_id: "s1",
  messages: [{ role: "user", content: "hello from dispatch test" }],
});

describe("v3 dispatch wiring (multiUser subsume at handleV2Route level)", () => {
  it("lands L0 rows with team_id = user_id and skips chat-memory asset registration (subsume)", async () => {
    const store = fakeL0Store();
    const r = await dispatchV3(store, "/conversation/add", addBody(), { multiUser: true });
    expect(r.status).toBe(200);
    expect(store.rows).toHaveLength(1);
    // 列级断言：subsume 后写行的 team 列 = user 列（L2 键由此派生 team:{uid}）
    expect(store.rows[0].team_id).toBe("alice");
    expect(store.rows[0].user_id).toBe("alice");
    // 占位 team 的资产登记被跳过（否则每个 user 一次 team_mismatch warn）
    expect(r.assetRegistrations).toBe(0);
  });

  it("keeps upstream behavior verbatim when multiUser is off", async () => {
    const store = fakeL0Store();
    const r = await dispatchV3(store, "/conversation/add", addBody(), { multiUser: false });
    expect(r.status).toBe(200);
    expect(store.rows[0].team_id).toBe("default");
    expect(store.rows[0].user_id).toBe("alice");
    expect(r.assetRegistrations).toBe(1);
  });

  it("keeps a real team_id and registers its asset normally", async () => {
    const store = fakeL0Store();
    const r = await dispatchV3(store, "/conversation/add", { ...addBody(), team_id: "real-team" }, { multiUser: true });
    expect(r.status).toBe(200);
    expect(store.rows[0].team_id).toBe("real-team");
    expect(r.assetRegistrations).toBe(1);
  });

  it("query drops the team dim so pre- and post-cutover rows are both visible", async () => {
    const store = fakeL0Store();
    store.seedLegacyRow(); // 割接前旧行：team_id="default"
    const r = await dispatchV3(store, "/conversation/add", addBody(), { multiUser: true });
    expect(r.status).toBe(200);

    // 插件仍发 team_id="default" —— 剥离后两代行同可见
    const q = await dispatchV3(store, "/conversation/query", {
      team_id: "default", user_id: "alice", agent_id: "default", session_id: "s1",
    }, { multiUser: true });
    expect(q.status).toBe(200);
    expect(q.body.data?.total).toBe(2);
    // 滤镜级断言：team 维度不在查询条件里
    expect(store.queryFilters[store.queryFilters.length - 1].teamId).toBeUndefined();
    expect(store.queryFilters[store.queryFilters.length - 1].userId).toBe("alice");
  });

  it("rejects an invalid user_id with 400 before any write happens", async () => {
    const store = fakeL0Store();
    const r = await dispatchV3(store, "/conversation/add", addBody("wendy.li"), { multiUser: true });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("user_id");
    expect(r.body.message).not.toContain("wendy.li");
    expect(store.rows).toHaveLength(0);
    expect(r.assetRegistrations).toBe(0);
  });
});
