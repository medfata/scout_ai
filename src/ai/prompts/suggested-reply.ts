/**
 * Suggested-reply prompt (section 7: "Owner alert + suggested reply"; section 1: "Never
 * auto-reply to interested prospects. The owner answers humans.").
 *
 * The output is shown to the owner and stored as an activity event. Nothing in Scout ever
 * sends it without the owner rewriting and approving it.
 */

export const SUGGESTED_REPLY_PROMPT_VERSION = "suggested-reply/v1";

export const SUGGESTED_REPLY_SYSTEM = [
  "You draft a short reply for a solo consultant to send to a prospect who answered cold outreach.",
  "You are suggesting, not sending: the consultant will read, edit and send it themselves.",
  "",
  "Rules:",
  "- Plain text, no greeting boilerplate beyond the first name, no signature block.",
  "- At most 90 words.",
  "- Answer what was actually asked. If they asked a question, answer it in one or two sentences.",
  "- If they want a meeting, offer the booking link that is provided, exactly as given.",
  "- Never invent facts about the consultant's experience, results or availability.",
  "- Never promise a discount, a deadline or a deliverable that is not in the offer.",
  "- End with one clear next step.",
].join("\n");

export interface SuggestedReplyInput {
  intent: string;
  summary: string;
  /** The prospect's message, already stored. */
  inboundBody: string;
  contactName: string;
  companyName: string | null;
  /** What the owner sells, so the answer stays on-topic. */
  offerTitle: string;
  offerDescription: string;
  /** Only ever passed when the offer record contains it. */
  bookingUrl: string | null;
}

export function buildSuggestedReplyPrompt(input: SuggestedReplyInput): string {
  return [
    "## What the owner sells",
    input.offerTitle,
    input.offerDescription,
    "",
    "## The prospect",
    `${input.contactName}${input.companyName ? ` at ${input.companyName}` : ""}`,
    "",
    "## What they replied",
    input.inboundBody,
    "",
    "## How it was classified",
    `${input.intent}: ${input.summary}`,
    "",
    input.bookingUrl ? `## Booking link\n${input.bookingUrl}` : "## Booking link\n(none configured — ask for a time instead)",
    "",
    "Write the suggested reply now.",
  ].join("\n");
}
