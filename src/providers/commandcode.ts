/**
 * Command Code adapter — `commandcode`.
 *
 * Command Code is an OpenAI/Anthropic-compatible provider whose subscription
 * exposes rolling 5h + weekly windows plus monthly credits. The quota surface
 * lives on the `alpha` API and uses a non-expiring `user_...` API key:
 *
 *   GET /alpha/whoami                      → org id (absent on personal accounts)
 *   GET /alpha/billing/credits[?orgId=]    → windowLimits.{fiveHour,weekly} + monthly credits
 *   GET /alpha/billing/subscriptions       → currentPeriodEnd (monthly reset)
 *   GET /alpha/usage/summary[?orgId=&since=] → spend for the billing period
 *
 * The `orgId` query parameter is only required for organization accounts; we
 * send it when `/alpha/whoami` reports one, and omit it otherwise.
 *
 * Degradation: a failing secondary endpoint marks that section unavailable
 * rather than reporting a fabricated zero (matching the upstream provider
 * package's semantics).
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

interface WindowLimit {
  used?: unknown;
  cap?: unknown;
  resetAt?: unknown;
  exceeded?: unknown;
}

/** Build the rolling + monthly windows from the credits payload. */
export function parseCommandCodeCredits(payload: unknown, nowMs = Date.now()): QuotaWindow[] {
  const data = payload as {
    credits?: { monthlyCredits?: unknown; purchasedCredits?: unknown; freeCredits?: unknown; monthlyResetAt?: unknown };
    windowLimits?: { fiveHour?: WindowLimit; weekly?: WindowLimit };
  } | undefined;
  if (!data || typeof data !== "object") return [];

  const windows: QuotaWindow[] = [];
  const windows5h = data.windowLimits?.fiveHour;
  const weekly = data.windowLimits?.weekly;

  for (const [entry, label, seconds] of [
    [windows5h, "5h", 5 * 3600],
    [weekly, "Weekly", 7 * 86_400],
  ] as const) {
    if (!entry) continue;
    const used = toNumber(entry.used);
    const cap = toNumber(entry.cap);
    if (used === undefined || cap === undefined || cap <= 0) continue;
    const resetsAt = parseResetTime(entry.resetAt);
    windows.push({
      label,
      usedPercent: clampPercent((used / cap) * 100),
      resetsAt,
      windowSeconds: seconds,
      usedValue: used,
      limitValue: cap,
      limited: used >= cap || entry.exceeded === true,
      kind: "quota",
    });
  }

  // Monthly credit pool. The subscription period end is the authoritative
  // reset; `monthlyResetAt` wins when present.
  const credits = data.credits;
  if (credits) {
    const monthly = toNumber(credits.monthlyCredits) ?? 0;
    const purchased = toNumber(credits.purchasedCredits) ?? 0;
    const free = toNumber(credits.freeCredits) ?? 0;
    const remaining = monthly + purchased + free;
    windows.push({
      label: "Monthly credits",
      // Percent used is relative to the credits that remain plus what has been
      // consumed; the consumed part is filled in by the caller via usage summary.
      usedPercent: undefined,
      resetsAt: parseResetTime(credits.monthlyResetAt),
      windowSeconds: 30 * 86_400,
      balanceValue: remaining,
      usedValue: remaining,
      isCurrency: false,
      limited: remaining <= 0,
      isBalance: true,
      kind: "balance",
      note: `monthly ${monthly.toFixed(2)} · purchased ${purchased.toFixed(2)} · free ${free.toFixed(2)}`,
    });
  }

  return windows;
}

/** Attach the spend-derived percentage and reset to the monthly credits window. */
export function applyCommandCodePeriod(
  windows: QuotaWindow[],
  payload: unknown,
): QuotaWindow[] {
  const data = payload as { data?: { currentPeriodEnd?: unknown } } | undefined;
  const periodEnd = parseResetTime(data?.data?.currentPeriodEnd);
  if (periodEnd === undefined) return windows;
  return windows.map((window) =>
    window.label === "Monthly credits" ? { ...window, resetsAt: window.resetsAt ?? periodEnd } : window,
  );
}

/** Derive used/total for the monthly credit pool from a usage summary. */
export function applyCommandCodeUsage(windows: QuotaWindow[], payload: unknown): QuotaWindow[] {
  const data = payload as { totalCost?: unknown; totalCredits?: unknown } | undefined;
  const spent = toNumber(data?.totalCost) ?? toNumber(data?.totalCredits);
  if (spent === undefined) return windows;
  return windows.map((window) => {
    if (window.label !== "Monthly credits" || window.balanceValue === undefined) return window;
    const total = window.balanceValue + spent;
    if (total <= 0) return window;
    return {
      ...window,
      usedPercent: clampPercent((spent / total) * 100),
      usedValue: spent,
      limitValue: total,
      limited: window.balanceValue <= 0,
    };
  });
}

export async function fetchCommandCodeUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "commandcode" as const, fetchedAt: Date.now() };
  const headers = { Authorization: `Bearer ${token}`, accept: "application/json" };
  const requestInit = { headers };
  const requestConfig = { timeoutMs: config.timeoutMs, signal: config.signal };

  const whoami = await requestJson(endpoints.commandcodeWhoami, requestInit, requestConfig);
  if (!whoami.ok) {
    const hint = whoami.status === 401 || whoami.status === 403 ? "Command Code rejected the API key" : whoami.error;
    return { ...base, status: "error", windows: [], error: hint };
  }
  const orgId = (whoami.data as { org?: { id?: unknown } } | undefined)?.org?.id;
  const query = typeof orgId === "string" && orgId !== "" ? `?orgId=${encodeURIComponent(orgId)}` : "";

  const [credits, subscriptions, summary] = await Promise.all([
    requestJson(`${endpoints.commandcodeCredits}${query}`, requestInit, requestConfig),
    requestJson(`${endpoints.commandcodeSubscriptions}${query}`, requestInit, requestConfig),
    requestJson(`${endpoints.commandcodeUsageSummary}${query}`, requestInit, requestConfig),
  ]);

  if (!credits.ok) {
    const hint = credits.status === 401 || credits.status === 403 ? "Command Code rejected the API key" : credits.error;
    return { ...base, status: "error", windows: [], error: hint };
  }

  let windows = parseCommandCodeCredits(credits.data);
  if (windows.length === 0) return { ...base, status: "error", windows: [], error: "unrecognized credits response" };
  if (subscriptions.ok) windows = applyCommandCodePeriod(windows, subscriptions.data);
  if (summary.ok) windows = applyCommandCodeUsage(windows, summary.data);

  const unavailable: string[] = [];
  if (!subscriptions.ok) unavailable.push("subscription");
  if (!summary.ok) unavailable.push("usage");

  return {
    ...base,
    status: "ok",
    windows,
    notice: unavailable.length > 0 ? `${unavailable.join(" + ")} unavailable` : undefined,
  };
}
