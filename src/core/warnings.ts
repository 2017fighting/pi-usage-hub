/**
 * Pace-based quota warnings.
 *
 * When a window's consumption is on track to hit 100% before it resets, warn
 * the user. Severity escalates as the projection worsens:
 *   - warning  : projected to exceed within the window
 *   - high     : >= 90% used already, or projected to exceed well before reset
 *   - critical : >= 100% used
 *
 * Locally triggered warnings are de-duplicated per provider+window with a
 * cooldown so a user is not notified on every poll. Escalations always notify.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsage, QuotaWindow } from "./types.js";
import { PROVIDER_LABELS } from "./types.js";

export type WarningSeverity = "warning" | "high" | "critical";

export interface QuotaWarning {
  provider: ProviderUsage["provider"];
  windowLabel: string;
  severity: WarningSeverity;
  message: string;
}

const WARNING_COOLDOWN_MS = 60 * 60 * 1000;
const lastNotified = new Map<string, { severity: WarningSeverity; at: number }>();

/**
 * Decide whether a window warrants a warning, based on used percentage and the
 * fraction of the window that has already elapsed.
 */
export function evaluateWindow(
  window: QuotaWindow,
  nowMs = Date.now(),
): { severity: WarningSeverity; detail: string } | undefined {
  if (window.kind !== "quota" || window.usedPercent === undefined) return undefined;
  const used = window.usedPercent;

  if (used >= 100 || window.limited === true) {
    return { severity: "critical", detail: `${Math.round(used)}% used — window exhausted` };
  }
  if (used >= 90) {
    return { severity: "high", detail: `${Math.round(used)}% used` };
  }

  // Pace projection only makes sense with a reset time and a known window length.
  if (window.resetsAt === undefined || window.windowSeconds === undefined) return undefined;
  const remainingMs = window.resetsAt - nowMs;
  if (remainingMs <= 0) return undefined;
  const elapsedMs = window.windowSeconds * 1000 - remainingMs;
  const elapsedFraction = elapsedMs / (window.windowSeconds * 1000);
  if (elapsedFraction <= 0.05) return undefined; // Too early in the window to project.

  // Linear projection of usage at reset time.
  const projected = used / elapsedFraction;
  if (projected < 100) return undefined;

  const severity: WarningSeverity = elapsedFraction < 0.5 ? "high" : "warning";
  const hoursToExhaustion = ((100 - used) / 100) * (elapsedMs / used) / 3_600_000;
  const detail =
    hoursToExhaustion > 0 && Number.isFinite(hoursToExhaustion)
      ? `on pace to exhaust in ~${hoursToExhaustion < 1 ? "<1h" : `${Math.round(hoursToExhaustion)}h`}`
      : `on pace to exceed the limit before reset`;
  return { severity, detail };
}

/** Collect all warnings for a provider usage. */
export function collectWarnings(usage: ProviderUsage, nowMs = Date.now()): QuotaWarning[] {
  if (usage.status !== "ok") return [];
  const warnings: QuotaWarning[] = [];
  for (const window of usage.windows) {
    const evaluated = evaluateWindow(window, nowMs);
    if (!evaluated) continue;
    warnings.push({
      provider: usage.provider,
      windowLabel: window.label,
      severity: evaluated.severity,
      message: `${PROVIDER_LABELS[usage.provider]} ${window.label}: ${evaluated.detail}`,
    });
  }
  return warnings;
}

const SEVERITY_RANK: Record<WarningSeverity, number> = { warning: 0, high: 1, critical: 2 };

/**
 * Notify on warnings worth surfacing, de-duplicating repeated ones.
 *
 * Callers fire this without awaiting it, so it must never reject. In
 * particular a context can already be stale when this runs — pi invalidates
 * every captured ctx on session replacement — and reading `ctx.mode` then
 * throws. Warnings are advisory, so a dead context simply means no warning.
 */
export async function evaluateWarnings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  usage: ProviderUsage,
  nowMs = Date.now(),
): Promise<void> {
  let canNotify: boolean;
  try {
    canNotify = ctx.mode === "tui" || ctx.hasUI;
  } catch {
    return;
  }
  if (!canNotify) return;
  const warnings = collectWarnings(usage, nowMs);
  for (const warning of warnings) {
    const key = `${warning.provider}:${warning.windowLabel}`;
    const previous = lastNotified.get(key);
    const escalated = previous === undefined || SEVERITY_RANK[warning.severity] > SEVERITY_RANK[previous.severity];
    const cooled = previous === undefined || nowMs - previous.at >= WARNING_COOLDOWN_MS;
    if (!escalated && !cooled) continue;
    // Skip repeating a non-escalated warning inside its cooldown (handled above);
    // never re-notify a lower severity than what was last surfaced.
    if (previous && SEVERITY_RANK[warning.severity] < SEVERITY_RANK[previous.severity]) continue;
    lastNotified.set(key, { severity: warning.severity, at: nowMs });
    try {
      ctx.ui.notify(warning.message, warning.severity === "warning" ? "warning" : "error");
    } catch {
      // Notification is best-effort.
    }
  }
}

/** Test hook: clear the de-duplication state. */
export function resetWarningState(): void {
  lastNotified.clear();
}
