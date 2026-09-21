import { describe, expect, it } from "vitest";
import {
  clampPercent,
  formatDuration,
  formatReset,
  parseResetTime,
  toNumber,
  isExhausted,
  availabilityOf,
  soonestReset,
  sortUsages,
} from "../src/core/format.js";
import type { ProviderUsage, QuotaWindow } from "../src/core/types.js";

function usage(provider: ProviderUsage["provider"], windows: QuotaWindow[], status: ProviderUsage["status"] = "ok"): ProviderUsage {
  return { provider, status, windows, fetchedAt: 1_700_000_000_000 };
}

const quota = (usedPercent: number, resetsAt?: number, label = "5h"): QuotaWindow => ({
  label,
  usedPercent,
  resetsAt,
  windowSeconds: 5 * 3600,
  limited: usedPercent >= 100,
  kind: "quota",
});

describe("clampPercent", () => {
  it("clamps and rounds", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(42.6)).toBe(43);
  });

  it("rejects non-finite input", () => {
    expect(clampPercent(Number.NaN)).toBeUndefined();
    expect(clampPercent(undefined)).toBeUndefined();
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("formats each magnitude", () => {
    expect(formatDuration(2 * 86_400 + 3 * 3600)).toBe("2d 3h");
    expect(formatDuration(3 * 3600)).toBe("3h");
    expect(formatDuration(3 * 3600 + 4 * 60)).toBe("3h 4m");
    expect(formatDuration(12 * 60)).toBe("12m");
    expect(formatDuration(20)).toBe("<1m");
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-100)).toBe("now");
  });
});

describe("parseResetTime", () => {
  it("handles epoch seconds and milliseconds", () => {
    expect(parseResetTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseResetTime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("handles ISO strings and numeric strings", () => {
    expect(parseResetTime("2026-10-16T01:25:31Z")).toBe(Date.parse("2026-10-16T01:25:31Z"));
    expect(parseResetTime("1789493132")).toBe(1_789_493_132_000);
    expect(parseResetTime("")).toBeUndefined();
    expect(parseResetTime("not a date")).toBeUndefined();
  });

  it("rejects zero/negative", () => {
    expect(parseResetTime(0)).toBeUndefined();
    expect(parseResetTime(-5)).toBeUndefined();
  });
});

describe("formatReset dual format", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");

  it("shows clock time and countdown for same-day resets", () => {
    const reset = now + 90 * 60 * 1000;
    const formatted = formatReset(reset, now)!;
    expect(formatted).toContain("(1h 30m)");
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });

  it("shows a date for later resets", () => {
    const formatted = formatReset(now + 5 * 86_400_000, now)!;
    expect(formatted).toMatch(/\d+\/\d+/);
  });

  it("returns undefined without a reset", () => {
    expect(formatReset(undefined, now)).toBeUndefined();
  });
});

describe("toNumber", () => {
  it("coerces strings and numbers", () => {
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber(7)).toBe(7);
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("abc")).toBeUndefined();
    expect(toNumber(null)).toBeUndefined();
  });
});

describe("availability and sorting", () => {
  it("classifies exhausted when every window is used up", () => {
    expect(isExhausted([quota(100), quota(100)])).toBe(true);
    expect(isExhausted([quota(100), quota(40)])).toBe(false);
  });

  it("treats a zero balance as exhausted", () => {
    const balance: QuotaWindow = { label: "Balance", balanceValue: 0, limited: true, isBalance: true, kind: "balance" };
    expect(isExhausted([balance])).toBe(true);
  });

  it("marks non-ok providers as unknown", () => {
    expect(availabilityOf(usage("deepseek", [], "unconfigured"))).toBe("unknown");
    expect(availabilityOf(usage("deepseek", [], "error"))).toBe("unknown");
  });

  it("picks the soonest reset", () => {
    expect(soonestReset(usage("zai-coding-cn", [quota(50, 5000), quota(20, 2000)]))).toBe(2000);
    expect(soonestReset(usage("zai-coding-cn", [quota(50)]))).toBeUndefined();
  });

  it("puts available first, then exhausted by soonest reset, then unknown last", () => {
    const available = usage("kimi-coding", [quota(10)]);
    const exhaustedLate = usage("zai-coding-cn", [quota(100, 9000)]);
    const exhaustedSoon = usage("codebuddy", [quota(100, 1000)]);
    const exhaustedNoReset = usage("commandcode", [quota(100)]);
    const unknown = usage("deepseek", [], "unconfigured");

    const sorted = sortUsages([unknown, exhaustedLate, available, exhaustedSoon, exhaustedNoReset]);
    expect(sorted.map((entry) => entry.provider)).toEqual([
      "kimi-coding", // available
      "codebuddy", // exhausted, resets soonest
      "zai-coding-cn", // exhausted, resets later
      "commandcode", // exhausted, no reset -> last among exhausted
      "deepseek", // unknown
    ]);
  });

  it("orders available providers by registry configuration order", () => {
    const a = usage("kimi-coding", [quota(10)]);
    const b = usage("zai-coding-cn", [quota(10)]);
    const c = usage("codebuddy", [quota(10)]);
    const sorted = sortUsages([a, c, b]);
    expect(sorted.map((entry) => entry.provider)).toEqual(["zai-coding-cn", "codebuddy", "kimi-coding"]);
  });
});
