import type { Alert, Notifier } from "@/src/ports/notifier";

/**
 * Section 10 rule 4: "Every port has a fake." Records every alert in memory so a test
 * can assert what the owner would have been told, with no Telegram call.
 */

export interface FakeNotifier extends Notifier {
  readonly alerts: Alert[];
  /** Makes the next `send` reject, to exercise the "never take down the caller" path. */
  failNextWith(error: Error): void;
  clear(): void;
}

export function createFakeNotifier(name = "fake-notifier"): FakeNotifier {
  const alerts: Alert[] = [];
  let nextError: Error | null = null;

  return {
    name,
    alerts,
    failNextWith(error) {
      nextError = error;
    },
    clear() {
      alerts.length = 0;
      nextError = null;
    },
    async send(alert) {
      if (nextError) {
        const error = nextError;
        nextError = null;
        throw error;
      }
      alerts.push(alert);
    },
  };
}
