import type { Channel } from "@/src/ports/channel";
import { ConfigurationError } from "@/src/lib/errors";

/**
 * Assisted mode (section 0): Scout creates a task, the owner clicks send. There is no
 * automated LinkedIn channel in v1, and no unofficial LinkedIn API anywhere in this repo.
 *
 * Returning `null` is the correct v1 behaviour: the send guard turns it into a
 * `linkedin_not_available` skip and the sequence moves on. Phase 6 adds the owner task
 * queue and, behind the `LINKEDIN_MODE=automated` flag, a Unipile adapter.
 */
export function createManualLinkedinChannel(): Channel | null {
  return null;
}

export function assertNoLinkedInAutomation(): void {
  if (process.env.LINKEDIN_MODE === "automated") {
    throw new ConfigurationError(
      "LINKEDIN_MODE=automated is not implemented in v1. Section 0 locks LinkedIn to assisted mode; automated mode needs a provider adapter the owner has not approved.",
    );
  }
}
