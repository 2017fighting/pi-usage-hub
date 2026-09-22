import { describe, expect, it } from "vitest";
import {
  accountBadge,
  accountDisplayLabel,
  formatAccountRow,
  formatFooterSummary,
  formatHeadlineLine,
  formatWindow,
  formatWindowAmount,
  poolStatusTag,
} from "../src/core/render.js";
import type { AccountUsage, ProviderUsage, QuotaWindow } from "../src/core/types.js";

// A theme double that keeps assertions readable: no ANSI codes.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

describe("formatWindow", () => {
  it("renders a quota window with bar, percent and reset", () => {
    const window: QuotaWindow = {
      label: "5h",
      usedPercent: 42,
      resetsAt: Date.now() + 90 * 60 * 1000,
      windowSeconds: 5 * 3600,
      kind: "quota",
    };
    const rendered = formatWindow(theme, window, { barWidth: 10 });
    expect(rendered).toContain("5h");
    expect(rendered).toContain("42%");
    expect(rendered).toContain("█");
    expect(rendered).toContain("⟳");
  });

  it("never fabricates a bar or percentage for a balance window", () => {
    // Regression: a DeepSeek balance rendered as "░░░░░░ 0%", inventing a 0%
    // that read as "nothing used" while the account was actually overdrawn.
    const balance: QuotaWindow = {
      label: "Balance",
      balanceValue: -0.2,
      isCurrency: true,
      currency: "CNY",
      isBalance: true,
      limited: true,
      kind: "balance",
    };
    const rendered = formatWindow(theme, balance, { barWidth: 14 });
    expect(rendered).not.toContain("█");
    expect(rendered).not.toContain("░");
    expect(rendered).not.toContain("%");
    expect(rendered).toContain("CN¥");
  });

  it("shows a remaining/capacity pair when a balance has a known limit", () => {
    const credits: QuotaWindow = {
      label: "Total credits",
      balanceValue: 1387.02,
      limitValue: 2000,
      isBalance: true,
      kind: "balance",
    };
    expect(formatWindowAmount(credits)).toBe("1387.02 / 2000.00 credits");
  });

  it("shows a bare amount when there is no known limit", () => {
    const balance: QuotaWindow = {
      label: "Balance",
      balanceValue: 12.34,
      isCurrency: true,
      currency: "USD",
      isBalance: true,
      kind: "balance",
    };
    expect(formatWindowAmount(balance)).toBe("$12.34");
  });

  it("does not duplicate the amount when the note repeats it", () => {
    const window: QuotaWindow = {
      label: "Balance",
      balanceValue: 12.34,
      isCurrency: true,
      currency: "USD",
      isBalance: true,
      note: "$12.34 · topped-up $10.34",
      kind: "balance",
    };
    expect(formatWindowAmount(window)).toBe("$12.34 · topped-up $10.34");
  });

  it("renders a quota window without a percentage as a note, not a fake 0%", () => {
    const window: QuotaWindow = { label: "Quota", kind: "quota", note: "unavailable" };
    const rendered = formatWindow(theme, window, { barWidth: 10 });
    expect(rendered).not.toContain("%");
    expect(rendered).toContain("unavailable");
  });
});

