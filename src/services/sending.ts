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
import { getChannel } from "@/src/adapters/channels";
import { getEnv } from "@/src/lib/env";
import { SendGuardError, type SendGuardRule } from "@/src/lib/errors";
import { idempotencyKey } from "@/src/lib/ids";
import { logger } from "@/src/lib/logger";
import { dateOnlyInZone, isWithinWindow, nextWindowStart } from "@/src/lib/time-windows";
import { recordActivity } from "./activity";
import { getEmailAccountForSend } from "./accounts";
import { loadSequencePlan } from "./enrollment";
import {
  claimMessageForSend,
  getMessageByIdempotencyKey,
  hasUnresolvedInbound,
  markMessageFailed,
  markMessageSent,
  releaseMessage,
} from "./messages";
import { consumeSendCounter, getSendCounters, releaseSendCounter } from "./quota";
import { getSettings } from "./settings";
import { loadSuppressionEntries } from "./leads";

/**
 * Section 7: "Send guard — `sendMessage` checks these in order and aborts on the first
 * failure." Section 10 rule 6: "One send path. Nothing sends except `sendMessage` and its
 * guard; each guard rule has a test."
 *
 * Every rule below throws `SendGuardError` with the rule name, so a blocked send is
 * always explainable in the UI and in `activity_events`.
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

export async function sendMessage(input: SendMessageInput): Promise<SendOutcome> {
  const env = getEnv();
  const settings = await getSettings();
  const now = new Date();

  // --- rule 1: kill switch -------------------------------------------------
  if (settings.killSwitch) {
    return block("kill_switch", "The kill switch is on; every send is blocked.");
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
  const suppressions = await loadSuppressionEntries();
  if (isSuppressed(target, suppressions)) {
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
  const hasInbound = await hasUnresolvedInbound(plan.lead.contactId, plan.enrollment.startedAt ?? plan.enrollment.createdAt);
  if (hasInbound) {
    return block("unclassified_inbound", "The lead has an inbound message that is not resolved; sends are paused.");
  }

  // --- eligibility (email must be valid, LinkedIn needs a URL) --------------
  if (input.stepDefinition) {
    const eligibility = resolveStepEligibility(input.stepDefinition, plan.lead, {
      linkedinAutomationEnabled: env.LINKEDIN_MODE === "automated",
      now,
    });
    if (!eligibility.eligible) {
      return { status: "skipped", messageId: null, reason: eligibility.reason ?? "not_eligible" };
    }
  }

  // --- the message must exist and be approved ------------------------------
  const key = idempotencyKey(input.enrollmentId, input.step, input.channel);
  const message = await getMessageByIdempotencyKey(key);
  if (!message) {
    return { status: "blocked", rule: "not_approved", detail: `No message exists for ${key}. Prepare it before sending.` };
  }
  if (message.status === "sent" || message.sentAt) {
    // Rule 8, first half: a retried step finds the message already sent.
    return { status: "skipped", messageId: message.id, reason: "already_sent" };
  }

  const gate = await checkCapacity(
    plan.enrollment.id,
    input.channel,
    input.step,
    input.stepDefinition?.kind ?? (input.step === 0 ? "first_touch" : "follow_up"),
    plan.lead.contactId,
    now,
  );
  if (gate.outcome) return gate.outcome;

  // --- rule 6: sending window ---------------------------------------------
  const timeZone = plan.lead.contact.timezone ?? settings.timezone;
  const window = input.channel === "email" ? settings.sendingWindows.email : settings.sendingWindows.linkedin;
  if (!isWithinWindow(now, timeZone, window)) {
    return {
      status: "blocked",
      rule: "sending_window",
      detail: `Outside the ${input.channel} sending window for ${timeZone}.`,
      nextAt: nextWindowStart(now, timeZone, window),
      messageId: message.id,
    };
  }

  // --- rule 7: the message is approved ------------------------------------
  if (message.status !== "approved") {
    return {
      status: "blocked",
      rule: "not_approved",
      detail: `Message status is "${message.status}"; it must be approved before it can send.`,
      messageId: message.id,
    };
  }

  // --- rule 8: claim, send, record ----------------------------------------
  const claimed = await claimMessageForSend(message.id);
  if (!claimed) {
    const latest = await getMessageByIdempotencyKey(key);
    if (latest?.status === "sent") return { status: "skipped", messageId: latest.id, reason: "already_sent" };
    return block("idempotency", "Another worker claimed this message first.", latest?.id);
  }

  const channel = getChannel(input.channel);
  if (!channel) {
    await releaseMessage(message.id);
    return { status: "skipped", messageId: message.id, reason: "linkedin_not_available" };
  }

  const isTest = env.DRY_RUN;
  const redirect = isTest ? env.DRY_RUN_REDIRECT_EMAIL ?? null : null;
  if (isTest && input.channel === "email" && !redirect) {
    await releaseMessage(message.id);
    return block(
      "kill_switch",
      "DRY_RUN is on but DRY_RUN_REDIRECT_EMAIL is not set, so there is nowhere safe to send. Set the redirect address.",
      message.id,
    );
  }

  try {
    const result = await channel.send({
      to: input.channel === "email" ? redirect ?? plan.lead.email! : plan.lead.linkedinUrl!,
      subject: message.subject,
      body: message.body,
      threadId: message.threadId,
      inReplyTo: null,
      references: [],
      dryRunRedirect: redirect,
      isTest,
    });

    await markMessageSent(message.id, {
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

    return { status: "sent", messageId: message.id, providerMessageId: result.providerMessageId, redirected: result.redirected };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown provider error";
    logger.error("send.failed", { enrollmentId: input.enrollmentId, step: input.step, reason: detail });
    await markMessageFailed(message.id, detail);
    if (gate.consumed) await gate.consumed();
    return { status: "failed", messageId: message.id, error: detail };
  }
}

/**
 * Rule 5: "The account's daily cap is not reached (atomic
 * `UPDATE send_counters … WHERE count < cap RETURNING`)." Both the `new` and the `total`
 * bucket are consumed, and both are released if the provider call fails outright.
 */
