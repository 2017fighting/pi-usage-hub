/**
 * Core types for pi-usage-hub.
 *
 * The central data model is a list of generic quota windows per provider
 * (`QuotaWindow[]`), rather than a fixed session/weekly pair. Providers differ
 * wildly in shape: subscription plans expose 5h/weekly token windows, CodeBuddy
 * exposes multiple credit packages with per-package cycle end times, DeepSeek
 * exposes only a currency balance with no reset, Antigravity exposes per-model
 * pool-shared fractions.
 */

/** Stable provider identifiers used throughout the plugin. */
export type ProviderKey =
  | "zai-coding-cn"
  | "codebuddy"
  | "commandcode"
  | "deepseek"
  | "kimi-coding"
  | "antigravity"
  | "opencode-go";

/** Pi provider ids that map onto our provider keys (some providers register several ids). */
export const PI_PROVIDER_IDS: Record<string, ProviderKey> = {
  "zai-coding-cn": "zai-coding-cn",
  zai: "zai-coding-cn", // global zai is not tracked, but maps for detection only
  codebuddy: "codebuddy",
  "codebuddy-intl": "codebuddy",
  commandcode: "commandcode",
  deepseek: "deepseek",
  "kimi-coding": "kimi-coding",
  antigravity: "antigravity",
  "opencode-go": "opencode-go",
};

/** Registry order — used as the primary sort key for "available" providers. */
export const PROVIDER_ORDER: ProviderKey[] = [
  "zai-coding-cn",
  "codebuddy",
  "commandcode",
  "deepseek",
  "kimi-coding",
  "antigravity",
  "opencode-go",
];

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  "zai-coding-cn": "ZAI CN",
  codebuddy: "CodeBuddy",
  commandcode: "CommandCode",
  deepseek: "DeepSeek",
  "kimi-coding": "Kimi Code",
  antigravity: "Antigravity",
  "opencode-go": "OpenCode Go",
};

export type WindowKind = "quota" | "balance";

/** A single quota window or balance line. */
export interface QuotaWindow {
  /** Short human label, e.g. "5h", "Weekly", "Monthly", "Credits", "Balance". */
  label: string;
  /** 0-100 used percentage. Absent for pure balance rows. */
  usedPercent?: number;
  /** Absolute reset time (epoch ms). Absent when the provider exposes none (e.g. pay-as-you-go balance). */
  resetsAt?: number;
  /** Window length in seconds when known (used for ordering windows inside a provider). */
  windowSeconds?: number;
  /** Raw used amount for display (credits, currency, requests). */
  usedValue?: number;
  /** Raw limit amount for display. */
  limitValue?: number;
  /** True when the values are currency amounts rather than counts. */
  isCurrency?: boolean;
  /** ISO currency code when isCurrency. */
  currency?: string;
  /**
   * True when this specific window has no room left (usedPercent >= 100, or a
   * balance at/below zero). A provider can still be usable when another group
   * has room, so availability must be computed with `availabilityOf`, never from
   * a single window.
   */
  limited?: boolean;
  /** True when the provider exposes no meaningful percentage and only a balance. */
  isBalance?: boolean;
  /** Remaining balance for `kind: "balance"` windows (currency amount). */
  balanceValue?: number;
  /** Optional extra detail line (e.g. "topped-up $10.00 · granted $5.00"). */
  note?: string;
  /**
   * Windows sharing a group must ALL have room for the provider to be usable
   * (logical AND) — this is how a 5h window and a weekly cap combine. Separate
   * groups are alternatives (logical OR): CodeBuddy credit packages, and
   * Antigravity's independent Gemini vs Claude/GPT pools.
   */
  group?: string;
  /**
   * Whether this window gates usability. Defaults to true. Set false for
   * informational windows that do not block the provider, e.g. ZAI's monthly
   * web-search quota, which has no bearing on coding requests.
   */
  gating?: boolean;
  kind: WindowKind;
}

/** Freshness/error state of a single provider fetch. */
export type FetchStatus = "ok" | "unconfigured" | "unsupported" | "error";

export interface ProviderUsage {
  provider: ProviderKey;
  /** Account label when the provider is a multiprovider pool with multiple accounts. */
  accountLabel?: string;
  /** Multiprovider account id, when known. */
  accountId?: string;
  status: FetchStatus;
  windows: QuotaWindow[];
  /** Human readable error / notice, when status is error or a soft notice applies. */
  error?: string;
  notice?: string;
  /** When the data was fetched (epoch ms). */
  fetchedAt: number;
  /** True when served from cache rather than freshly fetched. */
  stale?: boolean;
  /** Local multiprovider cooldown in ms from now, when the account is cooling down. */
  cooldownMs?: number;
}

/** Overall availability of a provider, used for sorting in /usage. */
export type Availability = "available" | "exhausted" | "unknown";

export interface FetchConfig {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra headers merged into every request (used by multiprovider-injected auth). */
  headers?: Record<string, string>;
}
