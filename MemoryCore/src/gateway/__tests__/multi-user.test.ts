import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { TdaiCore } from "../../core/tdai-core.js";
import { assertMultiUserLayout, loadGatewayConfig } from "../config.js";
import type { GatewayConfig } from "../config.js";
import { TdaiGateway } from "../server.js";
import { handleV2Route, routeV3ByUser } from "../v2-router.js";
import { makeChatMemoryRouteTable } from "../chat-memory-handlers.js";
import { StorageAdapter } from "../../core/storage/adapter.js";
import { createL1Runner, createL2Runner, createL3Runner } from "../../utils/pipeline-factory.js";

// ── RunScope pins ──
// tdai-core hands the runner factories their options; wrapping the three
// factories lets a test capture exactly which directory/config a run used.
vi.mock("../../utils/pipeline-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/pipeline-factory.js")>();
  return {
    ...actual,
    createL1Runner: vi.fn(actual.createL1Runner),
    createL2Runner: vi.fn(actual.createL2Runner),
    createL3Runner: vi.fn(actual.createL3Runner),
  };
});

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
  delete process.env.TDAI_MULTI_USER_PROMPT_MODE;

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
    vi.stubEnv("TDAI_MULTI_USER_OWNERS", "HuangZhengBo, walnut.li , Wang , dup , dup");
    const cfg = loadGatewayConfig();
    expect(cfg.multiUser.enabled).toBe(true);
    expect(cfg.multiUser.ownerUserIds).toEqual(["huangzhengbo", "wang", "dup"]);
    // The dropped invalid entry is announced (operator typo visibility).
    const dropWarn = stderrSpy.mock.calls.find((call) => String(call[0]).includes("dropping invalid multiUser.ownerUserIds entry"));
    expect(dropWarn).toBeTruthy();
    expect(String(dropWarn![0])).toContain("walnut.li");
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

  it("leaves userPromptMode unset by default", () => {
    expect(loadGatewayConfig().multiUser).toEqual({ enabled: false, ownerUserIds: [] });
    expect("userPromptMode" in loadGatewayConfig().multiUser).toBe(false);
  });

  it("reads userPromptMode from yaml and from TDAI_MULTI_USER_PROMPT_MODE (env wins)", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "gateway.yaml"),
      ["multiUser:", "  enabled: true", "  userPromptMode: chat"].join("\n"),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", path.join(tmpRoot, "gateway.yaml"));
    expect(loadGatewayConfig().multiUser.userPromptMode).toBe("chat");

    vi.stubEnv("TDAI_MULTI_USER_PROMPT_MODE", "code");
    expect(loadGatewayConfig().multiUser.userPromptMode).toBe("code");
  });

  it("ignores an invalid userPromptMode with a stderr WARN (the global prompt family then applies)", () => {
    vi.stubEnv("TDAI_MULTI_USER_PROMPT_MODE", "teamwork");
    const cfg = loadGatewayConfig();
    expect(cfg.multiUser.userPromptMode).toBeUndefined();
    expect("userPromptMode" in cfg.multiUser).toBe(false);
    const warn = stderrSpy.mock.calls.find((call) => String(call[0]).includes("invalid multiUser.userPromptMode"));
    expect(warn).toBeTruthy();
    expect(String(warn![0])).not.toContain("teamwork");
  });
});

describe("assertMultiUserLayout", () => {
  it("accepts standalone, and service while the feature is off", () => {
    expect(() => assertMultiUserLayout("standalone", { enabled: true, ownerUserIds: [] })).not.toThrow();
    expect(() => assertMultiUserLayout("service", { enabled: false, ownerUserIds: [] })).not.toThrow();
  });

  it("refuses multiUser.enabled in service mode (per-user stores are standalone-only)", () => {
    expect(() => assertMultiUserLayout("service", { enabled: true, ownerUserIds: [] })).toThrow(/deployMode=standalone/);
  });
});

// ============================
// Gateway core routing
// ============================

