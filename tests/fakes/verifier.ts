import type { EmailStatus } from "@/src/domain/types";
import type { EmailVerifier, VerifiedEmail } from "@/src/ports/email-verifier";

/**
 * Section 10 rule 4: "Every port has a fake." An in-memory verifier that answers from a
 * script instead of Reoon/ZeroBounce, and records every address it was asked about.
 */

export type FakeVerifierOutcome =
  | EmailStatus
  | Error
  | { status: EmailStatus; raw?: Record<string, unknown> };

export interface FakeVerifier extends EmailVerifier {
  readonly calls: string[];
  setOutcome(email: string, outcome: FakeVerifierOutcome): void;
  setDefaultOutcome(outcome: FakeVerifierOutcome): void;
}

export interface FakeVerifierOptions {
  name?: string;
  checksPerCall?: number;
  defaultOutcome?: FakeVerifierOutcome;
  outcomes?: Record<string, FakeVerifierOutcome>;
}

export function createFakeVerifier(options: FakeVerifierOptions = {}): FakeVerifier {
  const calls: string[] = [];
  const outcomes = new Map<string, FakeVerifierOutcome>(Object.entries(options.outcomes ?? {}));
  let fallback: FakeVerifierOutcome = options.defaultOutcome ?? "valid";

  function resolve(email: string): VerifiedEmail {
    const outcome = outcomes.get(email) ?? fallback;
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "string") return { email, status: outcome, provider: "fake", raw: {} };
    return { email, status: outcome.status, provider: "fake", raw: outcome.raw ?? {} };
  }

  return {
    name: options.name ?? "fake-verifier",
    checksPerCall: options.checksPerCall ?? 1,
    calls,
    setOutcome(email, outcome) {
      outcomes.set(email, outcome);
    },
    setDefaultOutcome(outcome) {
      fallback = outcome;
    },
    async verify(email) {
      calls.push(email);
      return resolve(email);
    },
  };
}
