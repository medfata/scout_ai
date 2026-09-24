import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import * as schema from "./schema";

/**
 * One driver for local dev, CI and production (see DECISIONS.md D5). The Neon pooled
 * endpoint runs PgBouncer in transaction mode, which does not support prepared
 * statements, so `prepare` is turned off automatically when the host says `-pooler`.
 */

export type Database = PostgresJsDatabase<typeof schema>;

let sqlClient: postgres.Sql | null = null;
let database: Database | null = null;

function isPooled(url: string): boolean {
  return url.includes("-pooler");
}

function createSql(): postgres.Sql {
  const { DATABASE_URL } = getEnv();
  const pooled = isPooled(DATABASE_URL);
  return postgres(DATABASE_URL, {
    max: pooled ? 3 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: !pooled,
    // Vercel's Postgres integrations set a self-signed chain in some regions.
    ssl: DATABASE_URL.includes("sslmode=disable") ? false : "prefer",
    onnotice: () => {},
  });
}

export function getSql(): postgres.Sql {
  if (!sqlClient) {
    sqlClient = createSql();
  }
  return sqlClient;
}

export function getDb(): Database {
  if (!database) {
    database = drizzle(getSql(), { schema, logger: false });
  }
  return database;
}

/** Test seam: closes the pool so a test process can exit cleanly. */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    database = null;
  }
}

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs `fn` in a transaction. Retries once on a serialization failure, which is what
 * Postgres reports when two workers race for the same `send_counters` row.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const db = getDb();
  try {
    return await db.transaction(fn);
  } catch (error) {
    if (isSerializationFailure(error)) {
      logger.warn("db.transaction.retry", { reason: "serialization_failure" });
      return await db.transaction(fn);
    }
    throw error;
  }
}

function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "40001" || code === "40P01";
}

export { schema };
