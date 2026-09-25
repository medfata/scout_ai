/**
 * Safe defaults for every Vitest process (section 10 rule 4: "Tests run against
 * in-memory fakes and MSW mocks; no test hits a real vendor").
 *
 * Values already present in the environment win, so CI can still point
 * `DATABASE_URL` at its throwaway Postgres service. Locally, nothing here
 * talks to a real service: the dummy URL resolves to a closed port, and no
 * test may open a connection to it.
 *
 * This file must not export anything (Vitest treats a setup file with exports
 * as a module whose exports are ignored, which hides typos).
 */

const defaults: Record<string, string> = {
  APP_URL: "http://localhost:3000",
  ADMIN_EMAIL: "owner@example.com",
  // 32+ chars, so `src/lib/env.ts` accepts it; never used against a real server.
  BETTER_AUTH_SECRET: "scout-test-secret-scout-test-secret-scout-test-secret",
  // 32 zero-free bytes, base64. Dummy key for AES-256-GCM helpers under test.
  ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  // Port 1 is never open: a test that accidentally queries fails fast instead of
  // silently reaching a developer's database.
  DATABASE_URL: "postgres://scout:scout@127.0.0.1:1/scout_test?sslmode=disable",
  OWNER_TIMEZONE: "UTC",
  DRY_RUN: "true",
  // Review item 21: env validation refuses DRY_RUN=true without a redirect destination.
  DRY_RUN_REDIRECT_EMAIL: "owner@example.com",
  // Section 4: model ids live in env, never hard-coded. Required core vars; the values
  // are placeholders and no test may make a model call.
  MODEL_COPY: "test/model-copy",
  MODEL_RESEARCH: "test-model-research",
};

for (const [name, value] of Object.entries(defaults)) {
  if (!process.env[name]) process.env[name] = value;
}
