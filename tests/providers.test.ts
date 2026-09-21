import { describe, expect, it } from "vitest";
import { parseZaiCodingCn } from "../src/providers/zai-coding-cn.js";
import { parseKimiCoding } from "../src/providers/kimi-coding.js";
import { parseDeepSeekBalance } from "../src/providers/deepseek.js";
import { parseCommandCodeCredits, applyCommandCodePeriod, applyCommandCodeUsage } from "../src/providers/commandcode.js";
import { parseCodeBuddySummary, applyCodeBuddyPackageDetails, codeBuddyWindows } from "../src/providers/codebuddy.js";
import { parseAntigravityQuotaSummary, parseAntigravityAvailableModels, parseAntigravityCredential } from "../src/providers/antigravity.js";
import { parseOpenCodeGoUsage } from "../src/providers/opencode-go.js";

describe("zai-coding-cn parser", () => {
  it("maps tokens limits to window labels using unit multipliers", () => {
    // Live shape: unit 3 = hour with number 5 => a 5-hour window; unit 6 = week.
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 4, nextResetTime: 1_789_970_882_282 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 100, nextResetTime: 1_790_303_246_991 },
        ],
      },
    };
    const windows = parseZaiCodingCn(payload);
    expect(windows[0]).toMatchObject({ label: "5h", usedPercent: 4, windowSeconds: 5 * 3600 });
    expect(windows[1]).toMatchObject({ label: "Weekly", usedPercent: 100, windowSeconds: 7 * 86_400 });
  });

  it("treats CREDIT_LIMIT like a token window and keeps TIME_LIMIT as web usage", () => {
    const payload = {
      data: {
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 100, nextResetTime: 1_700_000_000_000 },
          { type: "TIME_LIMIT", usage: 4000, currentValue: 10, nextResetTime: 1_700_000_000_000 },
        ],
      },
    };
    const windows = parseZaiCodingCn(payload);
    expect(windows.find((w) => w.label === "5h")).toMatchObject({ usedPercent: 100, limited: true });
    expect(windows.find((w) => w.label === "Web / month")).toMatchObject({ usedPercent: 0, limitValue: 4000 });
  });

  it("returns empty for unrecognized shapes", () => {
    expect(parseZaiCodingCn({})).toEqual([]);
    expect(parseZaiCodingCn({ data: { limits: "nope" } })).toEqual([]);
  });
});

describe("kimi-coding parser", () => {
  it("parses the live usages map shape", () => {
    // Captured from the live endpoint: used_ratio 1.0 on the 5h window, 0.6817 monthly.
    const payload = {
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "100", resetTime: "2026-09-21T06:26:48.638698Z" } },
      ],
      usages: {
        limit_5h: { used_ratio: 1, reset_time: "2026-09-21T06:26:47Z" },
        limit_month_total: { used_ratio: 0.6817, reset_time: "2026-10-12T00:00:00Z" },
        limit_month_code: { used_ratio: 0.6817, reset_time: "2026-10-12T00:00:00Z" },
      },
    };
    const windows = parseKimiCoding(payload);
    expect(windows.find((w) => w.label === "5h")).toMatchObject({ usedPercent: 100, limited: true });
    // Monthly is NOT exhausted at 68% — this was the bug the live test caught.
    expect(windows.find((w) => w.label === "Monthly")).toMatchObject({ usedPercent: 68, limited: false });
    // The duplicate month_code slice is not rendered twice.
    expect(windows.filter((w) => w.label === "Monthly")).toHaveLength(1);
  });

  it("still handles the legacy usage/limits shape", () => {
    const payload = {
      usage: { limit: 1000, used: 250, resetTime: "2026-09-28T00:00:00Z" },
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 100, used: 10, resetTime: "2026-09-21T10:00:00Z" } },
      ],
    };
    const windows = parseKimiCoding(payload);
    expect(windows.find((w) => w.label === "Weekly")!.usedPercent).toBe(25);
    expect(windows.find((w) => w.label === "5h")!.usedPercent).toBe(10);
  });

  it("ignores malformed windows", () => {
    expect(parseKimiCoding({ limits: [{ window: {}, detail: {} }] })).toEqual([]);
    expect(parseKimiCoding({})).toEqual([]);
  });
});

describe("deepseek parser", () => {
  it("produces a currency balance window with the total as the headline", () => {
    const payload = {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "2.00", topped_up_balance: "10.34" }],
    };
    const { windows, isAvailable } = parseDeepSeekBalance(payload);
    expect(isAvailable).toBe(true);
    expect(windows[0]).toMatchObject({ kind: "balance", isCurrency: true, currency: "CNY", balanceValue: 12.34, limited: false });
    expect(windows[0]!.note).toContain("12.34");
    expect(windows[0]!.note).toContain("topped-up");
  });

  it("flags a negative balance as limited (live account state)", () => {
    const { windows } = parseDeepSeekBalance({
      is_available: false,
      balance_infos: [{ currency: "CNY", total_balance: "-0.20", granted_balance: "0.00", topped_up_balance: "-0.20" }],
    });
    expect(windows[0]!.limited).toBe(true);
    expect(windows[0]!.balanceValue).toBe(-0.2);
  });

  it("returns nothing for an empty payload", () => {
    expect(parseDeepSeekBalance({}).windows).toEqual([]);
  });
});

