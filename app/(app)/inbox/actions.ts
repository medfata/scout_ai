"use server";

import { revalidatePath } from "next/cache";

import { normalizeDomain, domainFromEmail } from "@/src/domain/suppression";
import { isLive } from "@/src/domain/enrollment";
import type { EnrollmentStatus } from "@/src/domain/types";
import { logger } from "@/src/lib/logger";
import { requireOwner } from "@/src/lib/session";
import {
  activateEnrollment,
  approveEnrollment,
  getEnrollment,
  skipEnrollment,
  stopEnrollment,
} from "@/src/services/enrollment";
import { resumeApproval } from "@/src/services/hooks";
import { addSuppression } from "@/src/services/leads";
import { approveMessage, getMessage, skipMessage, updateDraft } from "@/src/services/messages";
import type { InboxActionResult } from "@/components/inbox/types";

/**
 * Every mutation from the approval queue. Each action starts with `requireOwner()` from
 * `src/lib/session.ts`, so a request without the owner's session is redirected before any
 * database write.
 *
 * Section 10 rule 6: nothing here sends. Approval only marks a message `approved` and
 * wakes the enrollment's durable run (review item 1); the send path is
 * `src/services/sending.ts`, and its guard runs at send time.
 *
 * The `enrollmentStatus` field is still in the client's payload, but every action reads
 * the status from the database instead (review item 3): a stale tab must never be able to
 * activate or skip an enrollment that has already moved on.
 */

export async function approveDraftMessage(input: {
  messageId: string;
  enrollmentId: string;
  /** Retained for the client's payload shape; the database row is the authority. */
  enrollmentStatus: EnrollmentStatus;
  subject: string;
  body: string;
}): Promise<InboxActionResult> {
  await requireOwner();

  try {
    const message = await getMessage(input.messageId);
    const enrollment = await getEnrollment(input.enrollmentId);
    if (!message || !enrollment || message.enrollmentId !== enrollment.id) {
      return { ok: false, error: "That draft does not belong to this enrollment." };
    }

    // Review item 3: `updateDraft` may only touch a message that is still waiting. A
    // message that was approved, sent or skipped meanwhile must not be edited.
    if (message.status !== "drafted" && message.status !== "pending_approval") {
      return { ok: false, error: `The message is "${message.status}"; only a waiting draft can be approved.` };
    }

    if (input.body.trim().length === 0) {
      // A failed LLM validation persists an empty `needs_owner` row (review item 5).
      // Approving it unchanged would send an empty email.
      return { ok: false, error: "The draft is empty. Write the message before approving." };
    }

    await updateDraft(message.id, {
      subject: input.subject.trim().length > 0 ? input.subject.trim() : null,
      body: input.body,
    });
    await approveMessage(message.id, "owner");

    // Section 5: "pending_approval --> active: approved". Starting the durable run is
    // what makes the approved first touch actually send (review item 1); the atomic claim
    // inside `activateEnrollment` makes this safe to call twice.
    if (enrollment.status === "pending_approval") {
      await approveEnrollment(enrollment.id);
      await activateEnrollment(enrollment.id);
    }

    // Review item 3: wake a run that is already sleeping on this step's approval hook.
    // If the hook was not registered yet, the run's post-hook re-read finds the approval.
    await resumeApproval(enrollment.id, message.step, true);

    revalidatePath("/inbox");
    revalidatePath("/leads");
    return { ok: true };
  } catch (error) {
    logger.error("inbox.approve_failed", { messageId: input.messageId, reason: reasonOf(error) });
    return { ok: false, error: reasonOf(error) };
  }
}

export async function skipDraftMessage(input: {
  messageId: string;
  enrollmentId: string;
  /** Retained for the client's payload shape; the database row is the authority. */
  enrollmentStatus: EnrollmentStatus;
}): Promise<InboxActionResult> {
  await requireOwner();

  try {
    const message = await getMessage(input.messageId);
    const enrollment = await getEnrollment(input.enrollmentId);
    if (!message || !enrollment || message.enrollmentId !== enrollment.id) {
      return { ok: false, error: "That draft does not belong to this enrollment." };
    }
    if (message.status !== "drafted" && message.status !== "pending_approval") {
      return { ok: false, error: `The message is "${message.status}"; only a waiting draft can be skipped.` };
    }

    await skipMessage(message.id, "owner_skipped");

    // Tell a sleeping run that this step is over now instead of leaving it in the
    // three-day approval window.
    await resumeApproval(enrollment.id, message.step, false);

    // Section 5's diagram: skipping the first touch skips the enrollment too, so the lead
    // does not sit in the queue forever with no pending message.
    if (enrollment.status === "pending_approval" || enrollment.status === "drafted") {
      await skipEnrollment(enrollment.id, "owner_skipped_message");
    }

    revalidatePath("/inbox");
    revalidatePath("/leads");
    return { ok: true };
  } catch (error) {
    logger.error("inbox.skip_failed", { messageId: input.messageId, reason: reasonOf(error) });
    return { ok: false, error: reasonOf(error) };
  }
}

export async function neverContactLead(input: {
  messageId: string;
  enrollmentId: string;
  /** Retained for the client's payload shape; the database row is the authority. */
  enrollmentStatus: EnrollmentStatus;
  email: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
}): Promise<InboxActionResult> {
  await requireOwner();

  try {
    // Section 9: "Opt-outs go to `suppressions` instantly and permanently." All three
    // kinds are added so no channel can reach this person again.
    const email = input.email?.trim() ?? null;
    if (email) {
      await addSuppression({ kind: "email", value: email, reason: "owner_never_contact" });
    }

    const domainValue = input.companyDomain ?? (email ? domainFromEmail(email) : null);
    if (domainValue) {
      await addSuppression({ kind: "domain", value: normalizeDomain(domainValue), reason: "owner_never_contact" });
    }

    if (input.linkedinUrl) {
      await addSuppression({ kind: "linkedin", value: input.linkedinUrl, reason: "owner_never_contact" });
    }

    const [message, enrollment] = await Promise.all([getMessage(input.messageId), getEnrollment(input.enrollmentId)]);
    if (message && enrollment && message.enrollmentId !== enrollment.id) {
      return { ok: false, error: "That draft does not belong to this enrollment." };
    }
    if (enrollment && isLive(enrollment.status)) {
      await stopEnrollment(enrollment.id, "never_contact");
    }
    if (message) {
      await skipMessage(message.id, "never_contact");
      // Release a sleeping approval hook so the run notices immediately.
      await resumeApproval(message.enrollmentId ?? input.enrollmentId, message.step, false);
    }

    revalidatePath("/inbox");
    revalidatePath("/leads");
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    logger.error("inbox.never_contact_failed", { enrollmentId: input.enrollmentId, reason: reasonOf(error) });
    return { ok: false, error: reasonOf(error) };
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
