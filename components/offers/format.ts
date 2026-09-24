/** Display helpers for the offer studio. No locale data leaves the server. */

export function formatCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.0001) return "<$0.0001";
  return `$${costUsd.toFixed(4)}`;
}

export function formatWhen(date: Date): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
