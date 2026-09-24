import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual, type CipherGCM, type DecipherGCM } from "node:crypto";

import { getEnv } from "@/src/lib/env";

/**
 * Secrets that must live in the database are encrypted with AES-256-GCM using
 * ENCRYPTION_KEY (section 8). Logs never contain keys, tokens or message bodies.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  return Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
}

/** Returns `iv.tag.ciphertext`, each part base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher: CipherGCM = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("Encrypted value is malformed; expected iv.tag.ciphertext");
  }
  const decipher: DecipherGCM = createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Deterministic, non-reversible fingerprint used to match suppressions without
 * keeping the plaintext forever (section 9: "The suppression list is kept, hashed").
 * Keyed with ENCRYPTION_KEY so the hashes are not brute-forceable offline.
 */
export function hashValue(kind: string, value: string): string {
  return createHmac("sha256", key()).update(`${kind}:${value}`).digest("hex");
}

/** Constant-time compare for webhook secrets (section 8). */
export function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Stable, short hash for dedupe keys that must be idempotent across runs. */
export function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
