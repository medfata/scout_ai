/**
 * Code-only copy checks that need a little more than `evaluateCopyRules` exposes. Everything
 * that already exists in `src/domain/copy-rules.ts` is called there, never reimplemented; the
 * one addition here is section 6's "exactly one low-friction question", counted *outside* the
 * signature block and the opt-out line (both of which may legitimately contain a question mark).
 */

const QUESTION_PATTERN = /\?/g;

/** The signature block's first non-empty line is what the body must contain (`bodyHasSignature`). */
export function signatureFirstLine(signatureBlock: string): string | null {
  for (const line of signatureBlock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** Returns the body up to the signature block. */
export function stripSignature(body: string, signatureBlock: string): string {
  const firstLine = signatureFirstLine(signatureBlock);
  if (firstLine === null) return body;
  const index = body.indexOf(firstLine);
  return index === -1 ? body : body.slice(0, index);
}

export function countCtaQuestions(body: string, signatureBlock: string, optOutLine: string): number {
  let text = stripSignature(body, signatureBlock);
  if (optOutLine.trim().length > 0) {
    text = text.split(optOutLine.trim()).join(" ");
  }
  return (text.match(QUESTION_PATTERN) ?? []).length;
}

/** Section 6: "Email 1 ... at most 110 words; follow-ups at most 70". */
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}
