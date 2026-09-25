/**
 * Eval-only environment bootstrap (section 11 phase 3, stage 1b).
 *
 * The real prompt functions and agents are imported unchanged, so `getEnv()` eventually runs.
 * Evals are not the app: they never touch the database, the mailbox or a workflow. This file
 * does two things, in order:
 *
 *  1. loads `.env.local` the same way `scripts/refresh-models.ts` does (tsx and promptfoo do
 *     not load it for us), and
 *  2. fills the *unused* core variables with local-only stubs so an eval run needs only
 *     `AI_GATEWAY_API_KEY` and `MODEL_COPY` from the owner.
 *
 * Stubs are set only when the variable is missing, never overwritten. The stubbed
 * `DATABASE_URL` points at port 1 with a database name that says out loud it must never be
 * used, so an accidental connection fails immediately instead of reaching a real database.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Variables `src/lib/env.ts` requires that an eval never reads. Values are deliberately fake. */
const EVAL_STUBS: Readonly<Record<string, string>> = {
  APP_URL: "http://localhost:3000",
  ADMIN_EMAIL: "owner@example.com",
  BETTER_AUTH_SECRET: "eval-stub-secret-never-used-0000000000",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  DATABASE_URL: "postgres://eval:never-connected@127.0.0.1:1/scout_evals_never_connected",
  OWNER_TIMEZONE: "UTC",
  DRY_RUN: "true",
  DRY_RUN_REDIRECT_EMAIL: "owner@example.com",
  MODEL_RESEARCH: "eval-research-unused",
};

/** Variables the owner must supply. `MODEL_COPY` lives in env by decision D7: ids are never hard-coded. */
const REQUIRED_KEYS = ["AI_GATEWAY_API_KEY", "MODEL_COPY"] as const;

let loaded = false;

/** Minimal `.env.local` loader; existing process env always wins. */
export function loadDotEnvLocal(cwd: string = process.cwd()): void {
  const path = resolve(cwd, ".env.local");
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key.length === 0 || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function setStubs(): void {
  for (const [key, value] of Object.entries(EVAL_STUBS)) {
    const current = process.env[key];
    if (current === undefined || current.length === 0) process.env[key] = value;
  }
}

export interface EvalEnvReady {
  ok: true;
}

export interface EvalEnvMissing {
  ok: false;
  message: string;
}

/**
 * Loads env, applies stubs, and reports politely when the owner has not provided a key yet.
 * Never throws: providers turn the message into a test error, scripts print it and stop.
 */
export function prepareEvalEnv(cwd: string = process.cwd()): EvalEnvReady | EvalEnvMissing {
  if (!loaded) {
    loadDotEnvLocal(cwd);
    loaded = true;
  }
  setStubs();

  const missing = REQUIRED_KEYS.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.length === 0;
  });
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    message: [
      `Scout evals need ${missing.join(" and ")}.`,
      "Copy .env.example to .env.local, set the AI Gateway key and the MODEL_COPY id from the",
      "gateway model list (scripts/refresh-models.ts prints it), then run the eval again.",
    ].join(" "),
  };
}

/** Throws the polite message; used inside model-calling providers and assertions. */
export function requireEvalEnv(): void {
  const status = prepareEvalEnv();
  if (!status.ok) throw new Error(status.message);
}
