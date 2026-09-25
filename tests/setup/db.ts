import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { closeDb, getDb, getSql, type Database } from "@/src/db/client";
import { logger } from "@/src/lib/logger";

/**
 * The shared database harness for service tests.
 *
 * Service tests run against the real Postgres `DATABASE_URL` points at — the same
 * `postgres:17` service CI provides — with the committed Drizzle migrations applied.
 * Locally they skip cleanly when no database is reachable, so `pnpm test` still works
 * on a laptop with no Postgres (`describe.skipIf(!(await hasDatabase()))`).
 *
 * In CI (`process.env.CI` is set) an unreachable database is a hard failure instead. A
 * CI run that skipped every database-backed suite would go green having tested nothing,
 * which is exactly the misconfiguration those suites exist to catch.
 *
 * The Better Auth tables (`user`, `session`, `account`, `verification`) are never
 * truncated: they are framework-owned and a test must not wipe a developer's session.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Every domain table, in the section 5 order. `CASCADE` makes the order irrelevant for
 * foreign keys; `RESTART IDENTITY` resets the sequence behind `activity_events`.
 */
const DOMAIN_TABLES = [
  "activity_events",
  "webhook_events",
  "send_counters",
  "suppressions",
  "messages",
  "enrollments",
  "experiment_arms",
  "learnings",
  "lead_scores",
  "research_briefs",
  "contacts",
  "companies",
  "icps",
  "offers",
  "connected_accounts",
  "settings",
] as const;

let readiness: Promise<boolean> | null = null;

/** GitHub Actions and every common CI provider set `CI`; a local run normally leaves it unset. */
function inCi(): boolean {
  return Boolean(process.env.CI);
}

/** Driver error name and socket code only — never the connection string or an error body. */
function failureDetails(error: unknown): { reason: string; code?: string } {
  return {
    reason: error instanceof Error ? error.name : "unknown",
    code:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined,
  };
}

/**
 * Connects once, applies the committed migrations, and reports whether the database is
 * usable. A failure is remembered (the pool is closed) so every DB-backed suite skips
 * instead of trying to reconnect on every collection. When `CI` is set the failure is
 * thrown instead of returned, so a misconfigured CI database fails the run loudly.
 */
async function connectAndMigrate(): Promise<boolean> {
  try {
    await getSql()`select 1`;
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
    return true;
  } catch (error) {
    const { reason, code } = failureDetails(error);
    if (inCi()) {
      logger.error("tests.database_unavailable_in_ci", { reason, code });
      await closeDb().catch(() => {});
      throw new Error(
        [
          `tests: CI is set but DATABASE_URL is unreachable (${reason}${code ? ` [${code}]` : ""}).`,
          "The database-backed suites fail instead of skipping here: in CI a skip would turn",
          "a broken database configuration into a green run that tested nothing.",
          "Check that the Postgres service is running and that DATABASE_URL points at it",
          "(see .github/workflows/ci.yml). Locally, run `docker compose up -d` and set",
          "DATABASE_URL=postgres://scout:scout@localhost:55432/scout_test — or leave CI unset to skip.",
        ].join(" "),
      );
    }
    // Never log the connection string or a driver error body (rule 11); the error name
    // and socket code are enough to tell "no server" from "bad credentials" while debugging.
    logger.warn("tests.database_unavailable", { reason, code });
    await closeDb().catch(() => {});
    return false;
  }
}

/**
 * True when `DATABASE_URL` is reachable and the migrations are applied. Cached per
 * process. Throws when `CI` is set and the database is unusable (see `connectAndMigrate`).
 */
export function hasDatabase(): Promise<boolean> {
  readiness ??= connectAndMigrate();
  return readiness;
}

/**
 * Empties every domain table between tests. `RESTART IDENTITY CASCADE` also resets the
 * sequences and truncates FK-referencing tables, which is why the auth tables are
 * deliberately not in the list.
 */
export async function resetDatabase(): Promise<void> {
  if (!(await hasDatabase())) {
    throw new Error("resetDatabase() requires a reachable DATABASE_URL.");
  }
  const tables = DOMAIN_TABLES.map((table) => `"${table}"`).join(", ");
  await getSql().unsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

/**
 * Runs `fn` with the shared database, after the readiness check. Not wrapped in a
 * transaction: a test that needs one (or needs to run statements the guard would roll
 * back) opens its own. The name exists so a test never talks to `src/db/client` directly
 * and accidentally skips the migration step.
 */
export async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  if (!(await hasDatabase())) {
    throw new Error("withDb() requires a reachable DATABASE_URL.");
  }
  return fn(getDb());
}

/** Closes the pool so a test worker can exit without waiting for idle connections. */
export async function closeTestDatabase(): Promise<void> {
  await closeDb();
}
