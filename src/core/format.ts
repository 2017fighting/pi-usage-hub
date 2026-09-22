/**
 * Formatting and parsing helpers shared by every provider adapter.
 */

import type { AccountUsage, ProviderKey, QuotaWindow, ProviderUsage, Availability } from "./types.js";
import { PROVIDER_ORDER } from "./types.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 12_000;

/** Clamp a percentage into 0-100 and round it. Returns undefined for non-finite input. */
export function clampPercent(value: number | undefined | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Normalize a reset timestamp that may be epoch seconds, epoch milliseconds,
 * or an ISO/date string, into epoch milliseconds. Returns undefined when it
 * cannot be interpreted.
 */
export function parseResetTime(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    // Anything below 1e11 is epoch seconds (1e11 ms is 1973, 1e11 s is year 5138).
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    // Numeric strings should follow the same heuristic as numbers.
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseResetTime(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return undefined;
    return parsed;
  }
  return undefined;
}

/** Format a duration in seconds as a compact human string ("2d 3h", "3h 4m", "12m", "<1m", "now"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const total = Math.round(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Format a reset time as both an absolute clock time and a countdown: "14:00 (1h23m)". */
export function formatReset(resetsAt: number | undefined, nowMs = Date.now()): string | undefined {
  if (resetsAt === undefined) return undefined;
  const delta = resetsAt - nowMs;
  const countdown = formatDuration(delta / 1000);
  // Same-day resets show a clock time; further out show a date.
  const date = new Date(resetsAt);
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  const absolute = sameDay
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${absolute} (${countdown})`;
}

/** True when a single window has no room left. */
export function isWindowExhausted(window: QuotaWindow): boolean {
  if (window.kind === "balance") {
    if (window.limited === true) return true;
    return window.balanceValue !== undefined && window.balanceValue <= 0;
  }
  if (window.limited === true) return true;
  return window.usedPercent !== undefined && window.usedPercent >= 100;
}

/** Gating windows only: informational windows (e.g. a web-search quota) never block usage. */
export function gatingWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.filter((window) => window.gating !== false);
}

/**
 * True when every gating window is used up.
 *
 * Prefer `availabilityOf`, which additionally accounts for independent groups.
 */
export function isExhausted(windows: QuotaWindow[]): boolean {
  const gating = gatingWindows(windows);
  if (gating.length === 0) return false;
  return gating.every(isWindowExhausted);
}

/**
 * Usability across grouped windows.
 *
 * Within a group every window must have room (a 5h cap and a weekly cap both
 * apply to the same request). Between groups, having any one group with room is
 * enough (separate credit packages, or Antigravity's independent pools).
 * Windows without a group share one implicit group.
 */
export function hasUsableGroup(windows: QuotaWindow[]): boolean {
  const gating = gatingWindows(windows);
  if (gating.length === 0) return false;
  const groups = new Map<string, QuotaWindow[]>();
  for (const window of gating) {
    const key = window.group ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(window);
    else groups.set(key, [window]);
  }
  for (const bucket of groups.values()) {
    if (bucket.every((window) => !isWindowExhausted(window))) return true;
  }
  return false;
}

/**
 * Availability of a provider for /usage grouping.
 * - `unknown`: unconfigured/unsupported/error — cannot judge.
 * - `exhausted`: no group still has room in every one of its windows.
 * - `available`: at least one group has room in all of its windows.
 *
 * When the provider is a pool and `accounts` were fetched, the answer is
 * computed over the accounts: a pooled provider is available when *any* of its
 * accounts can serve right now. That is the whole point of pooling — account #1
 * being out of quota does not matter while account #2 has room, and reporting
 * the provider as exhausted because the serving account ran dry would be wrong.
 * The pool-health half of "can serve right now" lives in `accountUsable`.
 */
export function availabilityOf(usage: ProviderUsage): Availability {
  const accounts = usage.accounts;
  if (accounts && accounts.length > 0) {
    if (accounts.some(accountUsable)) return "available";
    // Nothing is usable. Distinguish "all out of quota" from "we could not
    // tell": an account we could not judge does not prove exhaustion.
    const judged = accounts.some(
      (account) =>
        account.poolStatus === "disabled" ||
        (account.cooldownMs !== undefined && account.cooldownMs > 0) ||
        availabilityOf(account.usage) !== "unknown",
    );
    return judged ? "exhausted" : "unknown";
  }
  if (usage.status !== "ok") return "unknown";
  if (usage.windows.length === 0) return "unknown";
  return hasUsableGroup(usage.windows) ? "available" : "exhausted";
}

/**
 * Whether one pooled account can serve a request right now.
 *
 * Two independent things must hold, and conflating them is the mistake this
 * function exists to prevent:
 *  - the account's own quota has room (`availabilityOf` on its usage), and
 *  - multiprovider is not holding it out of rotation: disabled by the operator,
 *    or in a local cooldown after a failure.
 *
 * An account with a full quota bar can still be unusable because multiprovider
 * cooled it down; an account can be out of quota yet be the pool's only member.
 */
export function accountUsable(account: AccountUsage): boolean {
  if (account.poolStatus === "disabled") return false;
  if (account.cooldownMs !== undefined && account.cooldownMs > 0) return false;
  return availabilityOf(account.usage) === "available";
}

/**
 * The soonest moment one of a pool's accounts becomes usable again.
 *
 * This is an OR across accounts — the pool is usable as soon as *any* account
 * returns — so it is the minimum, not the maximum, over per-account answers. A
 * cooling-down account contributes its cooldown end; an out-of-quota account
 * contributes the reset that unblocks its group.
 *
 * Returns undefined when no account will ever become usable on its own (all
 * disabled, or all blocked by a balance with no reset).
 */
export function soonestUsableReset(
  usage: ProviderUsage,
  nowMs = Date.now(),
): number | undefined {
  const accounts = usage.accounts;
  if (accounts && accounts.length > 0) {
    const recoveries = accounts.map((account) => {
      if (account.poolStatus === "disabled") return undefined;
      if (account.cooldownMs !== undefined && account.cooldownMs > 0) return nowMs + account.cooldownMs;
      return soonestUsableReset(account.usage, nowMs);
    });
    const timed = recoveries.filter((value): value is number => value !== undefined);
    return timed.length > 0 ? Math.min(...timed) : undefined;
  }

  const gating = gatingWindows(usage.windows);
  if (gating.length === 0) return undefined;

  const groups = new Map<string, QuotaWindow[]>();
  for (const window of gating) {
    const key = window.group ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(window);
    else groups.set(key, [window]);
  }

  // A group becomes usable when its LAST blocked window resets.
  const candidates: number[] = [];
  for (const bucket of groups.values()) {
    const blocked = bucket.filter(isWindowExhausted);
    if (blocked.length === 0) continue;
    const resets = blocked.map((window) => window.resetsAt);
    // A blocked window with no reset time (an exhausted prepaid balance) never
    // becomes usable on its own; such a group is excluded from the minimum.
    if (resets.some((reset) => reset === undefined)) continue;
    candidates.push(Math.max(...(resets as number[])));
  }
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/**
 * The soonest reset across a provider's windows, used as a fallback when
 * `soonestUsableReset` has nothing to report.
 */
export function soonestReset(usage: ProviderUsage): number | undefined {
  const resets = usage.windows
    .map((window) => window.resetsAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (resets.length === 0) return undefined;
  return Math.min(...resets);
}

/**
 * Sort providers for the /usage dashboard:
 *  1. available first, then exhausted, then unknown.
 *  2. within available/unknown: registry configuration order.
 *  3. within exhausted: soonest reset first; entries with no reset time last.
 */
export function sortUsages(usages: ProviderUsage[]): ProviderUsage[] {
  const orderIndex = (provider: ProviderKey) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };

  return [...usages].sort((a, b) => {
    const aAvail = availabilityOf(a);
    const bAvail = availabilityOf(b);
    const rank = (availability: Availability) =>
      availability === "available" ? 0 : availability === "exhausted" ? 1 : 2;
    if (rank(aAvail) !== rank(bAvail)) return rank(aAvail) - rank(bAvail);

    if (aAvail === "exhausted") {
      const aReset = soonestUsableReset(a);
      const bReset = soonestUsableReset(b);
      if (aReset === undefined && bReset === undefined) return orderIndex(a.provider) - orderIndex(b.provider);
      if (aReset === undefined) return 1;
      if (bReset === undefined) return -1;
      if (aReset !== bReset) return aReset - bReset;
    }
    return orderIndex(a.provider) - orderIndex(b.provider);
  });
}

/** Fetch JSON with a timeout and consistent error strings. */
export async function requestJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  config: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; data: unknown; status: number } | { ok: false; error: string; status?: number }> {
  const timeoutMs = init.timeoutMs ?? config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals: AbortSignal[] = [controller.signal];
  if (config.signal) signals.push(config.signal);
  try {
    const response = await fetch(url, {
      ...init,
      signal: signals.length > 1 ? AbortSignal.any(signals) : controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`, status: response.status };
    }
    try {
      return { ok: true, data: JSON.parse(text) as unknown, status: response.status };
    } catch {
      return { ok: false, error: "invalid JSON response", status: response.status };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted && !config.signal?.aborted) return { ok: false, error: "timeout" };
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce a possibly-string numeric field into a number. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
