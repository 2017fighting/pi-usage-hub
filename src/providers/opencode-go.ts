/**
 * OpenCode Go adapter — `opencode-go`.
 *
 * Endpoint: GET https://opencode.ai/zen/go/v1/usage
 * Auth: `Authorization: Bearer <OPENCODE_GO_API_KEY>`
 *
 * Response shape:
 *   { usage: { rolling?: { percent, resetsAt }, weekly?: {...}, monthly?: {...} } }
 *
 * Percentages are computed server-side, so this adapter is a thin mapper.
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

interface UsageSegment {
  percent?: unknown;
  resetsAt?: unknown;
}

const SEGMENTS: Array<{ key: "rolling" | "weekly" | "monthly"; label: string; seconds: number }> = [
  { key: "rolling", label: "5h", seconds: 5 * 3600 },
  { key: "weekly", label: "Weekly", seconds: 7 * 86_400 },
  { key: "monthly", label: "Monthly", seconds: 30 * 86_400 },
];

/** Pure parser, exported for tests. */
export function parseOpenCodeGoUsage(payload: unknown): QuotaWindow[] {
  const data = payload as { usage?: Record<string, UsageSegment> } | undefined;
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return [];

  const windows: QuotaWindow[] = [];
  for (const segment of SEGMENTS) {
    const entry = usage[segment.key];
    if (!entry || typeof entry !== "object") continue;
    const percent = clampPercent(toNumber(entry.percent));
    if (percent === undefined) continue;
    windows.push({
      label: segment.label,
      usedPercent: percent,
      resetsAt: parseResetTime(entry.resetsAt),
      windowSeconds: segment.seconds,
      usedValue: percent,
      limitValue: 100,
      limited: percent >= 100,
      kind: "quota",
    });
  }
  return windows;
}

export async function fetchOpenCodeGoUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "opencode-go" as const, fetchedAt: Date.now() };
  const result = await requestJson(
    endpoints.opencodeGo,
    { headers: { Authorization: `Bearer ${token}`, accept: "application/json", ...(config.headers ?? {}) } },
    { timeoutMs: config.timeoutMs, signal: config.signal },
  );
  if (!result.ok) return { ...base, status: "error", windows: [], error: result.error };
  const windows = parseOpenCodeGoUsage(result.data);
  if (windows.length === 0) return { ...base, status: "error", windows: [], error: "unrecognized response shape" };
  return { ...base, status: "ok", windows };
}
