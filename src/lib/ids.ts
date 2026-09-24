import type { ChannelKind } from "@/src/domain/types";

/**
 * Key and token builders. They live in one file because retries depend on them being
 * byte-identical everywhere: a workflow replay, a resumed run and a webhook must all
 * compute the same idempotency key for the same send (section 5).
 */

/** `enrollmentId:step:channel` — the unique key that makes a retried send safe. */
export function idempotencyKey(enrollmentId: string, step: number, channel: ChannelKind): string {
  return `${enrollmentId}:${step}:${channel}`;
}

export function parseIdempotencyKey(key: string): { enrollmentId: string; step: number; channel: ChannelKind } | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [enrollmentId, step, channel] = parts;
  if (!enrollmentId || step === undefined || (channel !== "email" && channel !== "linkedin")) return null;
  return { enrollmentId, step: Number(step), channel };
}

/** Hook that wakes a sleeping sequence when a lead event arrives (section 7). */
export function leadEventToken(enrollmentId: string): string {
  return `lead:${enrollmentId}`;
}

/** Hook that waits for the owner's approval on a specific step. */
export function approvalToken(enrollmentId: string, step: number): string {
  return `approval:${enrollmentId}:${step}`;
}

export function isLeadEventToken(token: string): boolean {
  return token.startsWith("lead:");
}

export function enrollmentIdFromLeadToken(token: string): string | null {
  return isLeadEventToken(token) ? token.slice("lead:".length) : null;
}

export function isApprovalToken(token: string): boolean {
  return token.startsWith("approval:");
}

export function parseApprovalToken(token: string): { enrollmentId: string; step: number } | null {
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== "approval") return null;
  const [, enrollmentId, step] = parts;
  if (!enrollmentId || step === undefined || Number.isNaN(Number(step))) return null;
  return { enrollmentId, step: Number(step) };
}

export function correlationId(): string {
  return crypto.randomUUID();
}

/** Stable key for a webhook event, so a redelivery is ignored (section 5). */
export function webhookExternalId(provider: string, parts: string[]): string {
  return `${provider}:${parts.join(":")}`;
}

export function suppressionValueHashInput(kind: string, value: string): string {
  return `${kind}:${value}`;
}