async function checkCapacity(
  enrollmentId: string,
  channel: ChannelKind,
  step: number,
  stepKind: StepKind,
  contactId: string,
  now: Date,
): Promise<{ outcome?: SendOutcome; consumed?: () => Promise<void> }> {
  if (channel !== "email") return {};

  const settings = await getSettings();
  const account = await getEmailAccountForSend();
  const caps = emailCapsForWarmup(account.warmupStage, settings.caps);
  const date = dateOnlyInZone(now, settings.timezone);
  const isNew = stepKind === "first_touch";

  const counters = await getSendCounters(account.id, date);
  if (counters.total >= caps.totalSends) {
    return {
      outcome: {
        status: "blocked",
        rule: "daily_cap",
        detail: `Daily total cap reached for ${account.handle} (${counters.total}/${caps.totalSends}).`,
      },
    };
  }
  if (isNew && counters.new >= caps.newConversations) {
    return {
      outcome: {
        status: "blocked",
        rule: "daily_cap",
        detail: `Daily new-conversation cap reached for ${account.handle} (${counters.new}/${caps.newConversations}).`,
      },
    };
  }

  if (isNew) {
    const newResult = await consumeSendCounter({ accountId: account.id, bucket: "new", cap: caps.newConversations, date });
    if (!newResult.ok) {
      return {
        outcome: {
          status: "blocked",
          rule: "daily_cap",
          detail: `Daily new-conversation cap reached for ${account.handle} (${newResult.count}/${caps.newConversations}).`,
        },
      };
    }
  }

  const totalResult = await consumeSendCounter({ accountId: account.id, bucket: "total", cap: caps.totalSends, date });
  if (!totalResult.ok) {
    if (isNew) await releaseSendCounter({ accountId: account.id, bucket: "new", cap: caps.newConversations, date });
    return {
      outcome: {
        status: "blocked",
        rule: "daily_cap",
        detail: `Daily total cap reached for ${account.handle} (${totalResult.count}/${caps.totalSends}).`,
      },
    };
  }

  await recordActivity({
    actor: "system",
    entityType: "contact",
    entityId: contactId,
    type: "message.sending",
    data: { enrollmentId, step, channel, newConversation: isNew },
  });

  return {
    consumed: async () => {
      await releaseSendCounter({ accountId: account.id, bucket: "total", cap: caps.totalSends, date });
      if (isNew) await releaseSendCounter({ accountId: account.id, bucket: "new", cap: caps.newConversations, date });
    },
  };
}

function block(rule: SendGuardRule, detail: string, messageId?: string): SendOutcome {
  return { status: "blocked", rule, detail, ...(messageId ? { messageId } : {}) };
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
