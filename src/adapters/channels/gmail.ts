import type { Channel } from "@/src/ports/channel";
import { ConfigurationError } from "@/src/lib/errors";

/**
 * PLACEHOLDER — replaced by the phase 4 implementation in this same file.
 *
 * Gmail API send through the Internal OAuth app (section 8). It must:
 *   - read the primary email account from `connected_accounts` and decrypt its tokens
 *   - refresh the access token when expired, and mark the account `credentials` on failure
 *   - send plain text through `users.messages.send`, keeping the thread id and Message-ID
 *   - honour DRY_RUN by rewriting the recipient (the guard already does this, the adapter
 *     must not undo it)
 *
 * Until then it fails loudly rather than pretending to send.
 */
export function createGmailChannel(): Channel | null {
  throw new ConfigurationError(
    "The Gmail channel is not implemented yet (phase 4). Connect a mailbox and finish the adapter before sending.",
  );
}
