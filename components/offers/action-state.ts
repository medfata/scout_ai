/**
 * Shared result shape for every `useActionState` form in the offer studio. Server
 * actions never throw at the owner: they return this so the form can show the message.
 */
export interface ActionState {
  status: "idle" | "ok" | "error";
  message: string;
}

export const IDLE_ACTION_STATE: ActionState = { status: "idle", message: "" };
