import {
  emailCapsForWarmup,
  isSuppressed,
  normalizeDomain,
  resolveStepEligibility,
  type SequenceStep,
  type SkipReason,
  type StepKind,
} from "@/src/domain";
import type { ChannelKind } from "@/src/domain/types";
import { getChannel, getReconcilableChannel, senderDomainFrom } from "@/src/adapters/channels";
import type { ConnectedAccount, Message } from "@/src/db/schema";
import { hashValue } from "@/src/lib/crypto";
import { ConfigurationError, ScoutError, SendGuardError, type SendGuardRule } from "@/src/lib/errors";
import { applyDryRunSubject } from "@/src/lib/dry-run";
import { getEnv } from "@/src/lib/env";
import { idempotencyKey } from "@/src/lib/ids";
import { logger } from "@/src/lib/logger";
import { dateOnlyInZone, isWithinWindow, jitterMs, nextWindowStart, spacingMinutesFor } from "@/src/lib/time-windows";
import type { OutboundMessage, SendResult } from "@/src/ports/channel";
import { recordActivity } from "./activity";
import { getPrimaryEmailAccount, reserveSendSlot } from "./accounts";
import { loadSequencePlan } from "./enrollment";
import {
  claimMessageForSend,
  getMessageByIdempotencyKey,
  getThreadAnchor,
  hasUnresolvedInbound,
  listSentRfcMessageIds,
  markMessageFailed,
  markMessageSent,
  releaseMessage,
  storeMessageSendSlot,
  type MarkSentInput,
} from "./messages";
import { consumeSendCounter, getSendCounters, nextCounterDayStart, releaseSendCounter } from "./quota";
import { countryRequiresConsent, getSettings } from "./settings";
import { loadSuppressionEntries } from "./leads";

/**
 * Section 7: "Send guard — `sendMessage` checks these in order and aborts on the first
 * failure." Section 10 rule 6: "One send path. Nothing sends except `sendMessage` and its
 * guard; each guard rule has a test."
 *
 * Review item 6 fixes the order: the window (6) and approval (7) checks are pure, so they
 * run before the counter is consumed (5). The counter is the last side effect before the
 * claim, and every block after it releases both buckets.
 *
 * A block is a pause, never a termination (review item 9): the guard returns `blocked`
 * with a `nextAt` where waiting is meaningful, and the workflow decides whether to stop.
 */

export type SendOutcome =
  | { status: "sent"; messageId: string; providerMessageId: string; redirected: boolean }
  | { status: "skipped"; messageId: string | null; reason: SkipReason | "not_eligible" | "already_sent" }
  | { status: "blocked"; rule: SendGuardRule; detail: string; nextAt?: Date; messageId?: string }
  | { status: "failed"; messageId: string; error: string };

export interface SendMessageInput {
  enrollmentId: string;
  step: number;
  channel: ChannelKind;
  /** The in-flight sequence step, so eligibility rules stay in `src/domain/sequence.ts`. */
  stepDefinition?: SequenceStep;
}

/** Review item 9: how long a `blocked` verdict waits before the workflow looks again. */
const BLOCK_RETRY_MS = 60 * 60 * 1000;

