import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/src/db/client";
import { companies } from "@/src/db/schema";
import { normalizeDomain } from "@/src/domain/suppression";
import type { WebsiteContent } from "@/src/ports/website-reader";
import { recordActivity } from "./activity";

/**
 * Website-to-markdown cache (section 6: "Website markdown is cached per domain for
 * 30 days"). It lives in `companies.raw.website` plus `companies.enrichedAt`, which is
 * why the schema stays at sixteen tables (section 5).
 *
 * Only the public company URL is cached here. The reader never sends personal data to
 * Jina (section 0: public company data only).
 */

export const WEBSITE_CACHE_TTL_DAYS = 30;
export const WEBSITE_CACHE_FIELD = "website";

const CACHED_WEBSITE_SCHEMA = z.object({
  url: z.string(),
  markdown: z.string(),
  title: z.string().nullish(),
  fetchedAt: z.string(),
});

/** Injectable seam: tests and spikes use an in-memory cache instead of Postgres. */
export interface WebsiteCacheHooks {
  get(domain: string): Promise<WebsiteContent | null>;
  save(content: WebsiteContent): Promise<void>;
}

export async function getCachedWebsite(domainInput: string): Promise<WebsiteContent | null> {
  const domain = normalizeDomain(domainInput);
  if (!domain) return null;

  const db = getDb();
  const [row] = await db
    .select({ raw: companies.raw })
    .from(companies)
    .where(eq(companies.domain, domain))
    .limit(1);
  if (!row) return null;

  const parsed = CACHED_WEBSITE_SCHEMA.safeParse((row.raw ?? {})[WEBSITE_CACHE_FIELD]);
  if (!parsed.success) return null;

  const fetchedAt = new Date(parsed.data.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) return null;

  const ageMs = Date.now() - fetchedAt.getTime();
  if (ageMs > WEBSITE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;

  return {
    url: parsed.data.url,
    domain,
    markdown: parsed.data.markdown,
    title: parsed.data.title ?? null,
    fetchedAt,
    cached: true,
  };
}

/** Returns false when the company row does not exist yet; the caller can still use the content. */
export async function saveCachedWebsite(content: WebsiteContent): Promise<boolean> {
  const domain = normalizeDomain(content.domain);
  if (!domain) return false;

  const db = getDb();
  const [row] = await db
    .select({ id: companies.id, raw: companies.raw })
    .from(companies)
    .where(eq(companies.domain, domain))
    .limit(1);
  if (!row) return false;

  await db
    .update(companies)
    .set({
      raw: {
        ...(row.raw ?? {}),
        [WEBSITE_CACHE_FIELD]: {
          url: content.url,
          markdown: content.markdown,
          title: content.title,
          fetchedAt: content.fetchedAt.toISOString(),
        },
      },
      enrichedAt: new Date(),
    })
    .where(eq(companies.id, row.id));

  await recordActivity({
    actor: "system",
    entityType: "company",
    entityId: row.id,
    type: "website.read",
    data: { domain, cached: false },
  });

  return true;
}

export const websiteCache: WebsiteCacheHooks = {
  get: getCachedWebsite,
  save: async (content) => {
    await saveCachedWebsite(content);
  },
};
