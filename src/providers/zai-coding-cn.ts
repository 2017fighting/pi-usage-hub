/**
 * ZAI Coding Plan (China) adapter — `zai-coding-cn`.
 *
 * Endpoint: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 * Auth: `Authorization: Bearer <ZAI CN API key>`
 *
 * Response shape (observed on the global api.z.ai surface, identical here):
 *   { data: { limits: [
 *       { type: "TOKENS_LIMIT" | "CREDIT_LIMIT", unit: 3|4|6, number: n,
 *         percentage: 0-100, nextResetTime: epochMs },
 *       { type: "TIME_LIMIT", usage: n, currentValue: m, nextResetTime: epochMs },
 *   ] } }
 *
 * unit 3 = 5-hour session window, unit 6 = weekly window.
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

/**
 * unit 3 = HOUR, unit 4 = DAY, unit 6 = WEEK; `number` is a multiplier of the
 * unit (so unit 3 / number 5 is a 5-hour window).
 */
const UNIT_META: Record<number, { unit: "h" | "d" | "w"; seconds: number }> = {
  3: { unit: "h", seconds: 3600 },
  4: { unit: "d", seconds: 86_400 },
  6: { unit: "w", seconds: 7 * 86_400 },
};

/** Pure parser, exported for tests. */
export function parseZaiCodingCn(payload: unknown): QuotaWindow[] {
  const data = payload as { data?: { limits?: unknown } } | undefined;
  const limits = data?.data?.limits;
  if (!Array.isArray(limits)) return [];

  const windows: QuotaWindow[] = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = String(record.type ?? "").toUpperCase();
    const resetsAt = parseResetTime(record.nextResetTime);

    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      const unit = toNumber(record.unit);
      const meta = unit !== undefined ? UNIT_META[unit] : undefined;
      const usedPercent = clampPercent(toNumber(record.percentage));
      if (usedPercent === undefined) continue;
      const count = toNumber(record.number) ?? 1;
      let label = "Tokens";
      if (meta) {
        label = meta.unit === "w" ? (count === 1 ? "Weekly" : `${count * 7}d`) : `${count}${meta.unit}`;
      }
      windows.push({
        label,
        usedPercent,
        resetsAt,
        windowSeconds: meta ? meta.seconds * count : undefined,
        usedValue: usedPercent,
        limitValue: 100,
        limited: usedPercent >= 100,
        kind: "quota",
      });
      continue;
    }

    if (type === "TIME_LIMIT") {
      const limit = toNumber(record.usage);
      const used = toNumber(record.currentValue);
      if (limit === undefined || limit <= 0 || used === undefined) continue;
      windows.push({
        label: "Web / month",
        usedPercent: clampPercent((used / limit) * 100),
        resetsAt,
        windowSeconds: 30 * 24 * 3600,
        usedValue: used,
        limitValue: limit,
        limited: used >= limit,
        // The monthly web-search quota covers search-prime / web-reader / zread
        // and does not gate coding requests, so it must never make the provider
        // look unusable on its own.
        gating: false,
        kind: "quota",
      });
    }
  }

  windows.sort((a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER));
  return windows;
}

export async function fetchZaiCodingCnUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "zai-coding-cn" as const, fetchedAt: Date.now() };
  const result = await requestJson(
    endpoints.zaiCodingCn,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    { timeoutMs: config.timeoutMs, signal: config.signal },
  );
  if (!result.ok) return { ...base, status: "error", windows: [], error: result.error };
  const windows = parseZaiCodingCn(result.data);
  if (windows.length === 0) return { ...base, status: "error", windows: [], error: "unrecognized response shape" };
  return { ...base, status: "ok", windows };
}
