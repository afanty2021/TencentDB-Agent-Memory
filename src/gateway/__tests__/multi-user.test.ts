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

// ============================
// Isolated test environment
// ============================
// The gateway config loader picks up `tdai-gateway.yaml` from CWD or the
// default data dir if present — both stubbed to a per-test temp dir so no
// machine-level configuration can leak into these tests.

const tmpRoots: string[] = [];
let tmpRoot = "";
let warnSpy: ReturnType<typeof vi.spyOn>;

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
  resolve: (raw: unknown) => TdaiCore;
  baseDir: string;
}

function makeGateway(multiUser: GatewayConfig["multiUser"]): TestGateway {
  const baseDir = path.join(tmpRoot, `gw-${++gwCounter}`);
  const gw = new TdaiGateway({
    data: { baseDir },
    multiUser,
    memory: captureOnlyMemoryConfig(),
  });
  const resolve = (gw as unknown as { _resolveCore: (raw: unknown) => TdaiCore })._resolveCore
    .bind(gw) as (raw: unknown) => TdaiCore;
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
      const mainCore = resolve(undefined);
      const wendy = resolve("Wendy");

      expect(wendy).toBeInstanceOf(TdaiCore);
      expect(wendy).not.toBe(mainCore);

      // Normalized uid variants share one core (Map dedup + promise dedup).
      expect(resolve("wendy")).toBe(wendy);
      expect(resolve("  WENDY  ")).toBe(wendy);

      // A second user gets her own core.
      expect(resolve("li-hua")).not.toBe(wendy);
      expect(resolve("li-hua")).not.toBe(mainCore);

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
      const mainCore = resolve(undefined);
      expect(resolve("huangzhengbo")).toBe(mainCore);
      expect(resolve("HuangZhengBo")).toBe(mainCore);
      expect(resolve("default")).toBe(mainCore);
      expect(resolve("wendy.li")).toBe(mainCore); // fail-closed, no stripping
      expect(resolve("../etc/passwd")).toBe(mainCore);
      expect(resolve(42)).toBe(mainCore);
      expect(resolve("")).toBe(mainCore);

      // None of the above may create a per-user directory.
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("warns on normalization rejection, silently for owner and 'default'", async () => {
    const { gw, resolve } = makeGateway({ enabled: true, ownerUserIds: ["huangzhengbo"] });
    try {
      resolve("huangzhengbo");
      resolve("default");
      expect(warnSpy).not.toHaveBeenCalled();

      resolve("wendy.li");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Invalid or missing user_id");
    } finally {
      await gw.stop();
    }
  });

  it("routes everything to the main core when the feature is off", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: false, ownerUserIds: [] });
    try {
      const mainCore = resolve(undefined);
      expect(resolve("wendy")).toBe(mainCore);
      expect(resolve("wendy.li")).toBe(mainCore);
      expect(resolve("Wendy")).toBe(mainCore);
      expect(fs.existsSync(path.join(baseDir, "users"))).toBe(false);
    } finally {
      await gw.stop();
    }
  });

  it("isolates per-user stores: each user's capture lands only in its own directory", async () => {
    const { gw, resolve, baseDir } = makeGateway({ enabled: true, ownerUserIds: [] });
    try {
      const wendy = resolve("wendy");
      const lihua = resolve("li-hua");

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
    const wendy = resolve("wendy");
    const lihua = resolve("li-hua");
    const wendyDestroy = vi.spyOn(wendy, "destroy");
    const lihuaDestroy = vi.spyOn(lihua, "destroy");

    await gw.stop();

    expect(wendyDestroy).toHaveBeenCalled();
    expect(lihuaDestroy).toHaveBeenCalled();
  });
});
