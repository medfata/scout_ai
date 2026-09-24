import type { Notifier } from "@/src/ports/notifier";
import { createTelegramNotifier } from "./telegram";

/**
 * Notifiers are chosen by config, not by the caller (section 3, ports and adapters).
 * Telegram is the only v1 notifier; the digest-by-email notifier arrives in phase 5 and
 * is added to this array without touching any caller.
 */

export { TelegramNotifier, createTelegramNotifier } from "./telegram";

export function getNotifiers(): Notifier[] {
  const notifiers: Notifier[] = [];
  const telegram = createTelegramNotifier();
  if (telegram) notifiers.push(telegram);
  return notifiers;
}
