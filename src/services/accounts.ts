import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/src/db/client";
import { connectedAccounts, type ConnectedAccount, type NewConnectedAccount } from "@/src/db/schema";
import type { AccountKind, AccountStatus, LinkedinMode } from "@/src/domain/types";
import { decryptSecret, encryptSecret } from "@/src/lib/crypto";
import { recordActivity } from "./activity";

/**
 * Section 5: `connected_accounts` holds "sending identities". Section 8: Scout never sees
 * a password; for v1 the only row is one Google Workspace mailbox linked through Scout's
 * own Internal OAuth app, plus an optional manual-linkedin row for assisted tasks.
 *
 * Tokens live encrypted with AES-256-GCM (section 8) and are never logged.
 */

export interface UpsertAccountInput {
  provider: string;
  kind: AccountKind;
  externalAccountId: string;
  handle: string;
  dailyCap?: number | null;
  warmupStage?: number;
  status?: AccountStatus;
  statusDetail?: string | null;
  credentials?: Record<string, unknown> | null;
}

export async function upsertAccount(input: UpsertAccountInput): Promise<ConnectedAccount> {
  const db = getDb();
  const values: NewConnectedAccount = {
    provider: input.provider,
    kind: input.kind,
    externalAccountId: input.externalAccountId,
    handle: input.handle,
    dailyCap: input.dailyCap ?? null,
    warmupStage: input.warmupStage ?? 0,
    warmupStartedAt: input.warmupStage && input.warmupStage > 0 ? new Date() : null,
    status: input.status ?? "ok",
    statusDetail: input.statusDetail ?? null,
    credentialsEncrypted: input.credentials ? encryptSecret(JSON.stringify(input.credentials)) : null,
  };

  const [row] = await db
    .insert(connectedAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [connectedAccounts.provider, connectedAccounts.externalAccountId],
      set: {
        handle: values.handle,
        ...(input.credentials ? { credentialsEncrypted: values.credentialsEncrypted } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.statusDetail !== undefined ? { statusDetail: input.statusDetail } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error("Connected account could not be saved.");
  await recordActivity({
    actor: "system",
    entityType: "connected_account",
    entityId: row.id,
    type: "account.connected",
    data: { provider: input.provider, kind: input.kind },
  });
  return row;
}

export async function listAccounts(kind?: AccountKind): Promise<ConnectedAccount[]> {
  const db = getDb();
  const base = db.select().from(connectedAccounts).orderBy(desc(connectedAccounts.createdAt));
  return kind ? base.where(eq(connectedAccounts.kind, kind)) : base;
}

/**
 * Section 7: "Email, per mailbox". v1 has exactly one mailbox, so the primary account is
 * the oldest healthy email account.
 */
export async function getPrimaryEmailAccount(): Promise<ConnectedAccount | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.kind, "email"), eq(connectedAccounts.status, "ok")))
    .orderBy(connectedAccounts.createdAt)
    .limit(1);
  return row ?? null;
}

export async function getAccount(accountId: string): Promise<ConnectedAccount | null> {
  const db = getDb();
  const [row] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).limit(1);
  return row ?? null;
}

/** Section 8, account health: `credentials`, `error` or `stopped` pauses the account. */
export async function setAccountStatus(accountId: string, status: AccountStatus, detail?: string | null): Promise<void> {
  const db = getDb();
  await db
    .update(connectedAccounts)
    .set({ status, statusDetail: detail ?? null, updatedAt: new Date() })
    .where(eq(connectedAccounts.id, accountId));
  await recordActivity({
    actor: "system",
    entityType: "connected_account",
    entityId: accountId,
    type: "account.status_changed",
    data: { status, detail: detail ?? null },
  });
}

export async function setWarmupStage(accountId: string, stage: number): Promise<void> {
  const db = getDb();
  await db
    .update(connectedAccounts)
    .set({ warmupStage: stage, warmupStartedAt: new Date(), updatedAt: new Date() })
    .where(eq(connectedAccounts.id, accountId));
}

export async function markAccountWarmupStart(accountId: string): Promise<void> {
  const db = getDb();
  await db
    .update(connectedAccounts)
    .set({ warmupStartedAt: new Date(), warmupStage: 1, updatedAt: new Date() })
    .where(eq(connectedAccounts.id, accountId));
}

export async function readAccountCredentials<T extends Record<string, unknown>>(account: ConnectedAccount): Promise<T | null> {
  if (!account.credentialsEncrypted) return null;
  try {
    return JSON.parse(decryptSecret(account.credentialsEncrypted)) as T;
  } catch {
    // A rotated ENCRYPTION_KEY makes old rows unreadable; surface it as "reconnect".
    await setAccountStatus(account.id, "credentials", "Stored credentials could not be decrypted. Reconnect the account.");
    return null;
  }
}

export async function getEmailAccountForSend(): Promise<ConnectedAccount> {
  const account = await getPrimaryEmailAccount();
  if (!account) {
    throw new Error("No email account is connected. Connect the sending mailbox in Settings before sending.");
  }
  return account;
}

export function linkedinModeFromEnv(mode: LinkedinMode): LinkedinMode {
  return mode;
}
