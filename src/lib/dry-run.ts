/**
 * Review item 21 / section 8: preview and local environments must never send real email.
 *
 * `src/lib/env.ts` enforces the invariant at boot (DRY_RUN must be true unless
 * VERCEL_ENV=production, and DRY_RUN=true must have a redirect address). These helpers are
 * the runtime half: `isDryRunRequired` lets the send path re-derive the requirement from
 * the environment it actually sees, and `applyDryRunSubject` makes a redirected send
 * unmistakable in the recipient's inbox, next to the `X-Scout-Test` header.
 *
 * Pure and dependency-free so both `src/services/sending.ts` and tests can import it.
 */

export interface DryRunEnv {
  VERCEL_ENV?: string | null;
}

/**
 * Section 8: "Preview deployments run with DRY_RUN=true". Anything that is not Vercel
 * production — preview, development, a local shell with no VERCEL_ENV — requires it.
 */
export function isDryRunRequired(env: DryRunEnv): boolean {
  return env.VERCEL_ENV !== "production";
}

/** The visible tag; `→` is the arrow the review item specifies. */
const TEST_SUBJECT_PREFIX = "[TEST → ";

/**
 * `[TEST → original@address] Original subject`. Callers pass the *original* recipient, not
 * the redirect address, so the owner can see which test lead a message belonged to.
 *
 * Idempotent: a retried prepare step that runs this twice must not stack two tags.
 */
export function applyDryRunSubject(subject: string | null | undefined, originalRecipient: string): string {
  const tag = `${TEST_SUBJECT_PREFIX}${originalRecipient}]`;
  const base = subject?.trim() ?? "";
  if (base.startsWith(TEST_SUBJECT_PREFIX)) return base;
  return base.length > 0 ? `${tag} ${base}` : tag;
}
