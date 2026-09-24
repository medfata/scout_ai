/**
 * Enrichment adapters: turn a candidate into a contactable lead.
 *  - `patterns` guesses email addresses from the name and company domain.
 *  - `jina` reads a public company page to markdown, cached per domain for 30 days.
 */

export {
  COMMON_EMAIL_PATTERNS,
  createEmailPatternGuesser,
  guessEmailCandidates,
  guessEmailCandidatesWithPatterns,
} from "./patterns";
export type { EmailPatternCandidate } from "./patterns";

export { createJinaWebsiteReader, JINA_RESPONSE_SCHEMA } from "./jina";
export type { JinaReaderOptions } from "./jina";
