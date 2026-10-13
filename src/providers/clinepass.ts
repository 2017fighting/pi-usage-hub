/**
 * ClinePass adapter — `clinepass`.
 *
 * Endpoint: GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
 * Auth: `Authorization: Bearer <token>` — a static Cline API key (`sk_…`,
 *       from app.cline.bot → Settings → API Keys) or a WorkOS OAuth access
 *       token (`workos:…`) reused from the Cline CLI. Both shapes are stored
 *       by the ClinePass pi provider in pi's own `auth.json` under
 *       `clinepass`, so this adapter never needs a refresh of its own.
 *
 * Response shape (verified against the live endpoint):
 *   { success: true,
 *     data: { limits: [ { type: "five_hour" | "weekly" | "monthly",
 *                         percentUsed: number,        // 0-100, not a ratio
 *                         resetsAt: string } ] } }    // ISO, 7 fractional digits
 *
 * The three windows are ClinePass's billing caps and they nest (5h ⊂ weekly ⊂
 * monthly): a request has to fit in all of them, so every window gates and they
 * share one implicit group (AND). A window type we do not recognize is ignored
 * rather than guessed at: this endpoint's types are the contract, and inventing
 * a gating window from an unknown one could take ClinePass out of `/usage`'s
 * available list while requests still work.
 *
 * Only the limits endpoint is consulted — no plan/price call. The plan name,
 * its expiry and the dollar cap thresholds live behind a second endpoint
 * (`/plan`), which this hub deliberately does not fetch: a quota window renders
 * as a percentage, so a dollar cap would have nowhere to appear on the row.
 */

import type { FetchConfig, ProviderUsage, QuotaWindow } from "../core/types.js";
import { clampPercent, parseResetTime, requestJson, toNumber } from "../core/format.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";

/** Cline's `limits[].type` values and the window they describe. */
const WINDOW_TYPES: Record<string, { label: string; windowSeconds: number }> = {
  five_hour: { label: "5h", windowSeconds: 5 * 3600 },
  weekly: { label: "Weekly", windowSeconds: 7 * 86_400 },
  monthly: { label: "Monthly", windowSeconds: 30 * 86_400 },
};

/** Pure parser, exported for tests. */
export function parseClinePassLimits(payload: unknown): QuotaWindow[] {
  const data = payload as { data?: { limits?: unknown } } | undefined;
  const limits = data?.data?.limits;
  if (!Array.isArray(limits)) return [];

  const windows: QuotaWindow[] = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (!type) continue;
    const known = WINDOW_TYPES[type];
    // Only the documented caps are rendered; an unknown type is not guessed at.
    if (!known) continue;
    const percent = clampPercent(toNumber(record.percentUsed));
    // A quota window with no percentage cannot be drawn as progress, and this
    // endpoint reports nothing else — skip rather than invent a value.
    if (percent === undefined) continue;

    windows.push({
      label: known.label,
      usedPercent: percent,
      resetsAt: parseResetTime(record.resetsAt),
      windowSeconds: known.windowSeconds,
      usedValue: percent,
      limitValue: 100,
      limited: percent >= 100,
      kind: "quota",
    });
  }

  windows.sort(
    (a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER),
  );
  return windows;
}

/** Turn an HTTP failure into the reason the user can act on. */
function errorForStatus(status: number | undefined, fallback: string): string {
  if (status === 401) return "credential rejected (401) — re-run /login for ClinePass";
  if (status === 403) return "ClinePass subscription required, or access denied (403)";
  return fallback;
}

/**
 * Server-supplied reason from a 200 response that still failed (`success:
 * false`). Control characters are stripped and the length capped: this text
 * reaches the user's terminal, and the hub has no other sanitizer on this path.
 */
function serverReason(payload: unknown): string | undefined {
  const record = payload as { error?: unknown; message?: unknown } | undefined;
  const raw = [record?.error, record?.message].find((value): value is string => typeof value === "string");
  if (!raw) return undefined;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean === "" ? undefined : clean;
}

export async function fetchClinePassUsage(
  token: string,
  config: FetchConfig = {},
  endpoints: UsageEndpoints = resolveEndpoints(config.env),
): Promise<ProviderUsage> {
  const base = { provider: "clinepass" as const, fetchedAt: Date.now() };
  const result = await requestJson(
    endpoints.clinepassUsage,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        // Multiprovider-injected auth headers belong on every request we make.
        ...(config.headers ?? {}),
      },
    },
    { timeoutMs: config.timeoutMs, signal: config.signal },
  );
  if (!result.ok) {
    return { ...base, status: "error", windows: [], error: errorForStatus(result.status, result.error) };
  }
  // An explicit `success: false` fails the call even when the body happens to
  // carry limits, so a rejected request can never render as real quota. A
  // missing flag is tolerated: discarding otherwise valid limits over an absent
  // boolean would break on any proxy that omits it.
  if ((result.data as { success?: unknown } | undefined)?.success === false) {
    return {
      ...base,
      status: "error",
      windows: [],
      error: serverReason(result.data) ?? "ClinePass reported an unsuccessful response",
    };
  }
  const windows = parseClinePassLimits(result.data);
  if (windows.length === 0) {
    return { ...base, status: "error", windows: [], error: "unrecognized response shape" };
  }
  return { ...base, status: "ok", windows };
}
