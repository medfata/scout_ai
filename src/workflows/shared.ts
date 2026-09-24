/**
 * Small helpers shared by the workflows. Workflow bodies are deterministic (section 10
 * rule 8), so anything with a clock or randomness has to be called from a step and comes
 * from here.
 */

/** Milliseconds until a given ISO instant, floored at 0 so a stale slot does not sleep. */
export function millisUntil(iso: string, now: Date = new Date()): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, target - now.getTime());
}

/** A sleep duration in the SDK's `"30m"` form. */
export function startSleepMinutes(minutes: number): string {
  return `${Math.max(1, Math.round(minutes))}m`;
}

/** Section 7: spacing between sends is randomised inside a range, never a fixed gap. */
export function randomBetween(min: number, max: number, random: () => number = Math.random): number {
  return min + random() * Math.max(0, max - min);
}
