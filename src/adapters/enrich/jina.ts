import { z } from "zod";

import { normalizeDomain } from "@/src/domain/suppression";
import { ScoutError, VendorError } from "@/src/lib/errors";
import type { WebsiteContent, WebsiteReader } from "@/src/ports/website-reader";
import { websiteCache, type WebsiteCacheHooks } from "@/src/services/website-cache";

/**
 * Website reader: Jina Reader (`https://r.jina.ai/<url>`) by default; Firecrawl is the
 * documented alternative (section 4). The 30-day per-domain cache lives in
 * `services/website-cache.ts` and is injectable for tests and spikes.
 *
 * Only the public company URL is sent. No personal data ever goes to Jina (section 0).
 * The anonymous tier allows 20 requests/minute, which covers v1's ~5 leads a day.
 */

const JINA_BASE_URL = "https://r.jina.ai";
const JINA_TIMEOUT_MS = 30_000;

export const JINA_RESPONSE_SCHEMA = z.looseObject({
  code: z.number().optional(),
  status: z.number().optional(),
  data: z.looseObject({
    title: z.string().nullish(),
    url: z.string().nullish(),
    content: z.string(),
    description: z.string().nullish(),
  }),
});

export interface JinaReaderOptions {
  fetchImpl?: typeof fetch;
  cache?: WebsiteCacheHooks;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createJinaWebsiteReader(options: JinaReaderOptions = {}): WebsiteReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? websiteCache;
  const baseUrl = options.baseUrl ?? JINA_BASE_URL;
  const timeoutMs = options.timeoutMs ?? JINA_TIMEOUT_MS;

  return {
    name: "jina",
    async read(input) {
      const target = normalizeTarget(input);

      const cached = await cache.get(target.domain);
      if (cached) return cached;

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/${target.url}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new VendorError("jina", `Reader request failed: ${error instanceof Error ? error.message : "network error"}`, {
          code: "vendor_unavailable",
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        throw VendorError.fromStatus("jina", response.status, await readBodyText(response), { url: target.url });
      }

      const payload = await parseJson(response, "jina");
      const parsed = JINA_RESPONSE_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new VendorError("jina", "Jina Reader returned an unexpected shape.", {
          code: "vendor_unavailable",
          retryable: true,
          context: { issues: parsed.error.issues.length },
        });
      }

      const markdown = parsed.data.data.content.trim();
      if (markdown.length === 0) {
        throw new VendorError("jina", "Jina Reader returned no content for this page.", {
          code: "vendor_unavailable",
          retryable: true,
          status: response.status,
        });
      }

      const content: WebsiteContent = {
        url: target.url,
        domain: target.domain,
        markdown,
        title: parsed.data.data.title ?? null,
        fetchedAt: new Date(),
        cached: false,
      };

      await cache.save(content);
      return content;
    },
  };
}

function normalizeTarget(input: string): { url: string; domain: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new ScoutError("A website URL is required.", { code: "validation", context: { vendor: "jina" } });

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ScoutError(`"${input}" is not a valid website URL.`, { code: "validation", context: { vendor: "jina" } });
  }

  const domain = normalizeDomain(parsed.hostname);
  if (!domain.includes(".")) {
    throw new ScoutError(`"${input}" does not contain a public domain.`, { code: "validation", context: { vendor: "jina" } });
  }

  parsed.hash = "";
  return { url: parsed.toString(), domain };
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function parseJson(response: Response, vendor: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new VendorError(vendor, "Response was not valid JSON.", {
      code: "vendor_unavailable",
      retryable: true,
      cause: error,
    });
  }
}
