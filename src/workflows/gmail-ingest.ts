import { start } from "workflow/api";

import { ingestGmailHistory, type GmailIngestResult } from "@/src/services/gmail-inbound";
import { replyWorkflow } from "./reply";

/**
 * Section 7's inbound path: a Pub/Sub push carries only a `historyId`, so the actual mail
 * has to be fetched. Splitting it into a workflow keeps the webhook route fast (Google
 * retries a slow push endpoint) and makes the fetch retryable on its own.
 */

export interface GmailIngestWorkflowResult extends GmailIngestResult {
  replyRuns: string[];
}

export async function gmailIngestWorkflow(historyId: string): Promise<GmailIngestWorkflowResult> {
  "use workflow";

  const ingested = await ingestStep(historyId);
  const replyRuns = await startReplyRunsStep(ingested.messageIds);
  return { ...ingested, replyRuns };
}

async function ingestStep(historyId: string): Promise<GmailIngestResult> {
  "use step";
  return ingestGmailHistory(historyId);
}

/**
 * Review item 16: `start()` from inside a step is supported, but a step retries, so this
 * loop can enqueue the same message twice. That is safe: `replyWorkflow` claims the
 * message atomically before classifying it, and a losing run is a no-op.
 */
async function startReplyRunsStep(messageIds: string[]): Promise<string[]> {
  "use step";

  const runs: string[] = [];
  for (const messageId of messageIds) {
    const run = await start(replyWorkflow, [messageId]);
    runs.push(run.runId);
  }
  return runs;
}