describe("commandcode parser", () => {
  // Captured from the live API.
  const credits = {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 9.157051588, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      fiveHour: { used: 0.223013256, cap: 3, exceeded: false, resetAt: 1_789_977_437_577 },
      weekly: { used: 0.842948412, cap: 6, exceeded: false, resetAt: 1_790_332_840_943 },
    },
  };

  it("builds 5h, weekly and monthly windows", () => {
    const windows = parseCommandCodeCredits(credits);
    expect(windows.find((w) => w.label === "5h")).toMatchObject({ usedPercent: 7, limitValue: 3 });
    expect(windows.find((w) => w.label === "Weekly")).toMatchObject({ usedPercent: 14, limitValue: 6 });
    expect(windows.find((w) => w.label === "Monthly credits")).toMatchObject({ kind: "balance", balanceValue: 9.157051588 });
  });

  it("uses the subscription period end as the monthly reset", () => {
    const windows = applyCommandCodePeriod(parseCommandCodeCredits(credits), {
      data: { currentPeriodEnd: "2026-10-18T10:38:18.000Z" },
    });
    expect(windows.find((w) => w.label === "Monthly credits")!.resetsAt).toBe(Date.parse("2026-10-18T10:38:18.000Z"));
  });

  it("derives the monthly percentage from the usage summary", () => {
    const windows = applyCommandCodeUsage(parseCommandCodeCredits(credits), { totalCost: 0.680173356 });
    const monthly = windows.find((w) => w.label === "Monthly credits")!;
    // 0.68 spent of 9.837 total => ~7%
    expect(monthly.usedPercent).toBe(7);
    expect(monthly.limitValue).toBeCloseTo(9.837, 2);
  });
});

describe("codebuddy parser", () => {
  // Captured from the live billing API.
  const summary = {
    data: {
      Packages: [
        { PackageCode: "TCACA_code_007_nzdH5h4Nl0", CycleTotalCapacity: "1500", CycleRemainCapacity: "1387.0200005", CycleUsedCapacity: "112.9799995", CapacityUnit: "credits" },
        { PackageCode: "TCACA_code_008_cfWoLwvjU4", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500", CapacityUnit: "credits" },
      ],
    },
  };

  it("parses every package", () => {
    const packages = parseCodeBuddySummary(summary);
    expect(packages).toHaveLength(2);
    expect(packages[0]).toMatchObject({ packageCode: "TCACA_code_007_nzdH5h4Nl0", total: 1500, remaining: 1387.0200005 });
  });

  it("merges cycle end times and names", () => {
    const packages = applyCodeBuddyPackageDetails(parseCodeBuddySummary(summary), {
      data: {
        Accounts: [
          { PackageCode: "TCACA_code_007_nzdH5h4Nl0", PackageName: "赠送包", CycleEndTime: "2026-10-16 01:25:31", DeductionEndTime: 1_792_085_131_000 },
        ],
      },
    });
    expect(packages[0]!.name).toBe("赠送包");
    expect(packages[0]!.resetsAt).toBe(new Date("2026-10-16T01:25:31+08:00").getTime());
  });

  it("sums a total window and marks exhaustion", () => {
    const windows = codeBuddyWindows(parseCodeBuddySummary(summary));
    const total = windows[0]!;
    expect(total.label).toBe("Total credits");
    expect(total.balanceValue).toBeCloseTo(1387.02, 1);
    expect(total.limited).toBe(false);
  });

  it("marks total as limited when everything is spent", () => {
    const windows = codeBuddyWindows([
      { packageCode: "a", total: 500, used: 500, remaining: 0, unit: "credits" },
    ]);
    expect(windows[0]!.limited).toBe(true);
  });
});

describe("antigravity parser", () => {
  it("parses the credential JSON shape Pi hands out", () => {
    expect(parseAntigravityCredential('{"token":"abc","projectId":"aicode-consumers"}')).toEqual({
      token: "abc",
      projectId: "aicode-consumers",
    });
    expect(parseAntigravityCredential("bare-token")).toEqual({ token: "bare-token" });
  });

  it("maps grouped quota buckets into windows", () => {
    const payload = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-09-23T06:23:54Z", remainingFraction: 0.7852373 },
            { bucketId: "gemini-5h", window: "5h", resetTime: "2026-09-21T08:05:37Z", remainingFraction: 1 },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [{ bucketId: "3p-5h", window: "5h", resetTime: "2026-09-21T06:42:52Z", remainingFraction: 0.7974012 }],
        },
      ],
    };
    const windows = parseAntigravityQuotaSummary(payload);
    expect(windows).toHaveLength(3);
    const geminiWeekly = windows.find((w) => w.label === "Gemini Weekly")!;
    expect(geminiWeekly.usedPercent).toBe(21); // 100 - 78.5
    expect(windows.find((w) => w.label === "Claude/GPT 5h")).toBeDefined();
  });

  it("falls back to per-model quota", () => {
    const payload = {
      models: {
        "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", quotaInfo: { remainingFraction: 1, resetTime: "2026-09-21T08:05:32Z" } },
        "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", quotaInfo: { remainingFraction: 0.2, resetTime: "2026-09-21T08:05:32Z" } },
      },
    };
    const windows = parseAntigravityAvailableModels(payload);
    expect(windows).toHaveLength(2);
    // Most-constrained first.
    expect(windows[0]!.label).toBe("Claude Sonnet 4.6");
    expect(windows[0]!.usedPercent).toBe(80);
  });
});

describe("opencode-go parser", () => {
  it("maps server-computed percentages", () => {
    const payload = {
      usage: {
        rolling: { percent: 12, resetsAt: "2026-09-21T10:00:00Z" },
        weekly: { percent: 40, resetsAt: "2026-09-28T00:00:00Z" },
        monthly: { percent: 5, resetsAt: "2026-10-01T00:00:00Z" },
      },
    };
    const windows = parseOpenCodeGoUsage(payload);
    expect(windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5h", 12],
      ["Weekly", 40],
      ["Monthly", 5],
    ]);
  });

  it("returns nothing for an unexpected shape", () => {
    expect(parseOpenCodeGoUsage({})).toEqual([]);
  });
});
