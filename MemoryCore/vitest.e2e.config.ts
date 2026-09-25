/**
 * E2E vitest config — runs the `*.e2e.test.ts` suites the default config
 * excludes. These boot REAL gateway subprocesses and (where configured)
 * hit real LLM/embedding backends, so they are gated per-suite by
 * `TDAI_E2E_REAL_GATEWAY=1` (see gateway.multi-user.e2e.test.ts) and are
 * NOT part of `npm test` / CI default runs.
 *
 *   TDAI_E2E_REAL_GATEWAY=1 npx vitest run --config vitest.e2e.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts", "__tests__/**/*.e2e.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
