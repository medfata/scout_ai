import { z } from "zod";

import { normalizeDomain } from "@/src/domain/suppression";
import { VendorError } from "@/src/lib/errors";
import { logger } from "@/src/lib/logger";
import type { SignalCandidate, SignalSource } from "@/src/ports/lead-source";

/**
 * Hacker News signal source (section 2: "Hacker News 'Who is hiring' ... Companies
 * hiring for manual, repetitive roles are automation candidates").
 *
 * Read-only, no auth: the public Algolia search API finds the newest "Ask HN: Who is
 * hiring?" thread, then searches comments inside it for the ICP's triggers. Signals are
 * stored as `activity_events` of type `sourcing.finished` by the sourcing service —
 * no new table (section 5 fixes the schema at sixteen tables). Nothing here sends
 * anything, and no automated DMs exist for signal sources (section 1).
 */

const HN_ALGOLIA_BASE = "https://hn.algolia.com/api/v1";
const HN_TIMEOUT_MS = 15_000;
const HIRING_TITLE = /ask hn:\s*who is hiring\?/i;

export const HN_STORY_SCHEMA = z.looseObject({
  hits: z
    .array(
      z.looseObject({
        objectID: z.string(),
        title: z.string().nullish(),
        created_at: z.string().nullish(),
      }),
    )
    .default([]),
});

export const HN_COMMENT_SCHEMA = z.looseObject({
  hits: z
    .array(
      z.looseObject({
        objectID: z.string(),
        comment_text: z.string().nullish(),
        created_at: z.string().nullish(),
      }),
    )
    .default([]),
});

export interface HackerNewsSourceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export function createHackerNewsSource(options: HackerNewsSourceOptions = {}): SignalSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HN_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? HN_ALGOLIA_BASE;

  return {
    name: "hn",
    async search(input) {
      const story = await findLatestHiringStory(fetchImpl, baseUrl, timeoutMs);
      if (!story) {
        logger.warn("hn.hiring_story_not_found", { query: input.query.slice(0, 80) });
        return [];
      }

      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("query", input.query);
      url.searchParams.set("tags", `comment,story_${story}`);
      url.searchParams.set("hitsPerPage", String(Math.min(Math.max(input.limit, 1), 50)));

      const response = await get(fetchImpl, url, timeoutMs, "hn");
      const payload = await parseJson(response, "hn");
      if (!response.ok) {
        throw VendorError.fromStatus("hn", response.status, typeof payload === "string" ? payload : JSON.stringify(payload));
      }

      const parsed = HN_COMMENT_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new VendorError("hn", "Algolia returned an unexpected comment search shape.", {
          code: "vendor_unavailable",
          context: { issues: parsed.error.issues.length },
        });
      }

      return parsed.data.hits
        .slice(0, input.limit)
        .map((hit) => toSignal(hit.objectID, hit.comment_text ?? null, hit.created_at ?? null))
        .filter((signal): signal is SignalCandidate => signal !== null);
    },
  };
}

async function findLatestHiringStory(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<string | null> {
  const url = new URL(`${baseUrl}/search_by_date`);
  url.searchParams.set("query", "Ask HN: Who is hiring?");
  url.searchParams.set("tags", "story");
  url.searchParams.set("hitsPerPage", "10");

  const response = await get(fetchImpl, url, timeoutMs, "hn");
  const payload = await parseJson(response, "hn");
  if (!response.ok) {
    throw VendorError.fromStatus("hn", response.status, typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  const parsed = HN_STORY_SCHEMA.safeParse(payload);
  if (!parsed.success) {
    throw new VendorError("hn", "Algolia returned an unexpected story search shape.", {
      code: "vendor_unavailable",
      context: { issues: parsed.error.issues.length },
    });
  }

  const story = parsed.data.hits.find((hit) => HIRING_TITLE.test(hit.title ?? ""));
  return story?.objectID ?? null;
}

/** Pure mapping, exported so the shape can be asserted without the network. */
export function toSignal(
  objectId: string,
  rawCommentText: string | null,
  createdAt: string | null,
): SignalCandidate | null {
  const text = cleanText(rawCommentText ?? "");
  if (!text) return null;

  const firstLine = text.split("|")[0]?.trim() ?? "";
  const companyName = firstLine.slice(0, 120);
  if (!companyName) return null;

  return {
    companyName,
    companyDomain: extractExplicitDomain(text),
    signal: text.slice(0, 240),
    url: `https://news.ycombinator.com/item?id=${objectId}`,
    postedAt: createdAt,
    source: "hn",
  };
}

function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
  };
  return value
    .replace(/&(amp|lt|gt|quot|nbsp|#x27|#39);/g, (match) => named[match] ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));
}

/** Only explicit URLs become domains: bare words like "Node.js" must not look like one. */
function extractExplicitDomain(text: string): string | null {
  const match = /(?:https?:\/\/|\bwww\.)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text);
  if (!match?.[1]) return null;
  const domain = normalizeDomain(match[1]);
  return domain.includes(".") ? domain : null;
}

async function get(fetchImpl: typeof fetch, url: URL, timeoutMs: number, vendor: string): Promise<Response> {
  try {
    return await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new VendorError(vendor, `Request failed: ${error instanceof Error ? error.message : "network error"}`, {
      code: "vendor_unavailable",
      retryable: true,
      cause: error,
    });
  }
}

async function parseJson(response: Response, vendor: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new VendorError(vendor, "Response was not valid JSON.", { code: "vendor_unavailable", retryable: true });
    }
    return text;
  }
}
