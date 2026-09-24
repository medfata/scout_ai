/**
 * Reply classifier prompt (section 6: one job, one Zod output schema, one prompt file).
 * Versioned as a function so a change is visible in the row it produced and in Langfuse.
 *
 * Static context goes first so provider prompt caching applies (section 6, prompt hygiene).
 */

export const REPLY_CLASSIFIER_PROMPT_VERSION = "reply-classifier/v1";

/** Static half — identical for every reply, so it can be cached by the provider. */
export const REPLY_CLASSIFIER_SYSTEM = [
  "You classify replies to cold outreach for a solo consultant who sells AI problem-solving services.",
  "You never write copy and you never give advice. You return one label and a short summary.",
  "",
  "Intents and their meaning:",
  '- interested: the person wants to know more or is open to a conversation.',
  '- meeting_request: the person asks for a call, a demo or a time to talk.',
  "- question: the person asks a factual question that expects an answer before deciding.",
  "- referral: the person points you to a colleague or another team.",
  '- not_now: the timing is wrong but they are not closing the door ("come back in Q3", "in 3 months").',
  "- not_interested: a clear no.",
  '- unsubscribe: they ask to stop receiving email, or tell you to remove them.',
  "- out_of_office: an automated absence notice; often contains a return date.",
  "- bounce: a delivery failure notice from a mail server.",
  "- auto_reply: any other automated acknowledgement (ticket created, address changed).",
  "- other: none of the above.",
  "",
  "Rules:",
  "- A human sentence beats an automated footer: if a person writes anything at all, classify the human part.",
  "- If the message mixes an absence notice with a real answer, use the human intent.",
  '- Return a "returnDate" (YYYY-MM-DD) only for out_of_office, when the notice states a date.',
  '- Return "followUpAfter" (YYYY-MM-DD) only for not_now, when the person names a date or a delay.',
  '- Return "referral" details only when a specific person is named.',
].join("\n");

export interface ReplyClassifierInput {
  /** The prospect's address is not needed to classify; the domain is, for the summary. */
  subject: string | null;
  body: string;
  /** Sender's display name, when the provider gives one. */
  fromName: string | null;
  companyName: string | null;
  /** The message we sent that this replies to, so the thread is unambiguous. */
  previousMessage: string | null;
}

export function buildReplyClassifierPrompt(input: ReplyClassifierInput): string {
  const parts: string[] = [];

  parts.push("## The message we sent");
  parts.push(input.previousMessage ?? "(not available)");

  parts.push("");
  parts.push("## The reply");
  parts.push(`From: ${input.fromName ?? "unknown"} at ${input.companyName ?? "unknown company"}`);
  parts.push(`Subject: ${input.subject ?? "(no subject)"}`);
  parts.push("");
  parts.push(input.body);

  parts.push("");
  parts.push("Classify the reply now. Return only the structured label.");

  return parts.join("\n");
}