describe("formatFooterSummary", () => {
  it("uses a bar for quota providers", () => {
    const summary = formatFooterSummary(theme, [
      { label: "5h", usedPercent: 4, windowSeconds: 5 * 3600, kind: "quota" },
      { label: "Weekly", usedPercent: 100, resetsAt: Date.now() + 3 * 86_400_000, windowSeconds: 7 * 86_400, kind: "quota" },
    ]);
    // The worst window is the headline, with its reset, and no invented 0%.
    expect(summary).toContain("100%");
    expect(summary).toContain("⟳");
    expect(summary).toContain("█");
  });

  it("uses a plain amount for balance-only providers", () => {
    const summary = formatFooterSummary(theme, [
      {
        label: "Balance",
        balanceValue: -0.2,
        isCurrency: true,
        currency: "CNY",
        isBalance: true,
        limited: true,
        kind: "balance",
      },
    ]);
    expect(summary).toBe("-CN¥0.20");
    expect(summary).not.toContain("%");
  });

  it("prefers a real quota window over a balance row", () => {
    const summary = formatFooterSummary(theme, [
      { label: "5h", usedPercent: 21, windowSeconds: 5 * 3600, kind: "quota" },
      { label: "Monthly credits", balanceValue: 8.76, isBalance: true, kind: "balance" },
    ]);
    expect(summary).toContain("21%");
    expect(summary).not.toContain("8.76");
  });

  it("ignores non-gating informational windows", () => {
    const summary = formatFooterSummary(theme, [
      { label: "5h", usedPercent: 4, windowSeconds: 5 * 3600, kind: "quota" },
      { label: "Web / month", usedPercent: 100, gating: false, kind: "quota" },
    ]);
    expect(summary).toContain("4%");
    expect(summary).not.toContain("100%");
  });

  it("returns undefined when there is nothing to show", () => {
    expect(formatFooterSummary(theme, [])).toBeUndefined();
    expect(formatFooterSummary(theme, [{ label: "x", gating: false, kind: "quota", usedPercent: 50 }])).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * Pooled account rows
 * -------------------------------------------------------------------------- */

const NOW = 1_700_000_000_000;

const quota = (label: string, usedPercent: number, afterMs?: number): QuotaWindow => ({
  label,
  usedPercent,
  ...(afterMs === undefined ? {} : { resetsAt: NOW + afterMs }),
  kind: "quota",
  limited: usedPercent >= 100,
});

function account(overrides: Partial<AccountUsage> & { windows?: QuotaWindow[] } = {}): AccountUsage {
  const { windows = [quota("5h", 21, 4 * 3600_000)], ...rest } = overrides;
  return {
    accountId: "acc-1",
    accountLabel: "google",
    poolStatus: "ready",
    usage: { provider: "commandcode", status: "ok", windows, fetchedAt: NOW },
    ...rest,
  };
}

describe("accountDisplayLabel", () => {
  it("prefers the operator-set label", () => {
    expect(accountDisplayLabel({ accountId: "89a8cbab", accountLabel: "google" })).toBe("google");
  });

  it("falls back to the account id when unlabelled", () => {
    expect(accountDisplayLabel({ accountId: "89a8cbab", accountLabel: "  " })).toBe("89a8cbab");
  });
});

describe("poolStatusTag", () => {
  it("is empty for a healthy account", () => {
    expect(poolStatusTag(theme, account(), NOW)).toBe("");
  });

  it("names a local cooldown with its remaining time", () => {
    // The case that looks like a bug without this tag: quota to spare, yet the
    // scheduler is skipping the account.
    const tag = poolStatusTag(theme, account({ poolStatus: "cooldown", cooldownMs: 12 * 60_000 }), NOW);
    expect(tag).toContain("cooling");
    expect(tag).toContain("12m");
  });

  it("marks a disabled account", () => {
    expect(poolStatusTag(theme, account({ poolStatus: "disabled" }), NOW)).toContain("disabled");
  });
});

describe("accountBadge", () => {
  it("is green for a ready account with room", () => {
    expect(accountBadge(theme, account())).toBe("●");
  });

  it("is red for an account that is out of quota", () => {
    expect(accountBadge(theme, account({ windows: [quota("5h", 100)] }))).toBe("●");
  });

  it("is red for a cooled-down account even with a full bar", () => {
    // Showing green here would contradict the `cooling` tag on the same line.
    const cooled = account({ windows: [quota("5h", 0)], poolStatus: "cooldown", cooldownMs: 60_000 });
    expect(accountBadge(theme, cooled)).toBe("●");
  });

  it("is hollow when the account could not be judged", () => {
    const errored = account({ usage: { provider: "commandcode", status: "error", windows: [], fetchedAt: NOW } });
    expect(accountBadge(theme, errored)).toBe("○");
  });
});

describe("formatAccountRow", () => {
  it("lists every window when expanded", () => {
    const lines = formatAccountRow(
      theme,
      account({ windows: [quota("5h", 21, 4 * 3600_000), quota("Weekly", 48, 3 * 86_400_000)] }),
      { expanded: true, nowMs: NOW },
    );
    expect(lines[0]).toContain("google");
    expect(lines.join("\n")).toContain("5h");
    expect(lines.join("\n")).toContain("Weekly");
    expect(lines.join("\n")).toContain("21%");
  });

  it("collapses to the most-consumed window", () => {
    const lines = formatAccountRow(
      theme,
      account({ windows: [quota("5h", 21, 3600_000), quota("Weekly", 48, 86_400_000)] }),
      { nowMs: NOW },
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Weekly");
    expect(lines[1]).toContain("48%");
    expect(lines[1]).not.toContain("5h");
  });

  it("marks the account serving the session", () => {
    const lines = formatAccountRow(theme, account({ inUse: true }), { nowMs: NOW });
    expect(lines[0]).toContain("✓");
  });

  it("keeps the cooldown tag and the in-use mark on the label line", () => {
    const lines = formatAccountRow(
      theme,
      account({ poolStatus: "cooldown", cooldownMs: 60_000, inUse: true }),
      { nowMs: NOW },
    );
    expect(lines[0]).toContain("cooling");
    expect(lines[0]).toContain("✓");
  });

  it("reports an unconfigured account without inventing windows", () => {
    const unconfigured = account({
      usage: { provider: "commandcode", status: "unconfigured", windows: [], fetchedAt: NOW },
    });
    const lines = formatAccountRow(theme, unconfigured, { expanded: true, nowMs: NOW });
    expect(lines[1]).toContain("not configured");
  });

  it("pads labels so a pool's status dots line up", () => {
    const short = formatAccountRow(theme, account({ accountLabel: "a" }), { labelWidth: 10, nowMs: NOW });
    const long = formatAccountRow(theme, account({ accountLabel: "a-longer-label" }), { labelWidth: 10, nowMs: NOW });
    expect(short[0]!.indexOf("●")).toBe(long[0]!.indexOf("●"));
  });
});

describe("formatHeadlineLine", () => {
  it("summarizes a provider in one line", () => {
    const usage: ProviderUsage = {
      provider: "commandcode",
      status: "ok",
      fetchedAt: NOW,
      windows: [quota("5h", 21, 4 * 3600_000), quota("Weekly", 48, 86_400_000)],
    };
    const line = formatHeadlineLine(theme, usage, NOW);
    expect(line).toContain("Weekly");
    expect(line).toContain("48%");
    expect(line).toContain("⟳");
  });

  it("returns undefined for a provider with nothing to show", () => {
    expect(
      formatHeadlineLine(theme, { provider: "deepseek", status: "error", windows: [], fetchedAt: NOW }, NOW),
    ).toBeUndefined();
  });
});
