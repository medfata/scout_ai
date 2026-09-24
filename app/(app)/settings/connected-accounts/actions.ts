"use server";

import { redirect } from "next/navigation";

import { requireOwner } from "@/src/lib/session";
import { getAccount } from "@/src/services/accounts";

/**
 * Section 8: "A status of `credentials`, `error` or `stopped` pauses that account and
 * alerts the owner with a Reconnect button." The button posts here (so the mutation is
 * owner-authenticated), then hands over to the same OAuth route as a first connection.
 */

export async function reconnectAccount(formData: FormData): Promise<void> {
  await requireOwner();

  const accountId = formData.get("accountId");
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Reconnect was called without an account id.");
  }

  const account = await getAccount(accountId);
  if (!account) {
    throw new Error("That account no longer exists. Reload the page and try again.");
  }

  // Google has no reconnect parameter; the normal flow runs and the existing row is
  // updated by `externalAccountId` (section 8).
  redirect(`/api/oauth/gmail?reconnect=${encodeURIComponent(account.id)}`);
}
