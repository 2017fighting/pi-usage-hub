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
  /** Bar width; 0 omits the bar (used for compact footer lanes). */
  barWidth?: number;
  /** Include the reset countdown. */
  showReset?: boolean;
  nowMs?: number;
}

/**
 * Render a single window as: `Label ████░░░░ 42% ⟳ 14:00 (1h23m)`.
 * Balance windows render as `Label 12.34 USD` instead.
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
    const percent = window.usedPercent;
    if (percent !== undefined && barWidth > 0) {
      const bar = renderBar(
        (text) => theme.fg(colorForPercent(percent), text),
        (text) => theme.fg("dim", text),
        percent,
        barWidth,
      );
      return `${label} ${bar} ${theme.fg(colorForPercent(percent), `${clampPercent(percent)}%`)} ${theme.fg("dim", amount)}`;
    }
    return `${label} ${theme.fg("dim", amount)}`;
  }

  const percent = clampPercent(window.usedPercent) ?? 0;
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
  if (window.note) return window.note;
  const amount = window.balanceValue;
  if (amount === undefined) return "";
  if (window.isCurrency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: window.currency && window.currency.length === 3 ? window.currency : "USD",
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${window.currency ?? ""}`.trim();
    }
  }
  return `${amount.toFixed(2)} credits`;
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
