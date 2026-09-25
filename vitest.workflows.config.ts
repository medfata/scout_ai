import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";
import { fileURLToPath } from "node:url";

/**
 * Workflow time-travel tests (section 7: "Tests fast-forward time with `@workflow/vitest`
 * (`waitForSleep`, `wakeUp`, `resumeHook`), so a 14-day sequence is tested in seconds").
 *
 * These are the phase 5 gate. They get their own config because the SDK plugin transforms
 * and bundles the workflow files, which is expensive and would slow every unit run down.
 *
 * `pnpm test:workflows` — requires a reachable `DATABASE_URL` (the same postgres:17 CI
 * service the service tests use); the tests skip cleanly without one.
 */
export default defineConfig({
  plugins: [workflow()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/workflows/**/*.test.ts"],
    globalSetup: ["tests/workflows/global-setup.ts"],
    setupFiles: ["tests/setup/vitest.setup.ts", "tests/workflows/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
