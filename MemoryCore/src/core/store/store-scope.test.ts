import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  USER_SCOPE_PREFIX,
  buildUserScopeInstanceId,
  parseUserScopeInstanceId,
  resolveScopeDataRoot,
} from "./store-scope.js";

describe("buildUserScopeInstanceId", () => {
  it("prefixes a valid uid", () => {
    expect(USER_SCOPE_PREFIX).toBe("user:");
    expect(buildUserScopeInstanceId("legacyuser")).toBe("user:legacyuser");
    expect(buildUserScopeInstanceId("li_hua-01")).toBe("user:li_hua-01");
  });

  it("normalizes case and surrounding whitespace (same rule as the request-side uid)", () => {
    expect(buildUserScopeInstanceId("  LEGACYUSER ")).toBe("user:legacyuser");
  });

  it("throws on an invalid uid without echoing the value", () => {
    for (const bad of ["walnut.li", "../etc/passwd", "a|team:admin", "", "x".repeat(65), "用户"]) {
      expect(() => buildUserScopeInstanceId(bad)).toThrow(/invalid uid/);
      try {
        buildUserScopeInstanceId(bad);
      } catch (err) {
        const message = String((err as Error).message);
        if (bad !== "") expect(message).not.toContain(bad);
      }
    }
  });
});

describe("parseUserScopeInstanceId", () => {
  it("parses a user-scoped instance id", () => {
    expect(parseUserScopeInstanceId("user:legacyuser")).toEqual({ uid: "legacyuser" });
  });

  it("returns null for anything that is not a well-formed user scope", () => {
    for (const id of [
      "default",            // the main instance
      "e2e-test-svc",       // an ordinary service id
      "", "user", "user:",
      "user:walnut.li", "user:../x", "user:a:b",
      "User:legacyuser",         // prefix is case-sensitive
      "users:legacyuser",
    ]) {
      expect(parseUserScopeInstanceId(id), id).toBeNull();
    }
  });
});

describe("resolveScopeDataRoot", () => {
  it("keeps non-user instances on baseDir", () => {
    expect(resolveScopeDataRoot("/base", "default")).toEqual({ dataDir: "/base", scoped: false });
    expect(resolveScopeDataRoot("/base", "svc-1")).toEqual({ dataDir: "/base", scoped: false });
  });

  it("roots a user-scoped instance at <baseDir>/users/<uid>", () => {
    expect(resolveScopeDataRoot("/base", "user:legacyuser")).toEqual({
      dataDir: path.join("/base", "users", "legacyuser"),
      scoped: true,
    });
  });
});
