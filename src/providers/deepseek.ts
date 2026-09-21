/**
 * DeepSeek adapter — `deepseek`.
 *
 * Endpoint: GET https://api.deepseek.com/user/balance
 * Auth: `Authorization: Bearer <DEEPSEEK_API_KEY>`
 *
 * Response shape:
 *   { is_available: boolean,
 *     balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * DeepSeek is a pay-as-you-go balance with no reset time, so it produces a
 * single `balance` window. Exhaustion is `total_balance <= 0`.
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

/** Pure parser, exported for tests. */
export function parseDeepSeekBalance(payload: unknown): { windows: QuotaWindow[]; isAvailable?: boolean } {
  const data = payload as {
    is_available?: unknown;
    balance_infos?: unknown;
  } | undefined;
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const windows: QuotaWindow[] = [];

  for (const entry of infos) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const total = toNumber(record.total_balance);
    if (total === undefined) continue;
    const currency = typeof record.currency === "string" ? record.currency.toUpperCase() : undefined;
    const granted = toNumber(record.granted_balance);
    const toppedUp = toNumber(record.topped_up_balance);
    const details = [
      toppedUp !== undefined ? `topped-up ${formatAmount(toppedUp, currency)}` : undefined,
      granted !== undefined ? `granted ${formatAmount(granted, currency)}` : undefined,
    ].filter((value): value is string => value !== undefined);

    windows.push({
      label: "Balance",
      balanceValue: total,
      resetsAt: undefined,
      isCurrency: true,
      currency,
      limited: total <= 0,
      isBalance: true,
      // The amount is rendered from balanceValue; the note carries only the
      // breakdown so it is not repeated.
      note: details.length > 0 ? details.join(" · ") : undefined,
      kind: "balance",
    });
  }

  return {
    windows,
    isAvailable: typeof data?.is_available === "boolean" ? data.is_available : undefined,
  };
}

function formatAmount(value: number, currency?: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency && currency.length === 3 ? currency : "USD",
    }).format(value);
  } catch {
    return `${value} ${currency ?? ""}`.trim();
  }
}

export async function fetchDeepSeekUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "deepseek" as const, fetchedAt: Date.now() };
  const result = await requestJson(
    endpoints.deepseekBalance,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    { timeoutMs: config.timeoutMs, signal: config.signal },
  );
  if (!result.ok) return { ...base, status: "error", windows: [], error: result.error };
  const { windows, isAvailable } = parseDeepSeekBalance(result.data);
  if (windows.length === 0) return { ...base, status: "error", windows: [], error: "unrecognized response shape" };
  const notice = isAvailable === false ? "account reported as unavailable" : undefined;
  return { ...base, status: "ok", windows, notice };
}
