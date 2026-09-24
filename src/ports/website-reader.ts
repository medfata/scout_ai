/**
 * Port: website to markdown for company research. Adapter uses Jina Reader (v1) or
 * Firecrawl; the cache is by domain for 30 days (section 6).
 */
export interface WebsiteContent {
  url: string;
  domain: string;
  markdown: string;
  title: string | null;
  fetchedAt: Date;
  /** True when the cache answered. Cache hits do not cost Exa or Jina quota. */
  cached: boolean;
}

export interface WebsiteReader {
  readonly name: string;
  read(url: string): Promise<WebsiteContent>;
}
