import { NextResponse } from "next/server";

import { getEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { logWebhookRejection, markWebhookProcessed, storeWebhookEvent, verifySharedSecret } from "@/src/lib/webhooks";
import { recordActivity } from "@/src/services/activity";
import { getLeadByEmail, setContactStage } from "@/src/services/leads";
import { notifyOwner } from "@/src/services/notifications";

/**
 * Section 5: "Meetings | Cal.com booking link; booking webhook moves the lead to
 * 'meeting' | API route."
 *
 * Cal.com signs the raw body with `x-cal-signature-256` (HMAC-SHA256 of the JSON payload,
 * hex). A shared secret in the URL is also accepted for a manual test call. Both are
 * compared in constant time.
 */

export const dynamic = "force-dynamic";

interface CalcomPayload {
  triggerEvent?: string;
  createdAt?: string;
  payload?: {
    title?: string;
    startTime?: string;
    endTime?: string;
    attendees?: Array<{ email?: string; name?: string; timeZone?: string }>;
    organizer?: { email?: string; name?: string };
    uid?: string;
    bookingId?: number | string;
    eventTypeId?: number;
  };
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();
  const raw = await request.text();

  const signature = request.headers.get("x-cal-signature-256");
  const secretOk = signature
    ? await verifyCalcomSignature(raw, signature, env.CALCOM_WEBHOOK_SECRET)
    : verifySharedSecret(request, { queryParam: "secret", expected: env.CALCOM_WEBHOOK_SECRET }).ok;

  if (!secretOk) {
    logWebhookRejection("calcom", "bad_secret", request);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: CalcomPayload;
  try {
    payload = JSON.parse(raw) as CalcomPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const bookingUid = payload.payload?.uid ?? String(payload.payload?.bookingId ?? "");
  const attendeeEmail = payload.payload?.attendees?.[0]?.email ?? null;
  const trigger = payload.triggerEvent ?? "BOOKING_CREATED";

  if (!bookingUid) {
    return NextResponse.json({ error: "No booking identifier in payload" }, { status: 400 });
  }

  const stored = await storeWebhookEvent({
    provider: "calcom",
    externalId: `${trigger}:${bookingUid}`,
    eventType: trigger,
    payload: payload as unknown as Record<string, unknown>,
  });

  if (stored.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    // The prospect is the attendee, not the organizer: match on the attendee address and
    // fall back to the organizer only when the booking was made by the owner.
    const lead = attendeeEmail ? await getLeadByEmail(attendeeEmail) : null;

    if (lead) {
      const stage = trigger === "BOOKING_CANCELLED" ? "replied" : "meeting";
      await setContactStage(lead.contact.id, stage);
      await recordActivity({
        actor: "system",
        entityType: "contact",
        entityId: lead.contact.id,
        type: "enrollment.transition",
        data: { reason: `calcom:${trigger}`, bookingUid, startTime: payload.payload?.startTime ?? null },
      });

      if (trigger !== "BOOKING_CANCELLED") {
        await notifyOwner({
          kind: "reply_hot",
          title: `${lead.contact.fullName} booked a meeting`,
          body: payload.payload?.startTime ? `Starts ${payload.payload.startTime}` : "A meeting was booked.",
          url: `/leads/${lead.contact.id}`,
          contactId: lead.contact.id,
          data: { bookingUid },
        });
      }
    }

    await markWebhookProcessed(stored.id);
    return NextResponse.json({ ok: true, matched: Boolean(lead) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "calcom_processing_failed";
    logger.error("webhook.calcom_failed", { reason: message });
    await markWebhookProcessed(stored.id, message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** Cal.com sends the hex HMAC-SHA256 of the raw body. */
export async function verifyCalcomSignature(rawBody: string, signature: string, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.trim().toLowerCase();
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