export async function sendMessage(input: SendMessageInput): Promise<SendOutcome> {
  const env = getEnv();
  const settings = await getSettings();
  const now = new Date();

  // --- rule 0: configuration (review item 18) ------------------------------
  if (!settings.signature.trim() || !settings.postalAddress.trim()) {
    return block(
      "config_incomplete",
      "Signature or postal address is missing in Settings; every send is blocked until both are set.",
      { nextAt: retryAt(now) },
    );
  }

  // --- rule 1: kill switch (review item 9: pause, never terminate) ---------
  if (settings.killSwitch) {
    return block("kill_switch", "The kill switch is on; every send is blocked.", { nextAt: retryAt(now) });
  }

  // --- review item 21: DRY_RUN needs somewhere safe to send ----------------
  if (env.DRY_RUN && input.channel === "email" && !env.DRY_RUN_REDIRECT_EMAIL) {
    return block(
      "dry_run_unconfigured",
      "DRY_RUN is on but DRY_RUN_REDIRECT_EMAIL is not set, so there is nowhere safe to send. Set the redirect address.",
      { nextAt: retryAt(now) },
    );
  }

  // --- rule 2: enrollment status ------------------------------------------
  const plan = await loadSequencePlan(input.enrollmentId);
  if (plan.enrollment.status !== "active") {
    return block("enrollment_status", `Enrollment is "${plan.enrollment.status}", not "active".`);
  }

  // --- rule 3: suppression -------------------------------------------------
  const target = {
    email: plan.lead.email,
    companyDomain: plan.lead.company?.domain ? normalizeDomain(plan.lead.company.domain) : null,
    linkedinUrl: plan.lead.linkedinUrl,
  };
  const suppressions = await loadSuppressionEntries(target);
  if (isSuppressed(target, suppressions, hashValue)) {
    await recordActivity({
      actor: "system",
      entityType: "contact",
      entityId: plan.lead.contactId,
      type: "suppression.matched",
      data: { channel: input.channel, enrollmentId: input.enrollmentId },
    });
    return { status: "skipped", messageId: null, reason: "suppressed" };
  }

  // --- rule 4: no unclassified or human inbound since enrollment started ----
  const hasInbound = await hasUnresolvedInbound(
    plan.lead.contactId,
    plan.enrollment.startedAt ?? plan.enrollment.createdAt,
  );
  if (hasInbound) {
    return block("unclassified_inbound", "The lead has an inbound message that is not resolved; sends are paused.");
  }

  // --- eligibility (email must be valid, LinkedIn needs a URL) --------------
  // Review item 17: consent is re-checked here as well as in the plan, because a send must
  // never depend on an earlier step having computed the flag correctly.
  if (input.stepDefinition) {
    const requiresConsent =
      input.stepDefinition.channel === "email" && plan.lead.company?.country
        ? await countryRequiresConsent(plan.lead.company.country)
        : false;
    const eligibility = resolveStepEligibility(input.stepDefinition, plan.lead, {
      linkedinAutomationEnabled: env.LINKEDIN_MODE === "automated",
      now,
      hasSentAnchor: plan.hasSentAnchor,
      requiresConsent,
    });
    if (!eligibility.eligible) {
      return { status: "skipped", messageId: null, reason: eligibility.reason ?? "not_eligible" };
    }
  }

  // --- the message must exist (rule 7 material) -----------------------------
  const key = idempotencyKey(input.enrollmentId, input.step, input.channel);
  const message = await getMessageByIdempotencyKey(key);
  if (!message) {
    return block("not_approved", `No message exists for ${key}. Prepare it before sending.`);
  }
  if (message.status === "sent" || message.sentAt) {
    // Rule 8, first half: a retried step finds the message already sent.
    return { status: "skipped", messageId: message.id, reason: "already_sent" };
  }

  // --- rule 6: sending window (review item 6: pure, before any side effect) --
  const timeZone = plan.lead.contact.timezone ?? settings.timezone;
  const window = input.channel === "email" ? settings.sendingWindows.email : settings.sendingWindows.linkedin;
  if (!isWithinWindow(now, timeZone, window)) {
    return block("sending_window", `Outside the ${input.channel} sending window for ${timeZone}.`, {
      messageId: message.id,
      nextAt: nextWindowStart(now, timeZone, window),
    });
  }

  // --- rule 7: the message is approved (or is being reconciled) -------------
  if (message.status !== "approved" && message.status !== "sending") {
    return block("not_approved", `Message status is "${message.status}"; it must be approved before it can send.`, {
      messageId: message.id,
    });
  }

  // --- channel resolution: a missing adapter is configuration, not a failure --
  const channel = getChannel(input.channel);
  if (!channel) {
    if (input.channel === "email") {
      return block(
        "config_incomplete",
        "The Gmail channel is not configured. Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET, then connect the mailbox.",
        { messageId: message.id, nextAt: retryAt(now) },
      );
    }
    return { status: "skipped", messageId: message.id, reason: "linkedin_not_available" };
  }

  // --- review item 8: reconcile a message stuck in `sending` before any resend --
  const wasSending = message.status === "sending";
  if (wasSending) {
    const reconciled = await reconcileSendingMessage(message);
    if (reconciled) return reconciled;
  }

  // --- rule 5: caps and mailbox pacing (review items 6 and 11) --------------
  const stepKind: StepKind = input.stepDefinition?.kind ?? (input.step === 0 ? "first_touch" : "follow_up");
  const gate = await checkCapacity({
    enrollmentId: plan.enrollment.id,
    channel: input.channel,
    step: input.step,
    stepKind,
    contactId: plan.lead.contactId,
    messageId: message.id,
    // B2: the slot this message already reserved, if any. The message row is read before
    // the guard's side effects, so the value is the one the last attempt stored.
    scheduledFor: message.scheduledFor,
    now,
    // A message that was already `sending` consumed its counters on the first attempt
    // (or was never sent at all); consuming again would double-count a single email.
    alreadyConsumed: wasSending,
  });
  if (gate.outcome) return gate.outcome;

  // --- rule 8: claim, with the deterministic Message-ID stored first (item 8) --
  const senderDomain = gate.account ? senderDomainFrom(gate.account.handle) : "scout.local";
  const rfcMessageId = message.rfcMessageId ?? buildDeterministicMessageId(key, senderDomain);
  let claimed = message;
  if (!wasSending) {
    const row = await claimMessageForSend(message.id, rfcMessageId);
    if (!row) {
      // Another worker claimed the message between our read and the UPDATE. The claim
      // consumed the counters, so release them (review item 6).
      await gate.consumed?.();
      const latest = await getMessageByIdempotencyKey(key);
      if (latest?.status === "sent") return { status: "skipped", messageId: latest.id, reason: "already_sent" };
      return block("idempotency", "Another worker claimed this message first.", {
        messageId: latest?.id ?? message.id,
      });
    }
    claimed = row;
  }

  // --- review item 10: In-Reply-To / References for the same thread ---------
  const threading = await resolveThreading(plan.enrollment.id, input.stepDefinition, claimed);

  const isTest = env.DRY_RUN;
  const redirect = isTest ? env.DRY_RUN_REDIRECT_EMAIL ?? null : null;

  // The port does not declare `rfcMessageId` yet; an extra property on a variable (not a
  // fresh object literal) is assignable, and the Gmail adapter reads it structurally.
  const outbound: OutboundMessage = {
    to: input.channel === "email" ? redirect ?? plan.lead.email! : plan.lead.linkedinUrl!,
    // Review item 21: the test tag has to be visible in the recipient line, not only in a
    // header, so an accidental production dry-run is obvious in the thread list.
    subject: isTest && input.channel === "email" ? applyDryRunSubject(claimed.subject, plan.lead.email ?? "") : claimed.subject,
    body: claimed.body,
    threadId: threading.threadId,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    rfcMessageId,
    dryRunRedirect: redirect,
    isTest,
  };

  let result: SendResult;
  try {
    // Review item 7: `channel.send` is the only statement in this try. Recording
    // failures after a provider success must never look like send failures.
    result = await channel.send(outbound);
  } catch (error) {
    return handleChannelFailure(error, {
      message: claimed,
      enrollmentId: plan.enrollment.id,
      step: input.step,
      now,
      releaseCounters: gate.consumed,
    });
  }

  // The provider accepted the message. A failure recording it must not mark the message
  // failed or release counters (review item 7): it stays `sending` and the next attempt
  // reconciles by Message-ID (review item 8).
  await recordMessageSent(claimed, {
    providerMessageId: result.providerMessageId,
    threadId: result.threadId,
    rfcMessageId: result.rfcMessageId,
    sentAt: result.sentAt,
  });
  await recordActivity({
    actor: "system",
    entityType: "enrollment",
    entityId: plan.enrollment.id,
    type: "message.sent",
    data: {
      step: input.step,
      channel: input.channel,
      test: isTest,
      redirected: result.redirected,
      providerMessageId: result.providerMessageId,
    },
  });

  return {
    status: "sent",
    messageId: claimed.id,
    providerMessageId: result.providerMessageId,
    redirected: result.redirected,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation (review item 8)
// ---------------------------------------------------------------------------

/**
 * Review item 8: when a message is stuck in `sending`, Gmail's copy is the source of
 * truth. If the search finds it, the send happened and is recorded as `sent`; if it does
 * not, the previous attempt never reached Gmail and the caller may resend.
 *
 * The function throws a retryable `ScoutError` when it cannot decide (no stored id, a
 * channel that cannot search, or an unreachable mailbox). It never returns "not found"
 * unless the lookup actually ran and came back empty, so an ambiguous failure is never
 * blind-retried.
 */
async function reconcileSendingMessage(message: Message): Promise<SendOutcome | null> {
  if (!message.rfcMessageId) {
    throw new ScoutError('A message is stuck in "sending" with no Message-ID to reconcile against.', {
      code: "conflict",
      retryable: true,
      context: { messageId: message.id },
    });
  }

  const reconciler = getReconcilableChannel(message.channel);
  if (!reconciler) {
    throw new ScoutError(
      `The ${message.channel} channel cannot search by Message-ID, so a message stuck in "sending" cannot be reconciled.`,
      { code: "configuration", retryable: true, context: { messageId: message.id } },
    );
  }

  const found = await reconciler.findSentByRfcMessageId(message.rfcMessageId);
  if (!found) return null;

  await recordMessageSent(message, {
    providerMessageId: found.providerMessageId,
    threadId: found.threadId,
    rfcMessageId: message.rfcMessageId,
    sentAt: found.sentAt,
  });
  logger.info("send.reconciled", { messageId: message.id, enrollmentId: message.enrollmentId, step: message.step });

  // `redirected` is informational and is not persisted, so a reconciled DRY_RUN send
  // reports false here; the message row (provider id, thread, sentAt) is the record.
  return { status: "sent", messageId: message.id, providerMessageId: found.providerMessageId, redirected: false };
}

// ---------------------------------------------------------------------------
// Failure handling (review items 7 and 8)
// ---------------------------------------------------------------------------

interface SendFailureContext {
  message: Message;
  enrollmentId: string;
  step: number;
  now: Date;
  releaseCounters?: (() => Promise<void>) | undefined;
}

async function handleChannelFailure(error: unknown, context: SendFailureContext): Promise<SendOutcome> {
  const detail = error instanceof Error ? error.message : "unknown provider error";
  const messageId = context.message.id;

  // A missing mailbox or rejected credentials is an account problem, not a message
  // problem: return the message to `approved`, release the counters, and pause
  // (review item 9). The account service has already paused the mailbox.
  const accountProblem =
    error instanceof ConfigurationError || (error instanceof ScoutError && error.code === "vendor_auth");
  if (accountProblem) {
    await releaseMessage(messageId);
    await context.releaseCounters?.();
    logger.warn("send.blocked_configuration", {
      messageId,
      enrollmentId: context.enrollmentId,
      step: context.step,
      reason: detail,
    });
    return block("config_incomplete", detail, { messageId, nextAt: retryAt(context.now) });
  }

  // Review item 8: 429/5xx and errors with no HTTP status are ambiguous — the provider
  // may have accepted the send. Keep the message `sending` and rethrow a retryable
  // `ScoutError`; the workflow turns it into the SDK's retryable error, and the next
  // attempt reconciles by Message-ID before it sends anything. Never route this through
  // `markMessageFailed` + `releaseMessage` (release is a no-op after `failed`).
  const retryable = error instanceof ScoutError ? error.retryable : true;
  if (retryable) {
    logger.warn("send.retryable", {
      messageId,
      enrollmentId: context.enrollmentId,
      step: context.step,
      reason: detail,
    });
    if (error instanceof ScoutError) throw error;
    throw new ScoutError(`Ambiguous provider failure: ${detail}`, {
      code: "vendor_unavailable",
      retryable: true,
      cause: error,
      context: { messageId },
    });
  }

  // A definite rejection: the provider did not accept the message.
  logger.error("send.failed", {
    messageId,
    enrollmentId: context.enrollmentId,
    step: context.step,
    reason: detail,
    retryable: false,
  });
  await markMessageFailed(messageId, detail);
  await context.releaseCounters?.();
  return { status: "failed", messageId, error: detail };
}

/**
 * Marks a message `sent` from a provider result. A database failure here keeps the
 * message `sending` and throws a retryable `ScoutError` so the next attempt reconciles
 * (review item 7: it must never be recorded as a send failure).
 */
async function recordMessageSent(message: Message, input: MarkSentInput): Promise<void> {
  try {
    await markMessageSent(message.id, input);
  } catch (error) {
    logger.error("send.record_failed", {
      messageId: message.id,
      enrollmentId: message.enrollmentId,
      step: message.step,
      reason: error instanceof Error ? error.message : "unknown",
    });
    throw new ScoutError(
      "The provider accepted the message but recording it failed; the next attempt will reconcile it by Message-ID.",
      { code: "conflict", retryable: true, cause: error, context: { messageId: message.id } },
    );
  }
}

// ---------------------------------------------------------------------------
// Threading (review item 10, sending half)
// ---------------------------------------------------------------------------

interface Threading {
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Review item 10: sending passes `In-Reply-To` = the anchor's `rfcMessageId` and
 * `References` = all prior `rfcMessageId`s for that enrollment. A first touch in a new
 * thread passes neither, so it starts a conversation instead of replying to one.
 */
async function resolveThreading(
  enrollmentId: string,
  step: SequenceStep | undefined,
  message: Message,
): Promise<Threading> {
  const sameThread = step?.thread === "same" || message.threadId !== null;
  if (!sameThread) {
    return { threadId: message.threadId, inReplyTo: null, references: [] };
  }

  const prior = await listSentRfcMessageIds(enrollmentId);
  const anchor = prior.length > 0 ? prior[prior.length - 1] ?? null : null;
  // Review item 10: a follow-up draft carries no `threadId` of its own, so the thread has
  // to come from the last sent message. Without this the Gmail adapter starts a brand new
  // thread and the follow-up lands outside the conversation the prospect already has.
  const anchorThread = await getThreadAnchor(enrollmentId);
  return { threadId: message.threadId ?? anchorThread.threadId, inReplyTo: anchor, references: prior };
}

// ---------------------------------------------------------------------------
// Capacity and pacing (section 7 rules 5, and review items 6 and 11)
// ---------------------------------------------------------------------------

interface CapacityContext {
  enrollmentId: string;
  channel: ChannelKind;
  step: number;
  stepKind: StepKind;
  contactId: string;
  messageId: string;
  /** B2: the slot already stored on this message (`messages.scheduled_for`), if any. */
  scheduledFor: Date | null;
  now: Date;
  /** True when a previous attempt already consumed this message's counters. */
  alreadyConsumed: boolean;
}

interface CapacityGate {
  outcome?: SendOutcome;
  account?: ConnectedAccount;
  /** Releases both counter buckets; undefined when nothing was consumed. */
  consumed?: () => Promise<void>;
}

/**
 * Rule 5: "The account's daily cap is not reached (atomic
 * `UPDATE send_counters … WHERE count < cap RETURNING`)." Both the `new` and the `total`
 * bucket are consumed, and both are released if the send never leaves the guard.
 *
 * Review item B2: pacing lives here too, but nobody wakes on the mailbox's shared
 * `next_send_at` any more. A message that has no slot reserves one atomically and the
 * reservation is stored on the message (`messages.scheduled_for`), so thirty enrollments
 * waking at 08:30 each own a distinct slot instead of colliding on one instant. Once a
 * message's own slot has arrived it sends without re-reading `next_send_at`, which by then
 * belongs to a later message's reservation.
 */
async function checkCapacity(context: CapacityContext): Promise<CapacityGate> {
  if (context.channel !== "email") return {};

  const settings = await getSettings();
  const account = await getPrimaryEmailAccount();
  if (!account) {
    return {
      outcome: block("config_incomplete", "No sending mailbox is connected. Connect the sending mailbox in Settings.", {
        messageId: context.messageId,
        nextAt: retryAt(context.now),
      }),
    };
  }

  const caps = emailCapsForWarmup(account.warmupStage, settings.caps);
  const date = dateOnlyInZone(context.now, settings.timezone);
  const isNew = context.stepKind === "first_touch";

  // The check half of rule 5 is a pure read, so a capped mailbox never touches a counter.
  if (!context.alreadyConsumed) {
    const counters = await getSendCounters(account.id, date);
    if (counters.total >= caps.totalSends) {
      return {
        outcome: block("daily_cap", `Daily total cap reached for ${account.handle} (${counters.total}/${caps.totalSends}).`, {
          messageId: context.messageId,
          nextAt: nextCounterDayStart(context.now, settings.timezone),
        }),
      };
    }
    if (isNew && counters.new >= caps.newConversations) {
      return {
        outcome: block(
          "daily_cap",
          `Daily new-conversation cap reached for ${account.handle} (${counters.new}/${caps.newConversations}).`,
          { messageId: context.messageId, nextAt: nextCounterDayStart(context.now, settings.timezone) },
        ),
      };
    }
  }

  // Review item B2: a message whose own slot has not arrived waits for it; the slot was
  // reserved on an earlier attempt and is stored on the message, so this attempt must not
  // touch `next_send_at` (that belongs to whatever reserved after us).
  const ownedSlot = context.scheduledFor;
  if (ownedSlot && ownedSlot.getTime() > context.now.getTime()) {
    return {
      outcome: block("pacing", `This message's reserved send slot is ${ownedSlot.toISOString()}.`, {
        messageId: context.messageId,
        nextAt: ownedSlot,
      }),
    };
  }

  if (!ownedSlot) {
    // No slot yet: take one atomically. `reserveSendSlot` serialises on the mailbox row, so
    // two enrollments waking together get consecutive slots rather than the same one.
    const spacing = spacingMinutesFor("email", isNew ? "new" : "followup");
    const reservation = await reserveSendSlot(account.id, jitterMs(spacing.min, spacing.max), context.now);
    // Store before deciding. If a racing attempt on the same message won the conditional
    // update, this returns that attempt's slot and we wait for it instead of consuming a
    // second slot from the mailbox queue.
    const slotAt = await storeMessageSendSlot(context.messageId, reservation.slotAt);
    if (slotAt.getTime() > context.now.getTime()) {
      return {
        outcome: block("pacing", `The mailbox reserved this message's send slot for ${slotAt.toISOString()}.`, {
          messageId: context.messageId,
          nextAt: slotAt,
        }),
      };
    }
  }

  // The consume half of rule 5 is the last side effect before the claim (review item 6).
  let consumedNew = false;
  if (!context.alreadyConsumed) {
    if (isNew) {
      const newResult = await consumeSendCounter({
        accountId: account.id,
        bucket: "new",
        cap: caps.newConversations,
        date,
      });
      if (!newResult.ok) {
        return {
          outcome: block(
            "daily_cap",
            `Daily new-conversation cap reached for ${account.handle} (${newResult.count}/${caps.newConversations}).`,
            { messageId: context.messageId, nextAt: nextCounterDayStart(context.now, settings.timezone) },
          ),
        };
      }
      consumedNew = true;
    }

    const totalResult = await consumeSendCounter({ accountId: account.id, bucket: "total", cap: caps.totalSends, date });
    if (!totalResult.ok) {
      if (consumedNew) {
        await releaseSendCounter({ accountId: account.id, bucket: "new", cap: caps.newConversations, date });
      }
      return {
        outcome: block("daily_cap", `Daily total cap reached for ${account.handle} (${totalResult.count}/${caps.totalSends}).`, {
          messageId: context.messageId,
          nextAt: nextCounterDayStart(context.now, settings.timezone),
        }),
      };
    }
  }

  await recordActivity({
    actor: "system",
    entityType: "contact",
    entityId: context.contactId,
    type: "message.sending",
    data: { enrollmentId: context.enrollmentId, step: context.step, channel: context.channel, newConversation: isNew },
  });

  return {
    account,
    ...(context.alreadyConsumed
      ? {}
      : {
          consumed: async () => {
            await releaseSendCounter({ accountId: account.id, bucket: "total", cap: caps.totalSends, date });
            if (isNew) await releaseSendCounter({ accountId: account.id, bucket: "new", cap: caps.newConversations, date });
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Message-ID and block helpers
// ---------------------------------------------------------------------------

/**
 * Review item 8: `<scout.${hmac(key)}@sender-domain>`. HMAC-ing the idempotency key with
 * ENCRYPTION_KEY means every retry of the same claim derives the same Message-ID, so
 * Gmail can be searched for it after an ambiguous failure.
 */
export function buildDeterministicMessageId(key: string, senderDomain: string): string {
  const digest = hashValue("scout-rfc-message-id", key).slice(0, 32);
  return `<scout.${digest}@${senderDomain}>`;
}

interface BlockOptions {
  messageId?: string;
  nextAt?: Date;
}

function block(rule: SendGuardRule, detail: string, options: BlockOptions = {}): SendOutcome {
  return {
    status: "blocked",
    rule,
    detail,
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.nextAt ? { nextAt: options.nextAt } : {}),
  };
}

/** Review item 9: blocks pause; the workflow decides when to look again. */
function retryAt(now: Date): Date {
  return new Date(now.getTime() + BLOCK_RETRY_MS);
}

/**
 * Section 9: "LinkedIn checkpoint, restriction, or repeated 422/429 errors: pause
 * LinkedIn automation for 7 days." Recorded here so the send path and the breaker agree.
 */
export async function recordChannelFailure(channel: ChannelKind, reason: string): Promise<void> {
  await recordActivity({
    actor: "system",
    entityType: "channel",
    entityId: channel,
    type: "message.failed",
    data: { reason, channel },
  });
}

export { SendGuardError };
