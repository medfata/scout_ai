"use server";

import { revalidatePath } from "next/cache";

import { logger } from "@/src/lib/logger";
import { requireOwner } from "@/src/lib/session";
import { deleteContact } from "@/src/services/leads";
import { loadContactExport } from "./queries";

/**
 * Section 9: "Each contact page has Export and Delete buttons for data requests."
 * Both actions start with `requireOwner()`, and delete delegates to the soft-delete in
 * `src/services/leads.ts`, which also suppresses every channel the contact had.
 */

export async function exportContactAction(contactId: string) {
  await requireOwner();

  try {
    const data = await loadContactExport(contactId);
    if (!data) return { ok: false as const, error: "Contact not found." };
    return {
      ok: true as const,
      filename: `scout-contact-${contactId}.json`,
      json: JSON.stringify(data, null, 2),
    };
  } catch (error) {
    logger.error("leads.export_failed", { contactId, reason: reasonOf(error) });
    return { ok: false as const, error: reasonOf(error) };
  }
}

export async function deleteContactAction(contactId: string) {
  await requireOwner();

  try {
    await deleteContact(contactId);
    revalidatePath("/leads");
    revalidatePath("/inbox");
    revalidatePath("/settings");
    return { ok: true as const };
  } catch (error) {
    logger.error("leads.delete_failed", { contactId, reason: reasonOf(error) });
    return { ok: false as const, error: reasonOf(error) };
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
