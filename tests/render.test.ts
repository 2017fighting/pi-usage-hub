import { describe, expect, it } from "vitest";
import { formatFooterSummary, formatWindow, formatWindowAmount } from "../src/core/render.js";
import type { QuotaWindow } from "../src/core/types.js";

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