describe("TdaiGateway per-user core routing", () => {
  it("per-user core capture stamps userId on the L0 JSONL mirror", async () => {
    // 写侧钉测（§4.2(c)）：isolation 注入后 capture 的 L0 落 user 列
    //（向量行列由 sqlite 归一逻辑兜底，JSONL 镜像是可断言的可见面）。
    const { gw, resolve, baseDir } = makeGateway({ enabled: true });
    try {
      const walnut = await resolve("walnut");
      await walnut.handleTurnCommitted({
        userText: "hi", assistantText: "hello",
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
        sessionKey: "s1", sessionId: "s1",
      });
      const jsonl = readAllJsonl(path.join(baseDir, "users", "walnut", "conversations"));
      expect(jsonl).toContain('"userId":"walnut"');
    } finally {
      await gw.stop();
    }
  });

  it("auto-recall reads the user's own team:{uid} scope; main core stays on the default scope", async () => {
    // §4.2(c) auto-recall 穿线（P1）：per-user core 注入 isolation 后，
    // capture 落列 team/user、L2 键 team:{uid}|agent:default、recall 的
    // profileIsolation 同 scope —— 与 v3 subsume 世界同形。主 core 不注入，
    // 保持 legacy default 桶行为。
    const { gw, resolve, baseDir } = makeGateway({ enabled: true });
    try {
      const main = await resolve(undefined);
      const walnut = await resolve("walnut");

      // 两个 scope 各放一份 persona（路径规则 = buildProfileIsolationScope + encodeURIComponent）
      const scopeDir = (scope: string, root: string) =>
        path.join(root, "profiles", encodeURIComponent(scope));
      const walnutDir = scopeDir("team:walnut|agent:default", path.join(baseDir, "users", "walnut"));
      const mainDir = scopeDir("team:default|agent:default", baseDir);
      fs.mkdirSync(walnutDir, { recursive: true });
      fs.mkdirSync(mainDir, { recursive: true });
      fs.writeFileSync(path.join(walnutDir, "persona.md"), "walnut-persona-content");
      fs.writeFileSync(path.join(mainDir, "persona.md"), "main-default-persona");

      const walnutRecall = await walnut.handleBeforeRecall("hello", "s1");
      expect(walnutRecall?.recalledL3Persona ?? "").toContain("walnut-persona-content");

      const mainRecall = await main.handleBeforeRecall("hello", "s1");
      expect(mainRecall?.recalledL3Persona ?? "").toContain("main-default-persona");
    } finally {
      await gw.stop();
    }
  });

  it("routes regular users to lazily-created cores rooted at <baseDir>/users/<uid>", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      const mainCore = await resolve(undefined);
      const walnut = await resolve("Walnut");

      expect(walnut).toBeInstanceOf(TdaiCore);
      expect(walnut).not.toBe(mainCore);

      // Normalized uid variants share one core (Map dedup + promise dedup).
      expect(await resolve("walnut")).toBe(walnut);
      expect(await resolve("  WALNUT  ")).toBe(walnut);

      // A second user gets her own core.
      expect(await resolve("li-hua")).not.toBe(walnut);
      expect(await resolve("li-hua")).not.toBe(mainCore);

      // Per-user data layout: <baseDir>/users/<uid>/ (initialize() creates it).
      expect(fs.existsSync(path.join(baseDir, "users", "walnut"))).toBe(true);
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
      expect(await resolve("walnut.li")).toBe(mainCore); // fail-closed, no stripping
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

      await resolve("walnut.li");
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
      expect(await resolve("walnut")).toBe(mainCore);
      expect(await resolve("walnut.li")).toBe(mainCore);
      expect(await resolve("Walnut")).toBe(mainCore);
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("isolates per-user stores: each user's capture lands only in its own directory", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const walnut = await resolve("walnut");
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

      const walnutResult = await walnut.handleTurnCommitted(turn("sess-walnut-1"));
      expect(walnutResult.l0RecordedCount).toBeGreaterThan(0);
      const lihuaResult = await lihua.handleTurnCommitted(turn("sess-lihua-1"));
      expect(lihuaResult.l0RecordedCount).toBeGreaterThan(0);

      const walnutJsonl = readAllJsonl(path.join(baseDir, "users", "walnut", "conversations"));
      const lihuaJsonl = readAllJsonl(path.join(baseDir, "users", "li-hua", "conversations"));
      expect(walnutJsonl).toContain("sess-walnut-1");
      expect(walnutJsonl).not.toContain("sess-lihua-1");
      expect(lihuaJsonl).toContain("sess-lihua-1");
      expect(lihuaJsonl).not.toContain("sess-walnut-1");

      // The main store stays free of per-user captures.
      expect(readAllJsonl(path.join(baseDir, "conversations"))).not.toContain("sess-walnut-1");
      expect(readAllJsonl(path.join(baseDir, "conversations"))).not.toContain("sess-lihua-1");
    } finally {
      await gw.stop();
    }
  });

  it("stop() destroys every live per-user core", async () => {
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: [] });
    const walnut = await resolve("walnut");
    const lihua = await resolve("li-hua");
    const walnutDestroy = vi.spyOn(walnut, "destroy");
    const lihuaDestroy = vi.spyOn(lihua, "destroy");

    await gw.stop();

    expect(walnutDestroy).toHaveBeenCalled();
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

    // Gateway 1: capture data for walnut, then stop — destroy() closes the
    // store and resets the per-dataDir store cache, so gateway 2 starts cold.
    const gw1 = make();
    const walnut1 = await (gw1 as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })
      ._resolveCore.bind(gw1)("walnut");
    const capture = await walnut1.handleTurnCommitted({
      userText: "hello from sess-walnut-cold",
      assistantText: "hi there",
      messages: [
        { role: "user", content: "hello from sess-walnut-cold" },
        { role: "assistant", content: "hi there" },
      ],
      sessionKey: "sess-walnut-cold",
      startedAt,
    });
    expect(capture.l0RecordedCount).toBeGreaterThan(0);
    await gw1.stop();

    // Gateway 2 (same baseDir, empty userCores): walnut's FIRST request is a
    // search on a cold core. Before the fix the search ran before store init
    // completed and returned the {total: 0, strategy: "none"} degradation.
    const gw2 = make();
    try {
      const walnut2 = await (gw2 as unknown as { _resolveCore: (raw: unknown) => Promise<TdaiCore> })
        ._resolveCore.bind(gw2)("walnut");
      expect(walnut2).not.toBe(walnut1); // fresh cold core, not the warmed one
      expect(walnut2.getVectorStore()).toBeDefined(); // store ready before search

      const result = await walnut2.searchConversations({ query: "hello from sess-walnut-cold" });
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

const ROUTING_ON = { multiUserEnabled: true, ownerUserIds: ["huangzhengbo"] };

describe("per-user store roots (v3 user-scoped instances)", () => {
  type ResolveStorage = (instanceId: string) => Promise<StorageAdapter>;
  const resolverOf = (gw: TdaiGateway): ResolveStorage =>
    (gw as unknown as { resolveFileOthersForInstance: ResolveStorage }).resolveFileOthersForInstance.bind(gw);

  it("roots a user-scoped instance's files at <baseDir>/users/<uid> and creates the data subdirs", async () => {
    const { gw, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const resolve = resolverOf(gw);

      const userStorage = await resolve("user:walnut");
      await userStorage.appendFile("conversations/2026-01-01.jsonl", '{"hello":1}\n');

      const userDir = path.join(baseDir, "users", "walnut");
      expect(fs.existsSync(path.join(userDir, "conversations", "2026-01-01.jsonl"))).toBe(true);
      for (const sub of ["records", "scene_blocks", ".metadata", ".backup"]) {
        expect(fs.existsSync(path.join(userDir, sub)), sub).toBe(true);
      }
      // The main store's mirror is untouched by the user's write.
      expect(fs.existsSync(path.join(baseDir, "conversations", "2026-01-01.jsonl"))).toBe(false);

      const mainStorage = await resolve("default");
      await mainStorage.appendFile("conversations/2026-01-01.jsonl", '{"hello":2}\n');
      expect(fs.existsSync(path.join(baseDir, "conversations", "2026-01-01.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(userDir, "conversations", "2026-01-01.jsonl"))).toBe(true);
    } finally {
      await gw.stop();
    }
  });

  it("keeps one cached adapter per instance id (a user never reuses another instance's root)", async () => {
    const { gw } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const resolve = resolverOf(gw);
      const a = await resolve("user:a");
      const b = await resolve("user:b");
      const main = await resolve("default");
      expect(a).not.toBe(b);
      expect(a).not.toBe(main);
      expect(await resolve("user:a")).toBe(a); // cached
    } finally {
      await gw.stop();
    }
  });
});

describe("run*WithStore RunScope (per-user store runs)", () => {
  it("hands the L1/L2/L3 runners scope.dataDir + scope.cfg when given, and the core's own dataDir/cfg otherwise", async () => {
    const { gw, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const core = (gw as unknown as { core: TdaiCore }).core;
      await core.initialize();
      const coreCfg = (gw as unknown as { config: GatewayConfig }).config.memory;

      type RunnerOpts = { pluginDataDir: string; cfg: MemoryTdaiConfig };
      const l1: RunnerOpts[] = [];
      const l2: RunnerOpts[] = [];
      const l3: RunnerOpts[] = [];
      const capture = (sink: RunnerOpts[], result: () => unknown) =>
        ((opts: RunnerOpts) => {
          sink.push(opts);
          return async () => result();
        }) as never;
      vi.mocked(createL1Runner).mockImplementation(capture(l1, () => ({ storedCount: 0, hasMore: false, hasFullBacklog: false, profileScopes: [] })));
      vi.mocked(createL2Runner).mockImplementation(capture(l2, () => undefined));
      vi.mocked(createL3Runner).mockImplementation(capture(l3, () => undefined));

      const store = {} as never;
      const scopedCfg: MemoryTdaiConfig = {
        ...coreCfg,
        extraction: { ...coreCfg.extraction, promptMode: "chat" },
        persona: { ...coreCfg.persona, promptMode: "chat" },
      };
      const scope = { dataDir: path.join(baseDir, "users", "walnut"), cfg: scopedCfg };

      await core.runL1WithStore("s1", store, undefined as never, undefined, undefined, scope);
      await core.runL2WithStore("s1", store, undefined, undefined, scope);
      await core.runL3WithStore(store, undefined, scope);

      expect(l1).toHaveLength(1);
      expect(l2).toHaveLength(1);
      expect(l3).toHaveLength(1);
      for (const opts of [l1[0], l2[0], l3[0]]) {
        expect(opts.pluginDataDir).toBe(scope.dataDir);
        expect(opts.cfg).toBe(scopedCfg);
      }

      // Without a scope: the core's own directory and config (unchanged behaviour).
      await core.runL1WithStore("s1", store, undefined as never);
      await core.runL2WithStore("s1", store);
      await core.runL3WithStore(store);
      expect(l1[1].pluginDataDir).toBe(baseDir);
      expect(l2[1].pluginDataDir).toBe(baseDir);
      expect(l3[1].pluginDataDir).toBe(baseDir);
      expect(l1[1].cfg).toBe(coreCfg);
    } finally {
      await gw.stop();
    }
  });
});

describe("buildTaskExecutor RunScope (user-scoped pipeline tasks)", () => {
  async function makeExecutorHarness(multiUser: GatewayConfig["multiUser"]) {
    const { gw, baseDir } = makeGateway(multiUser);
    const inner = gw as unknown as {
      core: TdaiCore;
      storePool: unknown;
      buildTaskExecutor: () => {
        executeL1: (task: unknown) => Promise<void>;
        executeL2: (task: unknown) => Promise<void>;
        executeL3: (task: unknown) => Promise<void>;
      };
    };
    await inner.core.initialize();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const ok = { storedCount: 0, creditUsed: 0, hasMore: false, hasFullBacklog: false, profileScopes: [], skipped: false };
    for (const method of ["runL1WithStore", "runL2WithStore", "runL3WithStore"] as const) {
      vi.spyOn(inner.core, method).mockImplementation((...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve(ok);
      });
    }
    // buildTaskExecutor captures this.storePool when it is built — install the double first.
    // The double must satisfy everything TdaiGateway.doStop() calls on the pool
    // (setGraceCloseDelay + closeAll, server.ts): every test below ends with
    // `finally { await gw.stop(); }`, and a getStore-only double would throw a
    // TypeError from the finally block that MASKS the real assertion failure
    // (review I1 — validated fix, review deviation D2).
    inner.storePool = {
      getStore: async () => ({ store: { fake: "store" }, embedding: undefined }),
      setGraceCloseDelay: () => {},
      closeAll: async () => {},
    };
    const executor = inner.buildTaskExecutor();
    const task = (type: "L1" | "L2" | "L3", instanceId: string) => ({
      id: `${type}-${instanceId}`, type, instanceId, sessionId: "s1", teamId: "default", agentId: "default",
      priority: 0, createdAt: Date.now(), data: { instanceId, teamId: "default", agentId: "default" },
    });
    return { gw, baseDir, executor, task, calls };
  }

  it("passes RunScope { dataDir, cfg } for user-scoped tasks and undefined for main tasks", async () => {
    const h = await makeExecutorHarness({ enabled: true, ownerUserIds: [], userPromptMode: "chat" });
    try {
      await h.executor.executeL1(h.task("L1", "user:walnut"));
      await h.executor.executeL2(h.task("L2", "user:walnut"));
      await h.executor.executeL3(h.task("L3", "user:walnut"));
      await h.executor.executeL1(h.task("L1", "default"));
      await h.executor.executeL2(h.task("L2", "default"));
      await h.executor.executeL3(h.task("L3", "default"));

      const userDir = path.join(h.baseDir, "users", "walnut");
      const expectedScope = {
        dataDir: userDir,
        cfg: expect.objectContaining({
          extraction: expect.objectContaining({ promptMode: "chat" }),
          persona: expect.objectContaining({ promptMode: "chat" }),
        }),
      };
      const methods = h.calls.map((c) => c.method);
      expect(methods).toEqual(["runL1WithStore", "runL2WithStore", "runL3WithStore", "runL1WithStore", "runL2WithStore", "runL3WithStore"]);
      // the scope is always the LAST argument
      expect(h.calls[0].args.at(-1)).toEqual(expectedScope);
      expect(h.calls[1].args.at(-1)).toEqual(expectedScope);
      expect(h.calls[2].args.at(-1)).toEqual(expectedScope);
      // main tasks: no scope
      expect(h.calls[3].args.at(-1)).toBeUndefined();
      expect(h.calls[4].args.at(-1)).toBeUndefined();
      expect(h.calls[5].args.at(-1)).toBeUndefined();
    } finally {
      await h.gw.stop();
    }
  });

  it("leaves cfg alone when multiUser.userPromptMode is unset", async () => {
    const h = await makeExecutorHarness({ enabled: true, ownerUserIds: [] });
    try {
      await h.executor.executeL1(h.task("L1", "user:walnut"));
      expect(h.calls[0].args.at(-1)).toEqual({ dataDir: path.join(h.baseDir, "users", "walnut") });
    } finally {
      await h.gw.stop();
    }
  });
});

describe("routeV3ByUser (v3 data-plane per-user store routing)", () => {
  it("routes a regular user to the user pool with a user:<uid> scope instance id", () => {
    const expected = { ok: true, pool: "user", uid: "alice", scopeInstanceId: "user:alice" };
    expect(routeV3ByUser(ROUTING_ON, "alice", "/conversation/add")).toEqual(expected);
    // Reads and profile routes route the same way: isolation is by store,
    // the isolation ctx is never rewritten.
    for (const sub of [
      "/conversation/query", "/conversation/search", "/atomic/search", "/atomic/count",
      "/core/read", "/core/write", "/scenario/ls", "/scenario/write",
    ] as const) {
      expect(routeV3ByUser(ROUTING_ON, "alice", sub), sub).toEqual(expected);
    }
  });

  it("normalizes the uid before routing", () => {
    expect(routeV3ByUser(ROUTING_ON, "  Alice ", "/conversation/add")).toEqual({
      ok: true, pool: "user", uid: "alice", scopeInstanceId: "user:alice",
    });
  });

  it("routes owners to the main pool (no scope instance id)", () => {
    for (const sub of ["/conversation/add", "/core/read"] as const) {
      expect(routeV3ByUser(ROUTING_ON, "HuangZhengBo", sub)).toEqual({ ok: true, pool: "main", uid: "huangzhengbo" });
    }
  });

  it("routes the 'default' identity to main for reads and rejects it on every write route", () => {
    for (const sub of [
      "/conversation/query", "/conversation/search", "/atomic/search",
      "/core/read", "/core/count", "/scenario/ls", "/scenario/read", "/scenario/count",
    ] as const) {
      expect(routeV3ByUser(ROUTING_ON, "default", sub), sub).toEqual({ ok: true, pool: "main", uid: "default" });
    }
    for (const sub of [
      "/conversation/add", "/conversation/delete",
      "/atomic/update", "/atomic/delete",
      "/scenario/write", "/scenario/rm", "/core/write",
    ] as const) {
      const r = routeV3ByUser(ROUTING_ON, "default", sub);
      expect(r.ok, sub).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("user_id");
        expect(r.error).toContain("multiUser.enabled");
      }
    }
  });

  it("rejects an invalid user_id fail-closed on every route, without echoing the value", () => {
    for (const bad of ["walnut.li", "a|team:admin", "../etc/passwd", "x".repeat(65), "", 42, null, undefined]) {
      for (const sub of ["/conversation/add", "/core/read"] as const) {
        const r = routeV3ByUser(ROUTING_ON, bad, sub);
        expect(r.ok).toBe(false);
        if (!r.ok && typeof bad === "string" && bad !== "") expect(r.error).not.toContain(bad);
      }
    }
  });

  it("routes everything to main when the feature is off — no normalization gate, no write gate", () => {
    const off = { multiUserEnabled: false, ownerUserIds: [] as string[] };
    expect(routeV3ByUser(off, "alice", "/conversation/add")).toEqual({ ok: true, pool: "main", uid: "alice" });
    expect(routeV3ByUser(off, "default", "/conversation/add")).toEqual({ ok: true, pool: "main", uid: "default" });
    expect(routeV3ByUser(off, "walnut.li", "/conversation/add")).toEqual({ ok: true, pool: "main", uid: "" });
  });
});

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

// ============================
// v3 dispatch wiring — handleV2Route + multiUserEnabled (per-user stores)
// ============================
// Pins the dispatch-level contract end to end (design §4, §6.2) against
// per-instance resource doubles: one fake L0 store per instance id, so a test
// can tell WHICH store a request was routed to.

type NotifyCall = [instanceId: string, sessionId: string, rounds: number, teamId: string | undefined, agentId: string | undefined];

interface DispatchOutcome {
  status: number;
  body: { code?: number; message?: string; data?: Record<string, unknown> };
}

/**
 * A `dispatch` bound to shared doubles.
 *   - `main`            the fake store behind the request's own service id ("test-svc")
 *   - `storeFor(id)`    the fake store behind instance id `id` (created on first use)
 *   - `state`           every store/storage resolution, pipeline notify and metadata lookup
 * `withResolvers: false` models a wiring without per-instance resolvers.
 */
function makeV3Harness(opts: { withResolvers: boolean } = { withResolvers: true }) {
  const main = fakeL0Store();
  const userStores = new Map<string, ReturnType<typeof fakeL0Store>>();
  const storeFor = (instanceId: string): ReturnType<typeof fakeL0Store> => {
    if (instanceId === "test-svc") return main;
    let store = userStores.get(instanceId);
    if (!store) {
      store = fakeL0Store();
      userStores.set(instanceId, store);
    }
    return store;
  };
  const state = {
    resolvedInstanceIds: [] as string[],
    notifications: [] as NotifyCall[],
    assetRegistrations: 0,
    metadataInstanceIds: [] as string[],
  };
  const dispatch = async (
    subpath: string,
    body: Record<string, unknown>,
    o: { multiUser?: boolean; owners?: string[]; serviceId?: string } = {},
  ): Promise<DispatchOutcome> => {
    const sent: Array<{ status: number; body: DispatchOutcome["body"] }> = [];
    const deps = {
      getStore: () => main,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      // Runtime default is OFF (server.ts injects the env-backed value).
      v3StrictIsolation: false,
      ...(o.multiUser ? { multiUserEnabled: true, multiUserOwnerUserIds: o.owners ?? [] } : {}),
      ...(opts.withResolvers
        ? {
            resolveStore: async (instanceId: string) => {
              state.resolvedInstanceIds.push(instanceId);
              return { store: storeFor(instanceId), embedding: undefined };
            },
            resolveStorage: async (instanceId: string) => {
              state.resolvedInstanceIds.push(instanceId);
              return { instanceId } as never;
            },
          }
        : {}),
      notifyPipeline: async (instanceId: string, sessionId: string, rounds: number, teamId?: string, agentId?: string) => {
        state.notifications.push([instanceId, sessionId, rounds, teamId, agentId]);
      },
      getMetadataService: (instanceId: string) => {
        state.metadataInstanceIds.push(instanceId);
        return Promise.resolve({
          ensureChatMemoryAsset: async () => { state.assetRegistrations += 1; },
        });
      },
    } as Parameters<typeof handleV2Route>[6];
    const req = {
      url: `/v3${subpath}`,
      headers: { authorization: "Bearer test-key", "x-tdai-service-id": o.serviceId ?? "test-svc" },
    } as unknown as Parameters<typeof handleV2Route>[0];
    const res = {} as unknown as Parameters<typeof handleV2Route>[1];
    const handled = await handleV2Route(
      req, res, `/v3${subpath}`, "POST",
      async () => body,
      (_res, status, payload) => { sent.push({ status, body: payload as DispatchOutcome["body"] }); },
      deps,
    );
    expect(handled).toBe(true);
    const last = sent[sent.length - 1];
    return { status: last.status, body: last.body };
  };
  return { main, userStores, storeFor, state, dispatch };
}

const addBody = (userId = "alice") => ({
  team_id: "default",
  user_id: userId,
  agent_id: "default",
  session_id: "s1",
  messages: [{ role: "user", content: "hello from dispatch test" }],
});

describe("v3 dispatch wiring (multiUser per-user stores at handleV2Route level)", () => {
  it("routes a regular user's write to the user:<uid> store — team_id stays 'default', user_id is normalized", async () => {
    const h = makeV3Harness();
    const r = await h.dispatch("/conversation/add", addBody("  Alice "), { multiUser: true });
    expect(r.status).toBe(200);
    // store, then storage — both resolved for the user-scoped instance id
    expect(h.state.resolvedInstanceIds).toEqual(["user:alice", "user:alice"]);
    const rows = h.storeFor("user:alice").rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBe("default");
    expect(rows[0].user_id).toBe("alice");
    expect(h.main.rows).toHaveLength(0); // the main store never saw it
  });

  it("notifies the pipeline with the user-scoped instance id", async () => {
    const h = makeV3Harness();
    await h.dispatch("/conversation/add", addBody("alice"), { multiUser: true });
    expect(h.state.notifications).toEqual([["user:alice", "s1", 1, "default", "default"]]);
  });

  it("keeps team semantics for side effects: the chat-memory asset is registered on the real service id", async () => {
    const h = makeV3Harness();
    const r = await h.dispatch("/conversation/add", addBody("alice"), { multiUser: true });
    expect(r.status).toBe(200);
    expect(h.state.assetRegistrations).toBe(1);
    expect(h.state.metadataInstanceIds).toEqual(["test-svc"]);
  });

  it("routes a regular user's reads to her own store — her pre-cutover rows in the main store do not leak in", async () => {
    const h = makeV3Harness();
    // Pre-cutover row: alice's, but in the main store (feature off).
    await h.dispatch("/conversation/add", addBody("alice"), { multiUser: false });
    expect(h.main.rows).toHaveLength(1);
    // Post-cutover row: alice's, in her own store.
    await h.dispatch("/conversation/add", addBody("alice"), { multiUser: true });
    expect(h.storeFor("user:alice").rows).toHaveLength(1);

    const q = await h.dispatch("/conversation/query",
      { team_id: "default", user_id: "alice", agent_id: "default", session_id: "s1" }, { multiUser: true });
    expect(q.status).toBe(200);
    expect(h.state.resolvedInstanceIds.slice(-2)).toEqual(["user:alice", "user:alice"]);
    expect(q.body.data?.total).toBe(1); // only her own store's row
    // The isolation ctx is passed through untouched (no team stripping).
    expect(h.storeFor("user:alice").queryFilters.at(-1)).toMatchObject({ teamId: "default", userId: "alice", agentId: "default" });
  });

  it("keeps owners on the main store (identity not rewritten)", async () => {
    const h = makeV3Harness();
    const r = await h.dispatch("/conversation/add", addBody("HuangZhengBo"), { multiUser: true, owners: ["huangzhengbo"] });
    expect(r.status).toBe(200);
    expect(h.state.resolvedInstanceIds).toEqual(["test-svc", "test-svc"]);
    expect(h.main.rows).toHaveLength(1);
    expect(h.main.rows[0].user_id).toBe("HuangZhengBo");
    expect(h.state.notifications).toEqual([["test-svc", "s1", 1, "default", "default"]]);
    expect(h.userStores.size).toBe(0);
  });

  it("default identity: reads stay on the main store, writes are rejected before any store is touched", async () => {
    const h = makeV3Harness();
    const absent = await h.dispatch("/conversation/add", {
      team_id: "default", agent_id: "default", session_id: "s1",
      messages: [{ role: "user", content: "identity-less write" }],
    }, { multiUser: true });
    expect(absent.status).toBe(400);
    expect(absent.body.message).toContain("user_id");
    expect(absent.body.message).toContain("multiUser.enabled");
    expect(h.state.resolvedInstanceIds).toEqual([]);
    expect(h.main.rows).toHaveLength(0);

    // A1 (2026-11-27): delete 路由同属写门禁——default 身份也不能删共享桶的行。
    // 闸在选库之前生效，所以断言「没有解析任何 store」即可证明主库未被触碰。
    const del = await h.dispatch("/conversation/delete",
      { team_id: "default", agent_id: "default", session_id: "s1", record_id: "m-x" }, { multiUser: true });
    expect(del.status).toBe(400);
    expect(h.state.resolvedInstanceIds).toEqual([]);
    expect(h.main.rows).toHaveLength(0);

    const read = await h.dispatch("/conversation/query",
      { team_id: "default", agent_id: "default", session_id: "s1" }, { multiUser: true });
    expect(read.status).toBe(200);
    expect(h.state.resolvedInstanceIds).toEqual(["test-svc", "test-svc"]);
  });

  it("rejects an invalid user_id with 400 before any store is resolved, without echoing the value", async () => {
    const h = makeV3Harness();
    const r = await h.dispatch("/conversation/add", addBody("walnut.li"), { multiUser: true });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("user_id");
    expect(r.body.message).not.toContain("walnut.li");
    expect(h.state.resolvedInstanceIds).toEqual([]);
  });

  it("fails closed with 503 when a user-pool request has no per-instance resolvers", async () => {
    const h = makeV3Harness({ withResolvers: false });
    const r = await h.dispatch("/conversation/add", addBody("alice"), { multiUser: true });
    expect(r.status).toBe(503);
    expect(h.main.rows).toHaveLength(0); // never silently falls back to the main store
  });

  it("keeps upstream behavior verbatim when multiUser is off", async () => {
    const h = makeV3Harness();
    const r = await h.dispatch("/conversation/add", addBody("alice"), { multiUser: false });
    expect(r.status).toBe(200);
    expect(h.state.resolvedInstanceIds).toEqual(["test-svc", "test-svc"]);
    expect(h.main.rows[0].team_id).toBe("default");
    expect(h.main.rows[0].user_id).toBe("alice");
    expect(h.state.assetRegistrations).toBe(1);
    // default-identity writes are NOT gated when the feature is off
    const anon = await h.dispatch("/conversation/add", {
      team_id: "default", agent_id: "default", session_id: "s2",
      messages: [{ role: "user", content: "anonymous write" }],
    }, { multiUser: false });
    expect(anon.status).toBe(200);
  });

  it("rejects a client-supplied reserved-prefix service id before touching any store — with the feature on or off", async () => {
    for (const multiUser of [true, false]) {
      const h = makeV3Harness();
      const r = await h.dispatch("/conversation/search",
        { team_id: "default", agent_id: "default", user_id: "alice", query: "hello", limit: 5 },
        { multiUser, serviceId: "user:b" });
      expect(r.status, `multiUser=${multiUser}`).toBe(400);
      expect(h.state.resolvedInstanceIds).toEqual([]);
    }
  });

  it("does not route management-plane (extra) routes by user", async () => {
    const h = makeV3Harness();
    const deps = {
      getStore: () => h.main,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      multiUserEnabled: true,
      multiUserOwnerUserIds: [],
      resolveStore: async (instanceId: string) => {
        h.state.resolvedInstanceIds.push(instanceId);
        return { store: h.storeFor(instanceId), embedding: undefined };
      },
      resolveStorage: async (instanceId: string) => {
        h.state.resolvedInstanceIds.push(instanceId);
        return { instanceId } as never;
      },
    } as Parameters<typeof handleV2Route>[6];
    const req = {
      url: "/v3/skill/ping",
      headers: { authorization: "Bearer test-key", "x-tdai-service-id": "test-svc" },
    } as unknown as Parameters<typeof handleV2Route>[0];
    const handled = await handleV2Route(
      req, {} as never, "/v3/skill/ping", "POST",
      async () => ({ user_id: "alice", team_id: "default", agent_id: "default", session_id: "s1" }),
      () => {},
      deps,
      {
        "/v3/skill/ping": async (_body, _auth, requestId) => ({ code: 0, message: "ok", request_id: requestId }),
      },
    );
    expect(handled).toBe(true);
    // Resolved for the request's own service id — "alice" in the body changes nothing here.
    expect(h.state.resolvedInstanceIds).toEqual(["test-svc", "test-svc"]);
  });
});

// ============================
// /v3/chat-memory/clear user-scope mode (P1 per-user clear chain, §4.2(c))
// ============================
// Dispatch-level pins for the user_ids addressing mode: both-generation store
// call shapes (own scope wipes profiles, legacy sweep never does), profile
// file deletion scoped to the user's own prefix, gating on multiUser.enabled,
// and the fail-closed 400 contract. The asset mode (memory_ids) is pinned for
// regressions only — its full behavior is upstream's.

interface ClearCall { teamId: string; agentId: string; userId?: string; wipeProfiles?: boolean }

function fakeClearStore() {
  const clearCalls: ClearCall[] = [];
  const audits: Array<{ record_id: string; layer: string; team_id: string }> = [];
  return {
    clearCalls,
    audits,
    clearMemoryContent: async (filter: ClearCall) => {
      clearCalls.push({ ...filter });
      // Real stores: profilesDeleted only on the profile-wiping call.
      return { l0Deleted: 1, l1Deleted: 2, profilesDeleted: filter.wipeProfiles === false ? 0 : 3 };
    },
    appendAudit: async (entry: { record_id: string; layer: string; team_id: string }) => {
      audits.push({ record_id: entry.record_id, layer: entry.layer, team_id: entry.team_id });
    },
  };
}

/** Minimal local-style backend: lists 2 objects under any prefix, records deletions. */
function fakeProfileStorage() {
  const deletedPrefixes: string[] = [];
  const backend = {
    type: "local" as const,
    listObjects: async (prefix: string) => ({
      entries: [
        { key: `${prefix}persona.md`, isDirectory: false },
        { key: `${prefix}scene_blocks/a.md`, isDirectory: false },
      ],
    }),
    deleteByPrefix: async (prefix: string) => {
      deletedPrefixes.push(prefix);
      return 2;
    },
  };
  return { storage: new StorageAdapter(backend as never), deletedPrefixes };
}

async function dispatchChatMemoryClear(
  body: unknown,
  opts: {
    multiUser?: boolean;
    store?: ReturnType<typeof fakeClearStore>;
    storage?: ReturnType<typeof fakeProfileStorage>;
    resolveTargets?: Array<{ asset_id: string; team_id: string; agent_id: string }>;
  } = {},
): Promise<{ status: number; body: { code?: number; message?: string; data?: Record<string, unknown> } }> {
  const sent: Array<{ status: number; body: unknown }> = [];
  const deps = {
    getStore: () => opts.store ?? fakeClearStore(),
    getEmbedding: () => undefined,
    getStorage: () => (opts.storage ?? fakeProfileStorage()).storage,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    ...(opts.multiUser ? { multiUserEnabled: true } : {}),
    getMetadataService: async () => ({
      resolveChatMemoryTargets: async () => opts.resolveTargets ?? [],
    }),
  } as Parameters<typeof handleV2Route>[6];
  const req = {
    url: "/v3/chat-memory/clear",
    headers: { authorization: "Bearer test-key", "x-tdai-service-id": "test-svc" },
  } as unknown as Parameters<typeof handleV2Route>[0];
  const res = {} as unknown as Parameters<typeof handleV2Route>[1];
  const handled = await handleV2Route(
    req, res, "/v3/chat-memory/clear", "POST",
    async () => body,
    (_res, status, payload) => { sent.push({ status, body: payload }); },
    deps,
    makeChatMemoryRouteTable() as never,
  );
  expect(handled).toBe(true);
  const last = sent[sent.length - 1] as { status: number; body: { code?: number; message?: string; data?: Record<string, unknown> } };
  return { status: last.status, body: last.body };
}

describe("/v3/chat-memory/clear user-scope mode (multiUser)", () => {
  it("clears both generations: own scope wipes profiles, legacy sweep never does", async () => {
    const store = fakeClearStore();
    const ps = fakeProfileStorage();
    const r = await dispatchChatMemoryClear(
      { user_ids: ["alice"] },
      { multiUser: true, store, storage: ps },
    );
    expect(r.status).toBe(200);
    // 两代调用形状（顺序：先自有 scope，后共享时代扫尾）
    expect(store.clearCalls).toEqual([
      { teamId: "alice", agentId: "default", userId: "alice", wipeProfiles: true },
      { teamId: "default", agentId: "default", userId: "alice", wipeProfiles: false },
    ]);
    // profile 文件只删 user 自己的 scope 前缀（共享 persona 不动）
    const scopePrefix = `profiles/${encodeURIComponent("team:alice|agent:default")}/`;
    expect(ps.deletedPrefixes).toEqual([scopePrefix]);
    // 计数合并：l0=1+1, l1=2+2, profiles=3(行)+2(文件)+0(扫尾跳过)
    const items = (r.body.data?.items as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0].memory_id).toBe("chat_memory-alice-default");
    expect(items[0].cleared).toBe(true);
    expect(items[0].l0_deleted).toBe(2);
    expect(items[0].l1_deleted).toBe(4);
    expect(items[0].profile_deleted).toBe(5);
    expect(r.body.data?.all_cleared).toBe(true);
    // 审计与真实资产 id 同形，L1/L2/L3 各一条
    expect(store.audits.map((a) => a.layer).sort()).toEqual(["L1", "L2", "L3"]);
    expect(store.audits.every((a) => a.record_id === "chat_memory-alice-default")).toBe(true);
  });

  it("collapses to a single full wipe for the anonymous/default user", async () => {
    const store = fakeClearStore();
    const ps = fakeProfileStorage();
    const r = await dispatchChatMemoryClear(
      { user_ids: ["default"] },
      { multiUser: true, store, storage: ps },
    );
    expect(r.status).toBe(200);
    expect(store.clearCalls).toEqual([
      { teamId: "default", agentId: "default", userId: "default", wipeProfiles: true },
    ]);
    expect(ps.deletedPrefixes).toEqual([`profiles/${encodeURIComponent("team:default|agent:default")}/`]);
  });

  it("normalizes, dedupes and trims user_ids; honors a custom agent_id", async () => {
    const store = fakeClearStore();
    const r = await dispatchChatMemoryClear(
      { user_ids: ["  Alice ", "alice", "bob"], agent_id: " bot-1 " },
      { multiUser: true, store },
    );
    expect(r.status).toBe(200);
    const items = (r.body.data?.items as Array<Record<string, unknown>>);
    expect(items.map((i) => i.memory_id)).toEqual([
      "chat_memory-alice-bot-1",
      "chat_memory-bob-bot-1",
    ]);
    // alice 的两代 + bob 的两代
    expect(store.clearCalls).toHaveLength(4);
    expect(store.clearCalls[0]).toEqual({ teamId: "alice", agentId: "bot-1", userId: "alice", wipeProfiles: true });
  });

  it("terminal mid-sweep failure: cleared:false, zero counts, no audit (fail-loud)", async () => {
    // 自有 scope 成功、共享时代扫尾永远失败：钉住部分失败语义（§4.2(c)）
    // —— 重试包住整个两代 op，终败报全零计数且不发审计。
    const clearCalls: ClearCall[] = [];
    const audits: Array<{ record_id: string; layer: string; team_id: string }> = [];
    const store = {
      clearCalls,
      audits,
      clearMemoryContent: async (filter: ClearCall) => {
        clearCalls.push({ ...filter });
        if (filter.wipeProfiles === false) throw new Error("tcvdb: connection lost");
        return { l0Deleted: 1, l1Deleted: 2, profilesDeleted: 3 };
      },
      appendAudit: async (entry: { record_id: string; layer: string; team_id: string }) => {
        audits.push({ ...entry });
      },
    };
    const ps = fakeProfileStorage();
    const r = await dispatchChatMemoryClear(
      { user_ids: ["alice"] },
      { multiUser: true, store, storage: ps },
    );
    // 整体 envelope 仍 200：失败落在 per-item（all_cleared=false）
    expect(r.status).toBe(200);
    const items = (r.body.data?.items as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      memory_id: "chat_memory-alice-default",
      cleared: false,
      l0_deleted: 0,
      l1_deleted: 0,
      profile_deleted: 0,
      retryable: true,
      attempts: 3,
    });
    expect(String(items[0].reason)).toContain("retry");
    expect(r.body.data?.all_cleared).toBe(false);
    // 审计零落（audit 仅成功后记）
    expect(audits).toHaveLength(0);
    // 重试包整个两代：3 轮 × 2 代 = 6 次调用，own-era 形状 ×3 + 扫尾形状 ×3
    expect(clearCalls).toHaveLength(6);
    expect(clearCalls.filter((c) => c.wipeProfiles === true)).toHaveLength(3);
    expect(clearCalls.filter((c) => c.wipeProfiles === false)).toHaveLength(3);
    // 已删数据不回滚（文档化的低估代价）：own era 的 profile 前缀已删过 3 轮
    expect(ps.deletedPrefixes).toHaveLength(3);
  });

  it("non-retryable failure: single attempt, no audit, cleared:false", async () => {
    const clearCalls: ClearCall[] = [];
    const audits: Array<{ record_id: string; layer: string; team_id: string }> = [];
    const store = {
      clearCalls,
      audits,
      clearMemoryContent: async (filter: ClearCall) => {
        clearCalls.push({ ...filter });
        throw new Error("clearChatMemoryContentForUser requires non-empty userId and agentId");
      },
      appendAudit: async (entry: { record_id: string; layer: string; team_id: string }) => {
        audits.push({ ...entry });
      },
    };
    const r = await dispatchChatMemoryClear(
      { user_ids: ["alice"] },
      { multiUser: true, store },
    );
    expect(r.status).toBe(200);
    const items = (r.body.data?.items as Array<Record<string, unknown>>);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      memory_id: "chat_memory-alice-default",
      cleared: false,
      l0_deleted: 0,
      l1_deleted: 0,
      profile_deleted: 0,
      retryable: false,
      attempts: 1,
    });
    expect(String(items[0].reason)).toContain("rejected");
    expect(audits).toHaveLength(0);
    expect(clearCalls).toHaveLength(1); // 非重试错误：一次即终态
  });

  it("rejects user_ids mode with 400 when multiUser is off (asset mode unaffected)", async () => {
    const r = await dispatchChatMemoryClear({ user_ids: ["alice"] }, { multiUser: false });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("multiUser.enabled");

    // 资产模式不受 multiUser 影响，仍走 metadata 解析
    const store = fakeClearStore();
    const a = await dispatchChatMemoryClear(
      { memory_ids: ["chat_memory-real-team-a1"] },
      {
        multiUser: true,
        store,
        resolveTargets: [{ asset_id: "chat_memory-real-team-a1", team_id: "real-team", agent_id: "a1" }],
      },
    );
    expect(a.status).toBe(200);
    expect(store.clearCalls).toEqual([{ teamId: "real-team", agentId: "a1" }]);
  });

  it("rejects invalid user_id fail-closed without echoing the value", async () => {
    const store = fakeClearStore();
    const r = await dispatchChatMemoryClear(
      { user_ids: ["alice", "walnut.li"] },
      { multiUser: true, store },
    );
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("user_id");
    expect(r.body.message).not.toContain("walnut.li");
    expect(store.clearCalls).toHaveLength(0); // 整批拒绝，一条不清
  });

  it("rejects ambiguous addressing: both modes, or neither", async () => {
    const both = await dispatchChatMemoryClear(
      { memory_ids: ["x"], user_ids: ["alice"] },
      { multiUser: true },
    );
    expect(both.status).toBe(400);
    expect(both.body.message).toContain("not both");

    const neither = await dispatchChatMemoryClear({}, { multiUser: true });
    expect(neither.status).toBe(400);
    expect(neither.body.message).toContain("missing");
  });
});
