/**
 * The bank's timestamps read the same on the server and in the browser (#4).
 *
 * The server renders the first paint and the browser renders every poll after
 * it, so one instant must format to one string on both. Since #4 the server is
 * Bun, whose `Intl` (JavaScriptCore) joins date and time with ` at ` where the
 * browser's (V8) writes `, `. `formatter.format()` therefore disagreed with
 * itself across the hydration boundary, React threw away the server's `/loans`
 * and re-rendered it, and `loan-board-browser.test.ts` caught it as a reload.
 * This suite runs on Bun, so the string asserted here is the browser's.
 */
import { describe, expect, test } from "bun:test";

import { timestamp } from "../components/bank/format.ts";

describe("timestamp", () => {
  test.each([
    ["2026-09-18T14:02:11.000Z", "Sep 18, 2026, 2:02 PM UTC"],
    ["2026-01-05T00:07:00Z", "Jan 5, 2026, 12:07 AM UTC"],
    ["2026-12-31T23:59:59Z", "Dec 31, 2026, 11:59 PM UTC"],
  ])("%s is %p on every engine, not only V8", (value, printed) => {
    expect(timestamp(value)).toBe(printed);
  });

  test("anything that is not a timestamp is printed as it arrived, and nothing is a dash", () => {
    expect(timestamp("not a date")).toBe("not a date");
    expect(timestamp(null)).toBe("—");
    expect(timestamp("  ")).toBe("—");
  });
});
