/**
 * Regenerates the `MODEL_PRICES` table in `src/ai/pricing.ts` from the live AI Gateway
 * model list (section 10 rule 1: "Read current docs, never memory"). The same response is
 * where MODEL_COPY and MODEL_RESEARCH ids come from, but those stay env-only (section 4:
 * "IDs live in env, never hard-coded"), so this script only prints them as a hint.
 *
 * Usage:
 *   pnpm tsx scripts/refresh-models.ts
 *
 * Refuses politely when `AI_GATEWAY_API_KEY` is missing; nothing is written in that case.
 * The rewrite is guarded: if the header line or the `MODEL_PRICES` block is not found, the
 * script fails without touching the file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const PRICING_PATH = resolve(process.cwd(), "src/ai/pricing.ts");

/** Minimal `.env.local` loader for scripts (Next loads it for the app; tsx does not). */
function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface GatewayModel {
  id: string;
  type: unknown;
  pricing: unknown;
}

function readModels(payload: unknown): GatewayModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("The AI Gateway model list changed shape (no `data` array). Nothing was written.");
  }

  const models: GatewayModel[] = [];
  for (const raw of payload.data) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    models.push({ id: raw.id, type: raw.type, pricing: raw.pricing });
  }
  return models;
}

/** Keeps the gateway's own decimal string, so no rounding or scientific notation creeps in. */
function priceLiteral(raw: unknown): string | null {
  const value = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
}

interface ModelPrice {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

function readPricing(raw: unknown): ModelPrice | null {
  if (!isRecord(raw)) return null;
  const input = priceLiteral(raw.input);
  const output = priceLiteral(raw.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: priceLiteral(raw.input_cache_read) ?? "0",
    cacheWrite: priceLiteral(raw.input_cache_write) ?? "0",
  };
}

/**
 * Every priced language model, sorted by id. `google/*` ids also get the bare alias the
 * existing table uses for Google AI Studio's free research tier (section 0).
 */
function buildEntries(models: GatewayModel[]): Array<{ id: string; price: ModelPrice }> {
  const entries: Array<{ id: string; price: ModelPrice }> = [];
  const seen = new Set<string>();

  const add = (id: string, price: ModelPrice): void => {
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ id, price });
  };

  for (const model of models) {
    if (model.type !== "language") continue;
    const price = readPricing(model.pricing);
    if (!price) continue;
    add(model.id, price);
    if (model.id.startsWith("google/")) add(model.id.slice("google/".length), price);
  }

  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function renderTable(entries: ReadonlyArray<{ id: string; price: ModelPrice }>): string {
  const rows = entries
    .map(
      ({ id, price }) =>
        `  ${JSON.stringify(id)}: { input: ${price.input}, output: ${price.output}, cacheRead: ${price.cacheRead}, cacheWrite: ${price.cacheWrite} },`,
    )
    .join("\n");
  return `export const MODEL_PRICES: Readonly<Record<string, TokenPrice>> = Object.freeze({\n${rows}\n});`;
}

async function fetchModels(apiKey: string): Promise<unknown> {
  const response = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`The AI Gateway model list returned HTTP ${response.status}. Nothing was written.`);
  }
  return response.json();
}

function rewritePricingFile(entries: ReadonlyArray<{ id: string; price: ModelPrice }>): void {
  const source = readFileSync(PRICING_PATH, "utf8");
  const date = new Date().toISOString().slice(0, 10);

  const withDate = source.replace(
    /Generated \d{4}-\d{2}-\d{2} from https:\/\/ai-gateway\.vercel\.sh\/v1\/models/,
    () => `Generated ${date} from https://ai-gateway.vercel.sh/v1/models`,
  );
  if (withDate === source) {
    throw new Error(`Could not find the "Generated ..." header line in ${PRICING_PATH}. Nothing was written.`);
  }

  const tablePattern = /export const MODEL_PRICES: Readonly<Record<string, TokenPrice>> = Object\.freeze\(\{[\s\S]*?\n\}\);/;
  if (!tablePattern.test(withDate)) {
    throw new Error(`Could not find the MODEL_PRICES block in ${PRICING_PATH}. Nothing was written.`);
  }

  writeFileSync(PRICING_PATH, withDate.replace(tablePattern, () => renderTable(entries)), "utf8");
}

async function main(): Promise<void> {
  loadEnvLocal();

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.log(
      [
        "refresh-models: AI_GATEWAY_API_KEY is not set, so the model list was not fetched.",
        "Add it to .env.local (see .env.example) and run this again. Nothing was written.",
      ].join("\n"),
    );
    return;
  }

  const models = readModels(await fetchModels(apiKey));
  const entries = buildEntries(models);
  if (entries.length === 0) {
    throw new Error("The gateway returned no priced language models. Nothing was written.");
  }

  rewritePricingFile(entries);

  console.log(`refresh-models: wrote ${entries.length} model prices to src/ai/pricing.ts.`);
  const gemini = entries
    .filter((entry) => entry.id.startsWith("google/") && /gemini/i.test(entry.id))
    .map((entry) => entry.id);
  console.log(`refresh-models: current Gemini ids: ${gemini.slice(0, 12).join(", ")}${gemini.length > 12 ? ", ..." : ""}`);
  console.log(
    "refresh-models: MODEL_COPY and MODEL_RESEARCH stay env-only (section 4). Set them in .env.local, and in the Vercel project for Preview and Production.",
  );
}

void main().catch((error: unknown) => {
  console.error(`refresh-models failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
