/**
 * Kimi For Coding adapter — `kimi-coding`.
 *
 * Endpoint: GET https://api.kimi.com/coding/v1/usages
 * Auth: `Authorization: Bearer <token>` (OAuth access token or API key), and
 *       `User-Agent: KimiCLI/1.5` which the service expects.
 *
 * Response shape:
 *   {
 *     usage: { limit, used, resetTime },          // weekly aggregate
 *     limits: [{ window: { duration, timeUnit }, detail: { limit, used, resetTime } }]
 *   }
 * limits[] carries rolling windows (e.g. duration 300 MINUTE = "5h").
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

function windowSecondsFor(duration: number, timeUnit: string): { seconds: number; label: string } | undefined {
  switch (timeUnit) {
    case "TIME_UNIT_SECOND":
      return { seconds: duration, label: `${duration}s` };
    case "TIME_UNIT_MINUTE":
      return {
        seconds: duration * 60,
        label: duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`,
      };
    case "TIME_UNIT_HOUR":
      return { seconds: duration * 3600, label: `${duration}h` };
    case "TIME_UNIT_DAY":
      return { seconds: duration * 86_400, label: `${duration}d` };
    default:
      return undefined;
  }
}

/**
 * Parse the usages map shape that the live `/coding/v1/usages` endpoint returns:
 *
 *   usages: {
 *     limit_5h:          { used_ratio, reset_time },
 *     limit_month_total: { used_ratio, reset_time },
 *     limit_month_code:  { used_ratio, reset_time },
 *   }
 *
 * `limit_month_total` is the monthly subscription pool; `limit_month_code` is the
 * slice of it reserved for coding. They report the same ratio, so only the total
 * is rendered to avoid duplicate windows.
 */
export function parseKimiUsages(payload: unknown): QuotaWindow[] {
  const data = payload as { usages?: Record<string, { used_ratio?: unknown; reset_time?: unknown }> } | undefined;
  const usages = data?.usages;
  if (!usages || typeof usages !== "object") return [];

  const windows: QuotaWindow[] = [];
  const fiveHour = usages.limit_5h;
  if (fiveHour && typeof fiveHour === "object") {
    const ratio = toNumber(fiveHour.used_ratio);
    if (ratio !== undefined) {
      const usedPercent = clampPercent(ratio * 100);
      if (usedPercent !== undefined) {
        windows.push({
          label: "5h",
          usedPercent,
          resetsAt: parseResetTime(fiveHour.reset_time),
          windowSeconds: 5 * 3600,
          usedValue: usedPercent,
          limitValue: 100,
          limited: usedPercent >= 100,
          kind: "quota",
        });
      }
    }
  }

  const monthly = usages.limit_month_total ?? usages.limit_month_code;
  if (monthly && typeof monthly === "object") {
    const ratio = toNumber(monthly.used_ratio);
    if (ratio !== undefined) {
      const usedPercent = clampPercent(ratio * 100);
      if (usedPercent !== undefined) {
        windows.push({
          label: "Monthly",
          usedPercent,
          resetsAt: parseResetTime(monthly.reset_time),
          windowSeconds: 30 * 86_400,
          usedValue: usedPercent,
          limitValue: 100,
          limited: usedPercent >= 100,
          kind: "quota",
        });
      }
    }
  }

  windows.sort((a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER));
  return windows;
}

/** Pure parser, exported for tests. Handles both the legacy and current shapes. */
export function parseKimiCoding(payload: unknown): QuotaWindow[] {
  // The current endpoint shape takes precedence when present.
  const fromUsages = parseKimiUsages(payload);
  if (fromUsages.length > 0) return fromUsages;

  const data = payload as {
    usage?: { limit?: unknown; used?: unknown; resetTime?: unknown };
    limits?: unknown;
  } | undefined;
  if (!data) return [];
  const windows: QuotaWindow[] = [];

  const weekly = data.usage;
  if (weekly && typeof weekly === "object") {
    const limit = toNumber(weekly.limit);
    const used = toNumber(weekly.used);
    if (limit !== undefined && limit > 0 && used !== undefined) {
      windows.push({
        label: "Weekly",
        usedPercent: clampPercent((used / limit) * 100),
        resetsAt: parseResetTime(weekly.resetTime),
        windowSeconds: 7 * 86_400,
        usedValue: used,
        limitValue: limit,
        limited: used >= limit,
        kind: "quota",
      });
    }
  }

  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const window = record.window as Record<string, unknown> | undefined;
    const detail = record.detail as Record<string, unknown> | undefined;
    if (!window || !detail) continue;
    const duration = toNumber(window.duration);
    const timeUnit = String(window.timeUnit ?? "");
    if (duration === undefined || duration <= 0) continue;
    const meta = windowSecondsFor(duration, timeUnit);
    if (!meta) continue;
    const limit = toNumber(detail.limit);
    const used = toNumber(detail.used);
    if (limit === undefined || limit <= 0 || used === undefined) continue;
    windows.push({
      label: meta.label,
      usedPercent: clampPercent((used / limit) * 100),
      resetsAt: parseResetTime(detail.resetTime),
      windowSeconds: meta.seconds,
      usedValue: used,
      limitValue: limit,
      limited: used >= limit,
      kind: "quota",
    });
  }

  windows.sort((a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER));
  return windows;
}

export async function fetchKimiCodingUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "kimi-coding" as const, fetchedAt: Date.now() };
  const result = await requestJson(
    endpoints.kimiCoding,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "KimiCLI/1.5",
      },
    },
    { timeoutMs: config.timeoutMs, signal: config.signal },
  );
  if (!result.ok) return { ...base, status: "error", windows: [], error: result.error };
  const windows = parseKimiCoding(result.data);
  if (windows.length === 0) return { ...base, status: "error", windows: [], error: "unrecognized response shape" };
  return { ...base, status: "ok", windows };
}
