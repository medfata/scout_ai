import { REPLIES_A } from "./replies-a";
import { REPLIES_B } from "./replies-b";
import type { LabelledReply } from "./types";

/** 34 labelled replies: three per intent, including OOO with and without a date, a bounce DSN and a polite unsubscribe. */
export const GOLDEN_REPLIES: readonly LabelledReply[] = [...REPLIES_A, ...REPLIES_B];

const BY_ID: ReadonlyMap<string, LabelledReply> = new Map(GOLDEN_REPLIES.map((reply) => [reply.id, reply]));

export const GOLDEN_REPLY_BY_ID = BY_ID;

export function replyById(id: string): LabelledReply {
  const reply = BY_ID.get(id);
  if (!reply) {
    throw new Error(`Unknown labelled reply "${id}". Known ids: ${[...BY_ID.keys()].join(", ")}`);
  }
  return reply;
}
