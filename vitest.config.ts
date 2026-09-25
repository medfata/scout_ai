import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit, domain and service tests.
 *
 * Service tests run against a real Postgres (`DATABASE_URL`) with the committed Drizzle
 * migrations applied — the same database CI provides as a `postgres:17` service. They skip
 * cleanly when no database is reachable, so `pnpm test` still works on a laptop without one.
 *
 * Workflow time-travel tests live in `vitest.workflows.config.ts`: the Workflow SDK needs its
 * own Vite plugin and a build step, which would slow every unit run down.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/workflows/**", "node_modules/**", ".next/**"],
    setupFiles: ["tests/setup/vitest.setup.ts"],
    // Service tests share one database, so they must not interleave.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/db/migrations/**"],
      reporter: ["text", "lcov"],
    },
  },
});
