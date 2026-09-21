/**
 * Rendering helpers shared by the footer status bar and the /usage dashboard:
 * progress bars, threshold colours, and per-window line formatting.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { QuotaWindow } from "./types.js";
import { clampPercent, formatReset } from "./format.js";

/** Theme colour name for a used-percentage, following the shared 70/90 thresholds. */
export function colorForPercent(percent: number): ThemeColor {
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "success";
}

/** A `█`/`░` progress bar of the given width. */
export function renderBar(fill: (text: string) => string, dim: (text: string) => string, percent: number, width = 8): string {
  const clamped = clampPercent(percent) ?? 0;
  const filled = Math.round((clamped / 100) * width);
  return fill("█".repeat(filled)) + dim("░".repeat(width - filled));
}

export interface WindowRenderOptions {
  /** Bar width; 0 omits the bar. */
  barWidth?: number;
  /** Include the reset countdown. */
  showReset?: boolean;
  nowMs?: number;
}

/**
 * Render a single window as `Label ████░░░░ 42% ⟳ 14:00 (1h23m)`.
 *
 * Balance windows have no meaningful percentage — a currency amount is not a
 * fraction of a plan — so they render as `Label ¥12.34 ›` and never grow a bar.
 * Inventing a percentage for them would display a made-up fraction.
 */
export function formatWindow(
  theme: Theme,
  window: QuotaWindow,
  options: WindowRenderOptions = {},
): string {
  const { barWidth = 8, showReset = true, nowMs = Date.now() } = options;
  const label = theme.fg("muted", window.label);

  if (window.kind === "balance" || window.isBalance) {
    const amount = formatWindowAmount(window);
    const color: ThemeColor = window.limited ? "error" : "muted";
    // Only show a bar when the provider genuinely expresses the balance as a
    // fraction of a known pool (e.g. a key spending limit).
    if (window.usedPercent !== undefined && barWidth > 0 && !window.isBalance) {
      const percent = clampPercent(window.usedPercent) ?? 0;
      const bar = renderBar(
        (text) => theme.fg(colorForPercent(percent), text),
        (text) => theme.fg("dim", text),
        percent,
        barWidth,
      );
      return `${label} ${bar} ${theme.fg(colorForPercent(percent), `${percent}%`)} ${theme.fg(color, amount)}`;
    }
    return `${label} ${theme.fg(color, amount)}`;
  }

  const percent = clampPercent(window.usedPercent);
  if (percent === undefined) {
    // A quota window without a percentage cannot be drawn as progress either.
    return `${label} ${theme.fg("dim", window.note ?? "—")}`;
  }
  const bar =
    barWidth > 0
      ? ` ${renderBar(
          (text) => theme.fg(colorForPercent(percent), text),
          (text) => theme.fg("dim", text),
          percent,
          barWidth,
        )}`
      : "";
  const reset = showReset ? formatReset(window.resetsAt, nowMs) : undefined;
  return [
    label,
    bar.trimStart(),
    theme.fg(colorForPercent(percent), `${percent}%`),
    reset ? theme.fg("dim", `⟳ ${reset}`) : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** Format a balance window's amount, with currency when known. */
export function formatWindowAmount(window: QuotaWindow): string {
  const amount = formatAmountOnly(window);
  // The note carries the breakdown, e.g. "topped-up $10.00 · granted $5.00".
  // Skip it only when it already leads with the same amount, so a note that
  // merely mentions the amount elsewhere is still shown alongside it.
  if (!window.note || window.note.startsWith(amount)) return window.note ?? amount;
  return `${amount} · ${window.note}`;
}

/**
 * A one-line summary of a provider for the footer: a bar for quota windows, or
 * a plain amount for balance-only providers.
 *
 * Returns undefined when the provider has nothing displayable.
 */
export function formatFooterSummary(
  theme: Theme,
  windows: QuotaWindow[],
  options: { barWidth?: number; nowMs?: number } = {},
): string | undefined {
  const { barWidth = 6, nowMs = Date.now() } = options;
  const gating = windows.filter((window) => window.gating !== false);
  if (gating.length === 0) return undefined;

  const quotaWindows = gating.filter((window) => window.kind === "quota" && window.usedPercent !== undefined);

  // Quota providers: headline the most-consumed window, with its reset.
  if (quotaWindows.length > 0) {
    const headline = [...quotaWindows].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]!;
    const percent = clampPercent(headline.usedPercent) ?? 0;
    const bar = renderBar(
      (text) => theme.fg(colorForPercent(percent), text),
      (text) => theme.fg("dim", text),
      percent,
      barWidth,
    );
    const reset = shortReset(headline.resetsAt, nowMs);
    return `${bar} ${theme.fg(colorForPercent(percent), `${percent}%`)}${reset ? theme.fg("dim", ` ⟳${reset}`) : ""}`;
  }

  // Balance-only providers: show the amount, never a fabricated percentage.
  const balances = gating.filter((window) => window.kind === "balance");
  if (balances.length === 0) return undefined;
  const total = balances.find((window) => window.balanceValue !== undefined);
  if (!total) return undefined;
  const color: ThemeColor = total.limited ? "error" : "muted";
  const amount = total.balanceValue !== undefined
    ? formatAmountOnly(total)
    : total.note ?? "—";
  return theme.fg(color, amount);
}

/** The bare amount of a balance window, without the appended breakdown note. */
export function formatAmountOnly(window: QuotaWindow): string {
  const amount = window.balanceValue;
  if (amount === undefined) return window.note ?? "—";
  const suffix = window.isCurrency ? "" : " credits";
  const format = (value: number) => {
    if (window.isCurrency) {
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: window.currency && window.currency.length === 3 ? window.currency : "USD",
        }).format(value);
      } catch {
        return `${value.toFixed(2)} ${window.currency ?? ""}`.trim();
      }
    }
    return value.toFixed(2);
  };
  // When the provider expresses a remaining amount against a known capacity,
  // show the pair; it is the most useful thing a balance row can say.
  if (window.limitValue !== undefined && window.limitValue > 0) {
    return `${format(amount)} / ${format(window.limitValue)}${suffix}`;
  }
  return `${format(amount)}${suffix}`;
}

/** Worst (highest) used percentage across a provider's windows, for colouring a summary. */
export function worstPercent(windows: QuotaWindow[]): number | undefined {
  const percents = windows
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (percents.length === 0) return undefined;
  return Math.max(...percents);
}

/** Short reset countdown for compact footer lanes. */
export function shortReset(resetsAt: number | undefined, nowMs = Date.now()): string | undefined {
  const formatted = formatReset(resetsAt, nowMs);
  if (!formatted) return undefined;
  const match = formatted.match(/\(([^)]+)\)$/);
  return match ? match[1] : formatted;
}
