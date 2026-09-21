/**
 * CodeBuddy adapter — `codebuddy` (Tencent CodeBuddy, CN + intl).
 *
 * CodeBuddy sells credit packages rather than rolling token windows. The
 * billing surface is reachable with the CodeBuddy OAuth JWT that Pi stores for
 * the `codebuddy` / `codebuddy-intl` providers (verified against the live
 * service: `Authorization: Bearer <jwt>` + `x-client-platform: web` is enough;
 * no browser cookie is required).
 *
 *   POST /billing/meter/get-user-resource-summary          → all packages: total/used/remaining
 *   POST /billing/meter/get-user-resource-free-packages    → per-package cycle end (reset time)
 *   POST /billing/meter/get-user-request-usage             → recent per-request credit spend
 *
 * Availability = sum of every package's `CycleRemainCapacity` > 0. The soonest
 * `CycleEndTime` across packages is the reset used for sorting.
 *
 * `PackageCodes` is a required filter on the free-packages endpoint and is fed
 * from the summary response.
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

export interface CodeBuddyPackage {
  packageCode: string;
  total: number;
  used: number;
  remaining: number;
  unit: string;
  /** Package display name, when the free-packages endpoint provides one. */
  name?: string;
  resetsAt?: number;
}

/** Parse the resource-summary payload into one entry per credit package. */
export function parseCodeBuddySummary(payload: unknown): CodeBuddyPackage[] {
  const data = payload as { data?: { Packages?: unknown; IsPaidUser?: unknown } } | undefined;
  const packages = data?.data?.Packages;
  if (!Array.isArray(packages)) return [];

  const parsed: CodeBuddyPackage[] = [];
  for (const entry of packages) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const packageCode = typeof record.PackageCode === "string" ? record.PackageCode : undefined;
    if (!packageCode) continue;
    const total = toNumber(record.CycleTotalCapacity) ?? 0;
    const used = toNumber(record.CycleUsedCapacity) ?? 0;
    const remaining = toNumber(record.CycleRemainCapacity) ?? Math.max(0, total - used);
    parsed.push({
      packageCode,
      total,
      used,
      remaining,
      unit: typeof record.CapacityUnit === "string" ? record.CapacityUnit : "credits",
    });
  }
  return parsed;
}

/** Merge cycle end times (and names) from the free-packages payload. */
export function applyCodeBuddyPackageDetails(packages: CodeBuddyPackage[], payload: unknown): CodeBuddyPackage[] {
  const data = payload as { data?: { Accounts?: unknown } } | undefined;
  const accounts = data?.data?.Accounts;
  if (!Array.isArray(accounts)) return packages;

  const byCode = new Map<string, { resetsAt?: number; name?: string }>();
  for (const entry of accounts) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const packageCode = typeof record.PackageCode === "string" ? record.PackageCode : undefined;
    if (!packageCode) continue;
    byCode.set(packageCode, {
      resetsAt: parseResetTime(record.CycleEndTime) ?? parseResetTime(record.DeductionEndTime),
      name: typeof record.PackageName === "string" ? record.PackageName : undefined,
    });
  }

  return packages.map((entry) => {
    const detail = byCode.get(entry.packageCode);
    if (!detail) return entry;
    return { ...entry, resetsAt: detail.resetsAt ?? entry.resetsAt, name: detail.name ?? entry.name };
  });
}

/** Convert packages into quota windows: one per package plus a combined total. */
export function codeBuddyWindows(packages: CodeBuddyPackage[]): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const totalRemaining = packages.reduce((sum, entry) => sum + Math.max(0, entry.remaining), 0);
  const totalCapacity = packages.reduce((sum, entry) => sum + Math.max(0, entry.total), 0);

  if (packages.length === 0) return windows;

  // Combined total is the headline window: it answers "can I still use CodeBuddy?".
  windows.push({
    label: "Total credits",
    usedPercent: totalCapacity > 0 ? clampPercent((1 - totalRemaining / totalCapacity) * 100) : undefined,
    resetsAt: soonestPackageReset(packages),
    balanceValue: totalRemaining,
    limitValue: totalCapacity,
    limited: totalRemaining <= 0,
    isBalance: true,
    kind: "balance",
    note: `${totalRemaining.toFixed(2)} / ${totalCapacity.toFixed(2)} credits`,
  });

  for (const entry of packages) {
    windows.push({
      label: entry.name ?? entry.packageCode,
      usedPercent: entry.total > 0 ? clampPercent((entry.used / entry.total) * 100) : undefined,
      resetsAt: entry.resetsAt,
      balanceValue: entry.remaining,
      limitValue: entry.total,
      limited: entry.remaining <= 0,
      isBalance: true,
      kind: "balance",
      note: `${entry.remaining.toFixed(2)} / ${entry.total.toFixed(2)} ${entry.unit}`,
    });
  }

  return windows;
}

function soonestPackageReset(packages: CodeBuddyPackage[]): number | undefined {
  const resets = packages
    .map((entry) => entry.resetsAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (resets.length === 0) return undefined;
  return Math.min(...resets);
}

export async function fetchCodeBuddyUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
  region: "cn" | "intl" = "cn",
): Promise<ProviderUsage> {
  const base = { provider: "codebuddy" as const, fetchedAt: Date.now() };
  const origin = region === "cn" ? endpoints.codebuddyCn : endpoints.codebuddyIntl;
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-client-platform": "web",
    accept: "application/json",
    ...(config.headers ?? {}),
  };
  const requestConfig = { timeoutMs: config.timeoutMs, signal: config.signal };

  const summary = await requestJson(
    `${origin}/billing/meter/get-user-resource-summary`,
    { method: "POST", headers, body: "{}" },
    requestConfig,
  );
  if (!summary.ok) {
    const hint = summary.status === 401 || summary.status === 403 ? "CodeBuddy rejected the token" : summary.error;
    return { ...base, status: "error", windows: [], error: hint };
  }

  let packages = parseCodeBuddySummary(summary.data);
  if (packages.length === 0) {
    return { ...base, status: "ok", windows: [], notice: "no credit packages on this account" };
  }

  const details = await requestJson(
    `${origin}/billing/meter/get-user-resource-free-packages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 200,
        Status: [0],
        PackageCodes: packages.map((entry) => entry.packageCode),
      }),
    },
    requestConfig,
  );
  if (details.ok) packages = applyCodeBuddyPackageDetails(packages, details.data);

  return { ...base, status: "ok", windows: codeBuddyWindows(packages) };
}
