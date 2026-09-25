/**
 * Result shapes shared by the settings server actions and the client form. Server actions
 * never throw at the owner: they return one of these so the section that failed can show
 * the message without losing the rest of the page (same pattern as `components/offers/action-state.ts`).
 */

/** `useActionState` shape for the settings forms. */
export interface SettingsActionState {
  status: "idle" | "ok" | "error";
  message: string;
}

export const IDLE_SETTINGS_STATE: SettingsActionState = { status: "idle", message: "" };

/** Shape for the single-value mutations (kill switch, autonomy, suppression removal). */
export interface SettingsMutationResult {
  ok: boolean;
  error?: string;
}
