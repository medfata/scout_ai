import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated and applied with drizzle-kit only (section 10, rule 10).
 * `drizzle-kit migrate` uses DATABASE_URL; CI points it at a throwaway Postgres service.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
