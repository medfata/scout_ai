"use server";

import { revalidatePath } from "next/cache";

import { normalizeDomain, domainFromEmail } from "@/src/domain/suppression";
import { isLive } from "@/src/domain/enrollment";
import type { EnrollmentStatus } from "@/src/domain/types";
import { logger } from "@/src/lib/logger";
import { requireOwner } from "@/src/lib/session";
import { approveEnrollment, skipEnrollment, stopEnrollment } from "@/src/services/enrollment";
import { addSuppression } from "@/src/services/leads";
import { approveMessage, skipMessage, updateDraft } from "@/src/services/messages";
import type { InboxActionResult } from "@/components/inbox/types";

/**
 * Every mutation from the approval queue. Each action starts with `requireOwner()` from
 * `src/lib/session.ts`, so a request without the owner's session is redirected before any
 * database write.
 *
 * Section 10 rule 6: nothing here sends. Approval only marks a message `approved`; the
 * send path is `src/services/sending.ts`, and its guard runs at send time.
 */

export async function approveDraftMessage(input: {
  messageId: string;
  enrollmentId: string;
  enrollmentStatus: EnrollmentStatus;
  subject: string;
  body: string;
}): Promise<InboxActionResult> {
  await requireOwner();

  try {
    await updateDraft(input.messageId, {
      subject: input.subject.trim().length > 0 ? input.subject.trim() : null,
      body: input.body,
    });
    await approveMessage(input.messageId, "owner");

    // A first touch waiting for approval also activates its enrollment (section 5:
    // "pending_approval --> active: approved"). An already-active enrollment (follow-up)
    // is left to the sequencer.
    if (input.enrollmentStatus === "pending_approval") {
      await approveEnrollment(input.enrollmentId);
    }

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
  enrollmentStatus: EnrollmentStatus;
}): Promise<InboxActionResult> {
  await requireOwner();

  try {
    await skipMessage(input.messageId, "owner_skipped");

    // Section 5's diagram: skipping the first touch skips the enrollment too, so the lead
    // does not sit in the queue forever with no pending message.
    if (input.enrollmentStatus === "pending_approval" || input.enrollmentStatus === "drafted") {
      await skipEnrollment(input.enrollmentId, "owner_skipped_message");
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

    if (isLive(input.enrollmentStatus)) {
      await stopEnrollment(input.enrollmentId, "never_contact");
    }
    await skipMessage(input.messageId, "never_contact");

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
