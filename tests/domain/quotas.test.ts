import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPS,
  dailyNewProspectQuota,
  emailCapsForWarmup,
  isWarmupComplete,
  WARMUP_RAMP,
  warmupWeekFor,
} from "@/src/domain";
import type { Caps } from "@/src/domain/types";

/**
 * Section 7: "5 → 10 → 20 → 30 over 4 weeks", then "30 new, 50 total". Section 0:
 * "5 (quality mode), never above 12". These are pure functions; the counters they read
 * live in `send_counters`.
 */

describe("emailCapsForWarmup", () => {
  it("follows the 5 → 10 → 20 → 30 ramp for weeks 1 to 4", () => {
    expect(WARMUP_RAMP).toEqual([5, 10, 20, 30]);

    for (const week of [1, 2, 3, 4] as const) {
      expect(emailCapsForWarmup(week, DEFAULT_CAPS), `week ${week}`).toEqual({
        newConversations: WARMUP_RAMP[week - 1],
        totalSends: WARMUP_RAMP[week - 1],
      });
    }
  });

  it("reaches the steady state of 30 new and 50 total from week 5", () => {
    expect(emailCapsForWarmup(5, DEFAULT_CAPS)).toEqual({ newConversations: 30, totalSends: 50 });
    expect(emailCapsForWarmup(12, DEFAULT_CAPS)).toEqual({ newConversations: 30, totalSends: 50 });
  });

  it("treats a warmup stage below week 1 as week 1", () => {
    expect(emailCapsForWarmup(0, DEFAULT_CAPS)).toEqual(emailCapsForWarmup(1, DEFAULT_CAPS));
  });

  it("never exceeds the caps the owner configured in settings", () => {
    const configured: Caps[] = [
      { emailNew: 30, emailTotal: 50, linkedinInvites: 10, linkedinMessages: 25, linkedinProfileLookups: 50 },
      { emailNew: 8, emailTotal: 12, linkedinInvites: 10, linkedinMessages: 25, linkedinProfileLookups: 50 },
      { emailNew: 1, emailTotal: 2, linkedinInvites: 10, linkedinMessages: 25, linkedinProfileLookups: 50 },
    ];

    for (const caps of configured) {
      for (let week = 0; week <= 12; week += 1) {
        const capped = emailCapsForWarmup(week, caps);
        expect(capped.newConversations, `week ${week} new`).toBeLessThanOrEqual(caps.emailNew);
        expect(capped.totalSends, `week ${week} total`).toBeLessThanOrEqual(caps.emailTotal);
        expect(capped.newConversations).toBeGreaterThan(0);
        expect(capped.totalSends).toBeGreaterThan(0);
      }
    }
  });

  it("clamps the week and reports when the ramp is over", () => {
    expect(warmupWeekFor(0)).toBe(1);
    expect(warmupWeekFor(3)).toBe(3);
    expect(warmupWeekFor(99)).toBe(WARMUP_RAMP.length + 1);
    expect(isWarmupComplete(4)).toBe(false);
    expect(isWarmupComplete(5)).toBe(true);
  });
});

describe("dailyNewProspectQuota", () => {
  it("caps the configured target at the hard ceiling and never goes negative", () => {
    expect(dailyNewProspectQuota(5, 12)).toBe(5);
    expect(dailyNewProspectQuota(12, 12)).toBe(12);
    expect(dailyNewProspectQuota(50, 12)).toBe(12);
    expect(dailyNewProspectQuota(-1, 12)).toBe(0);
  });
});
