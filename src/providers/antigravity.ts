/**
 * Google Antigravity (CloudCode) adapter — `antigravity`.
 *
 * Auth is Google OAuth. Pi hands the credential out through
 * `modelRegistry.getApiKeyForProvider("antigravity")` as a JSON string of the
 * shape `{"token": "...", "projectId": "..."}` (not a bare token).
 *
 * Quota surfaces, in preference order:
 *  1. POST {endpoint}/v1internal:retrieveUserQuotaSummary
 *     → { groups: [{ displayName, buckets: [{ bucketId, displayName, window,
 *         resetTime, remainingFraction }] }] }
 *     Grouped pools (Gemini, Claude+GPT) with 5h/weekly buckets. Best data.
 *  2. POST {endpoint}/v1internal:fetchAvailableModels  { project }
 *     → { models: { id: { displayName, quotaInfo: { remainingFraction, resetTime } } } }
 *     Per-model quota, pool-shared rather than a private per-model budget. This
 *     is the fallback when the quota summary is gated (HTTP 403
 *     SUBSCRIPTION_REQUIRED / #3501) or otherwise unavailable.
 *
 * `projectId` comes from the credential; `ANTIGRAVITY_PROJECT_ID` overrides it.
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

const USER_AGENT =
  "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";

export interface AntigravityCredential {
  token: string;
  projectId?: string;
}

/** Split the JSON credential Pi hands out, falling back to treating it as a bare token. */
export function parseAntigravityCredential(raw: string): AntigravityCredential {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: unknown; access?: unknown; projectId?: unknown };
      const token = typeof parsed.token === "string" ? parsed.token : typeof parsed.access === "string" ? parsed.access : undefined;
      if (token) {
        return {
          token,
          projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
        };
      }
    } catch {
      // fall through to the bare-token interpretation
    }
  }
  return { token: trimmed };
}

/** Parse the grouped quota-summary payload into one window per bucket. */
export function parseAntigravityQuotaSummary(payload: unknown): QuotaWindow[] {
  const data = payload as { groups?: unknown } | undefined;
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const windows: QuotaWindow[] = [];

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const groupRecord = group as Record<string, unknown>;
    const groupName = typeof groupRecord.displayName === "string" ? groupRecord.displayName : "Quota";
    const buckets = Array.isArray(groupRecord.buckets) ? groupRecord.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const record = bucket as Record<string, unknown>;
      const remaining = toNumber(record.remainingFraction);
      if (remaining === undefined) continue;
      const remainingPercent = clampPercent(remaining * 100);
      if (remainingPercent === undefined) continue;
      const windowName = typeof record.window === "string" ? record.window : undefined;
      const label = `${shortGroupName(groupName)} ${windowLabel(windowName)}`;
      windows.push({
        label,
        usedPercent: clampPercent(100 - remainingPercent),
        resetsAt: parseResetTime(record.resetTime),
        windowSeconds: windowName === "5h" ? 5 * 3600 : windowName === "weekly" ? 7 * 86_400 : undefined,
        usedValue: 100 - remainingPercent,
        limitValue: 100,
        limited: remainingPercent <= 0,
        kind: "quota",
      });
    }
  }

  return windows.sort(
    (a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Fallback: per-model quota entries, reduced to the worst (lowest) remaining fraction. */
export function parseAntigravityAvailableModels(payload: unknown): QuotaWindow[] {
  const data = payload as { models?: unknown } | undefined;
  if (!data?.models || typeof data.models !== "object") return [];
  const entries = Object.entries(data.models as Record<string, unknown>);
  const windows: QuotaWindow[] = [];

  for (const [modelId, value] of entries) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const quota = record.quotaInfo as Record<string, unknown> | undefined;
    if (!quota) continue;
    const remaining = toNumber(quota.remainingFraction);
    if (remaining === undefined) continue;
    const remainingPercent = clampPercent(remaining * 100) ?? 0;
    const displayName = typeof record.displayName === "string" ? record.displayName : modelId;
    windows.push({
      label: displayName,
      usedPercent: clampPercent(100 - remainingPercent),
      resetsAt: parseResetTime(quota.resetTime),
      usedValue: 100 - remainingPercent,
      limitValue: 100,
      limited: remainingPercent <= 0,
      kind: "quota",
      note: "pool-shared",
    });
  }

  // Surface the most-constrained model first so the footer shows the real risk.
  return windows.sort((a, b) => (a.usedPercent ?? 0) - (b.usedPercent ?? 0)).reverse();
}

function shortGroupName(name: string): string {
  if (/gemini/i.test(name) && !/claude|gpt/i.test(name)) return "Gemini";
  if (/claude|gpt/i.test(name)) return "Claude/GPT";
  return name.replace(/\s*models?$/i, "").slice(0, 14);
}

function windowLabel(window: string | undefined): string {
  if (!window) return "";
  if (window === "weekly") return "Weekly";
  return window;
}

export async function fetchAntigravityUsage(
  credential: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "antigravity" as const, fetchedAt: Date.now() };
  const { token, projectId: credentialProject } = parseAntigravityCredential(credential);
  const projectId = config.env?.ANTIGRAVITY_PROJECT_ID ?? credentialProject;
  const endpoint = endpoints.antigravity.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    ...(config.headers ?? {}),
  };
  const requestConfig = { timeoutMs: config.timeoutMs, signal: config.signal };

  const summary = await requestJson(
    `${endpoint}/v1internal:retrieveUserQuotaSummary`,
    { method: "POST", headers, body: "{}" },
    requestConfig,
  );
  if (summary.ok) {
    const windows = parseAntigravityQuotaSummary(summary.data);
    if (windows.length > 0) return { ...base, status: "ok", windows };
  }

  // Fallback to the per-model catalog, which is available on every tier.
  const models = await requestJson(
    `${endpoint}/v1internal:fetchAvailableModels`,
    { method: "POST", headers, body: JSON.stringify({ project: projectId ?? "" }) },
    requestConfig,
  );
  if (!models.ok) {
    const error = !summary.ok ? summary.error : models.error;
    return { ...base, status: "error", windows: [], error };
  }
  const windows = parseAntigravityAvailableModels(models.data);
  if (windows.length === 0) {
    return { ...base, status: "error", windows: [], error: "unrecognized quota response" };
  }
  return { ...base, status: "ok", windows, notice: "per-model quota (pool-shared)" };
}
