import { describe, expect, it } from "vitest";

import { DEFAULT_SENDING_WINDOWS } from "@/src/domain";
import type { SendingWindow } from "@/src/domain/types";
import { dateOnlyInZone, isWithinWindow, nextWindowStart } from "@/src/lib/time-windows";
import { nextCounterDayStart } from "@/src/services/quota";

/**
 * Section 7: email sends inside "Mon–Fri 08:30–16:30, recipient's time zone".
 *
 * The window is wall-clock time in the recipient's zone, so it has to move with DST.
 * Europe/Berlin's 2026 transitions are 29 March (clocks forward) and 25 October (clocks
 * back); every instant below is fixed, so these tests do not depend on when they run.
 *
 * `nextCounterDayStart` is pure arithmetic (review item 12); it lives in
 * `src/services/quota.ts` but reads no database, so it is tested here with the windows.
 */

/** Monday to Friday, 08:30–16:30 (section 7). */
const EMAIL_WINDOW: SendingWindow = DEFAULT_SENDING_WINDOWS.email;

describe("isWithinWindow", () => {
  it("includes the start minute and excludes the end minute", () => {
    // Berlin is UTC+1 (CET) on 27 March 2026.
    expect(isWithinWindow(new Date("2026-03-27T07:29:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(false);
    expect(isWithinWindow(new Date("2026-03-27T07:30:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(true);
    expect(isWithinWindow(new Date("2026-03-27T15:29:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(true);
    expect(isWithinWindow(new Date("2026-03-27T15:30:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(false);
  });

  it("is closed on a weekend", () => {
    expect(isWithinWindow(new Date("2026-03-28T10:00:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(false);
  });

  it("moves with the spring DST change", () => {
    // Same UTC hour, different local hour: Friday before the switch is 08:00 local (outside),
    // the Monday after is 09:00 local (inside).
    expect(isWithinWindow(new Date("2026-03-27T07:00:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(false);
    expect(isWithinWindow(new Date("2026-03-30T07:00:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(true);
  });

  it("moves with the autumn DST change", () => {
    // 07:15Z is 08:15 CET (outside) on 26 October; a fixed CEST offset would wrongly say 09:15.
    expect(isWithinWindow(new Date("2026-10-26T07:15:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(false);
    expect(isWithinWindow(new Date("2026-10-26T07:30:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toBe(true);
  });
});

describe("nextWindowStart", () => {
  it("returns the same instant when the window is already open", () => {
    const now = new Date("2026-03-27T08:00:00Z");

    expect(nextWindowStart(now, "Europe/Berlin", EMAIL_WINDOW).getTime()).toBe(now.getTime());
  });

  it("skips the weekend and lands on Monday's start, across the DST change", () => {
    // Saturday 28 March 2026, 13:00 local. Monday 30 March opens at 08:30 CEST = 06:30Z.
    expect(nextWindowStart(new Date("2026-03-28T12:00:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toEqual(
      new Date("2026-03-30T06:30:00Z"),
    );
  });

  it("waits for the next weekday when the window has already closed", () => {
    // Friday 17:00 local.
    expect(nextWindowStart(new Date("2026-03-27T16:00:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toEqual(
      new Date("2026-03-30T06:30:00Z"),
    );
  });

  it("rolls to tomorrow after today's close", () => {
    // Monday 16:40 local (CEST).
    expect(nextWindowStart(new Date("2026-03-30T14:40:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toEqual(
      new Date("2026-03-31T06:30:00Z"),
    );
  });

  it("uses the winter offset after the autumn change", () => {
    // Sunday 25 October is already CET; Monday 26 October opens at 08:30 CET = 07:30Z.
    expect(nextWindowStart(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin", EMAIL_WINDOW)).toEqual(
      new Date("2026-10-26T07:30:00Z"),
    );
  });
});

describe("nextCounterDayStart", () => {
  it("is the next day at 00:05 in UTC", () => {
    expect(nextCounterDayStart(new Date("2026-03-27T18:00:00Z"), "UTC")).toEqual(new Date("2026-03-28T00:05:00Z"));
  });

  it("uses the owner's timezone, not the caller's", () => {
    // 19:00 in Berlin on 27 March; tomorrow 00:05 CET is 23:05Z today.
    expect(nextCounterDayStart(new Date("2026-03-27T18:00:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-03-27T23:05:00Z"),
    );
  });

  it("stays at the old offset on the night the clocks move forward", () => {
    // Tomorrow is 29 March; 00:05 is before 02:00, so it is still CET.
    expect(nextCounterDayStart(new Date("2026-03-28T12:00:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-03-28T23:05:00Z"),
    );
  });

  it("uses the new offset once the clocks have moved forward", () => {
    // 29 March is CEST; tomorrow 00:05 is 22:05Z today.
    expect(nextCounterDayStart(new Date("2026-03-29T12:00:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-03-29T22:05:00Z"),
    );
  });

  it("crosses the autumn change with the winter offset", () => {
    // 25 October is CET; tomorrow 00:05 is 23:05Z today.
    expect(nextCounterDayStart(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-10-25T23:05:00Z"),
    );
  });

  it("agrees with dateOnlyInZone about which counter day 'now' belongs to", () => {
    const now = new Date("2026-03-27T23:30:00Z"); // 28 March 00:30 in Berlin

    expect(dateOnlyInZone(now, "Europe/Berlin")).toBe("2026-03-28");
    // Tomorrow in Berlin is 29 March 00:05 CET = 28 March 23:05Z.
    expect(nextCounterDayStart(now, "Europe/Berlin")).toEqual(new Date("2026-03-28T23:05:00Z"));
  });
});
