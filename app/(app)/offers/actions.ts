"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/components/offers/action-state";
import { QuotaExceededError } from "@/src/lib/errors";
import { requireOwner } from "@/src/lib/session";
import { SIZE_BANDS, type SizeBand } from "@/src/domain/types";
import { approveIcp, archiveIcp, generateIcpsForOffer, pauseIcp, updateIcp } from "@/src/services/icps";
import { archiveOffer, createOffer, updateOffer } from "@/src/services/offers";

/**
 * Section 8: "Server Actions re-check the session." Every mutation starts with
 * `requireOwner()`; the middleware and the layout are not trusted on their own.
 */

export async function createOfferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireOwner();

  let offerId: string;
  try {
    const offer = await createOffer({
      title: text(formData, "title"),
      description: text(formData, "description"),
      priceHint: text(formData, "priceHint"),
      proof: readProofRows(formData),
    });
    offerId = offer.id;
  } catch (error) {
    return failure(error);
  }

  revalidatePath("/offers");
  redirect(`/offers/${offerId}`);
}

export async function updateOfferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireOwner();
  const offerId = text(formData, "offerId");

  try {
    await updateOffer(offerId, {
      title: text(formData, "title"),
      description: text(formData, "description"),
      priceHint: text(formData, "priceHint"),
      proof: readProofRows(formData),
    });
  } catch (error) {
    return failure(error);
  }

  revalidatePath("/offers");
  revalidatePath(`/offers/${offerId}`);
  return { status: "ok", message: "Offer saved." };
}

export async function archiveOfferAction(formData: FormData): Promise<void> {
  await requireOwner();
  const offerId = text(formData, "offerId");
  await archiveOffer(offerId);
  revalidatePath("/offers");
  revalidatePath(`/offers/${offerId}`);
}

export async function generateIcpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireOwner();
  const offerId = text(formData, "offerId");

  try {
    const run = await generateIcpsForOffer(offerId);
    revalidatePath("/offers");
    revalidatePath(`/offers/${offerId}`);

    const dropped = run.dropped.length > 0 ? ` ${run.dropped.length} candidate(s) dropped by the critic.` : "";
    return {
      status: "ok",
      message: `Generated ${run.icps.length} ranked ICPs for $${run.usage.costUsd.toFixed(4)} (${run.usage.model}).${dropped}`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function updateIcpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireOwner();
  const icpId = text(formData, "icpId");
  const offerId = text(formData, "offerId");

  try {
    await updateIcp(icpId, {
      name: text(formData, "name"),
      rationale: text(formData, "rationale"),
      pains: lines(formData, "pains"),
      titles: lines(formData, "titles"),
      industries: lines(formData, "industries"),
      geos: lines(formData, "geos"),
      disqualifiers: lines(formData, "disqualifiers"),
      sizeBands: readSizeBands(formData),
      angles: readAngles(formData),
    });
  } catch (error) {
    return failure(error);
  }

  revalidatePath(`/offers/${offerId}`);
  return { status: "ok", message: "ICP saved." };
}

export async function approveIcpAction(formData: FormData): Promise<void> {
  await requireOwner();
  const icp = await approveIcp(text(formData, "icpId"));
  revalidatePath(`/offers/${icp.offerId}`);
  revalidatePath("/offers");
}

export async function pauseIcpAction(formData: FormData): Promise<void> {
  await requireOwner();
  const icp = await pauseIcp(text(formData, "icpId"));
  revalidatePath(`/offers/${icp.offerId}`);
  revalidatePath("/offers");
}

export async function archiveIcpAction(formData: FormData): Promise<void> {
  await requireOwner();
  const icp = await archiveIcp(text(formData, "icpId"));
  revalidatePath(`/offers/${icp.offerId}`);
  revalidatePath("/offers");
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function lines(formData: FormData, key: string): string[] {
  return text(formData, key)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readProofRows(formData: FormData): Array<{ label: string; detail: string; url: string }> {
  const labels = formData.getAll("proofLabel").map(String);
  const details = formData.getAll("proofDetail").map(String);
  const urls = formData.getAll("proofUrl").map(String);

  return labels
    .map((label, index) => ({
      label: label.trim(),
      detail: (details[index] ?? "").trim(),
      url: (urls[index] ?? "").trim(),
    }))
    .filter((row) => row.label.length > 0 || row.detail.length > 0 || row.url.length > 0);
}

function readSizeBands(formData: FormData): SizeBand[] {
  const allowed = new Set<string>(SIZE_BANDS);
  return formData
    .getAll("sizeBands")
    .map(String)
    .filter((value): value is SizeBand => allowed.has(value));
}

function readAngles(formData: FormData): Array<{ key: string; hook: string }> {
  const keys = formData.getAll("angleKey").map(String);
  const hooks = formData.getAll("angleHook").map(String);

  return keys
    .map((key, index) => ({ key: key.trim(), hook: (hooks[index] ?? "").trim() }))
    .filter((angle) => angle.key.length > 0 && angle.hook.length > 0);
}

function failure(error: unknown): ActionState {
  if (error instanceof QuotaExceededError) {
    return {
      status: "error",
      message: "AI budget for today is used up. Generation resumes when the budget resets tomorrow.",
    };
  }
  return {
    status: "error",
    message: error instanceof Error ? error.message : "Something went wrong. Nothing was saved.",
  };
}
