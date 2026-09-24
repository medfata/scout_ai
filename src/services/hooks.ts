import type { LeadEvent } from "@/src/domain/types";
import { logger } from "@/src/lib/logger";

/**
 * Section 7: "It stores the inbound message and starts `replyWorkflow` … and then calls
 * `resumeHook("lead:<enrollmentId>", event)` so the sequence stops or reschedules."
 *
 * Hooks are defined next to the workflow that listens for them (`src/workflows/sequence.ts`)
 * so the payload type cannot drift between the sender and the receiver. This module is the
 * bridge that everything *outside* a workflow (webhooks, Server Actions, the classifier)
 * calls, and it never throws: a lead event with no sleeping sequence is a normal race,
 * not an error.
 */

export interface ResumeResult {
  resumed: boolean;
  reason?: string;
}

/** Wakes the sequence for this lead with a reply, accept, bounce or opt-out. */
export async function resumeLeadEvent(enrollmentId: string, event: LeadEvent): Promise<ResumeResult> {
  try {
    const { leadEventHook } = await import("@/src/workflows/sequence");
    const { leadEventToken } = await import("@/src/lib/ids");
    const hook = await leadEventHook.resume(leadEventToken(enrollmentId), event);
    if (!hook) return { resumed: false, reason: "no_sleeping_sequence" };
    return { resumed: true };
  } catch (error) {
    // A finished or cancelled run has no hook; the enrollment status already reflects
    // what happened, so this is informational.
    logger.warn("hook.resume_lead_event_failed", {
      enrollmentId,
      eventType: event.type,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { resumed: false, reason: "hook_not_found" };
  }
}

/** Wakes a sequence that is waiting for the owner to approve a step. */
export async function resumeApproval(enrollmentId: string, step: number, approved: boolean): Promise<ResumeResult> {
  try {
    const { approvalHook } = await import("@/src/workflows/sequence");
    const { approvalToken } = await import("@/src/lib/ids");
    const hook = await approvalHook.resume(approvalToken(enrollmentId, step), { approved });
    if (!hook) return { resumed: false, reason: "no_pending_approval" };
    return { resumed: true };
  } catch (error) {
    logger.warn("hook.resume_approval_failed", {
      enrollmentId,
      step,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { resumed: false, reason: "hook_not_found" };
  }
}
