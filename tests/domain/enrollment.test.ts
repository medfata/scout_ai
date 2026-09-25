import { describe, expect, it } from "vitest";

import {
  ENROLLMENT_STATUSES,
  ENROLLMENT_TRANSITIONS,
  IllegalEnrollmentTransitionError,
  assertTransition,
  canTransition,
  isLive,
  isTerminal,
} from "@/src/domain";
import type { EnrollmentStatus } from "@/src/domain/types";

/**
 * Section 5: "Allowed transitions live in one typed map in `src/domain/enrollment.ts`;
 * any other transition throws." This file proves the map is closed: every pair of the
 * eight statuses is legal or throws, so a caller cannot move a lead into a state the
 * sequence does not understand.
 */

describe("enrollment transition map", () => {
  it("allows exactly the pairs in ENROLLMENT_TRANSITIONS and throws on every other pair", () => {
    let legalCount = 0;

    for (const from of ENROLLMENT_STATUSES) {
      for (const to of ENROLLMENT_STATUSES) {
        const legal = ENROLLMENT_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(legal);

        if (legal) {
          legalCount += 1;
          expect(() => assertTransition(from, to), `${from} -> ${to} should be legal`).not.toThrow();
        } else {
          expect(() => assertTransition(from, to), `${from} -> ${to} should throw`).toThrow(
            IllegalEnrollmentTransitionError,
          );
        }
      }
    }

    // 8 statuses: the map is not accidentally empty.
    expect(legalCount).toBeGreaterThan(0);
    expect(legalCount).toBeLessThan(ENROLLMENT_STATUSES.length * ENROLLMENT_STATUSES.length);
  });

  it("names both ends of an illegal transition on the error", () => {
    const error = captureTransitionError("drafted", "replied");

    expect(error.from).toBe("drafted");
    expect(error.to).toBe("replied");
    expect(error.name).toBe("IllegalEnrollmentTransitionError");
  });

  it("gives every terminal status no way out", () => {
    for (const status of ENROLLMENT_STATUSES) {
      if (!isTerminal(status)) continue;
      expect(ENROLLMENT_TRANSITIONS[status], status).toEqual([]);
    }
  });

  it("partitions every status into live or terminal", () => {
    for (const status of ENROLLMENT_STATUSES) {
      expect(isLive(status)).toBe(!isTerminal(status));
    }
  });

  it("lets a lead flow through the happy path and back to active from waiting", () => {
    const happyPath: EnrollmentStatus[] = ["drafted", "pending_approval", "active", "waiting", "active", "completed"];

    for (let index = 0; index < happyPath.length - 1; index += 1) {
      const from = happyPath[index];
      const to = happyPath[index + 1];
      if (from === undefined || to === undefined) throw new Error("happy path is malformed");
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });
});

function captureTransitionError(from: EnrollmentStatus, to: EnrollmentStatus): IllegalEnrollmentTransitionError {
  try {
    assertTransition(from, to);
  } catch (error) {
    if (error instanceof IllegalEnrollmentTransitionError) return error;
    throw error;
  }
  throw new Error(`Expected ${from} -> ${to} to throw`);
}
