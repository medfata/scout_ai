import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { closeDb, getDb, getSql, type Database } from "@/src/db/client";
import { logger } from "@/src/lib/logger";

/**
 * The shared database harness for service tests.
 *
 * Service tests run against the real Postgres `DATABASE_URL` points at — the same
 * `postgres:17` service CI provides — with the committed Drizzle migrations applied.
 * They skip cleanly when no database is reachable, so `pnpm test` still works on a
 * laptop with no Postgres (`describe.skipIf(!(await hasDatabase()))`).
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

/**
 * Connects once, applies the committed migrations, and reports whether the database is
 * usable. A failure is remembered (the pool is closed) so every DB-backed suite skips
 * instead of trying to reconnect on every collection.
 */
async function connectAndMigrate(): Promise<boolean> {
  try {
    await getSql()`select 1`;
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
    return true;
  } catch (error) {
    // Never log the connection string or a driver error body (rule 11); the error name
    // and socket code are enough to tell "no server" from "bad credentials" while debugging.
    logger.warn("tests.database_unavailable", {
      reason: error instanceof Error ? error.name : "unknown",
      code: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined,
    });
    await closeDb().catch(() => {});
    return false;
  }
}

/** True when `DATABASE_URL` is reachable and the migrations are applied. Cached. */
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
