/**
 * Provider registry: maps a provider key onto its fetcher, plus the Pi provider
 * ids that resolve to it.
 */

import type { FetchConfig, ProviderKey, ProviderUsage } from "../core/types.js";
import { PI_PROVIDER_IDS } from "../core/types.js";
import { resolveEndpoints, type UsageEndpoints } from "../core/endpoints.js";
import { fetchZaiCodingCnUsage } from "./zai-coding-cn.js";
import { fetchCodeBuddyUsage } from "./codebuddy.js";
import { fetchCommandCodeUsage } from "./commandcode.js";
import { fetchDeepSeekUsage } from "./deepseek.js";
import { fetchKimiCodingUsage } from "./kimi-coding.js";
import { fetchAntigravityUsage } from "./antigravity.js";
import { fetchOpenCodeGoUsage } from "./opencode-go.js";

export interface ProviderFetchContext {
  /** The Pi provider id the active model belongs to (e.g. "codebuddy-intl"). */
  piProviderId?: string;
}

export interface ProviderDescriptor {
  key: ProviderKey;
  label: string;
  /** Pi provider ids this adapter handles. */
  piProviderIds: string[];
  /** Fetch usage given a resolved credential (token, or JSON credential for antigravity). */
  fetch: (
    credential: string,
    config: FetchConfig,
    endpoints: UsageEndpoints,
    context: ProviderFetchContext,
  ) => Promise<ProviderUsage>;
  /** How the credential is used, for error messages and documentation. */
  authKind: "bearer" | "google-oauth-json";
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    key: "zai-coding-cn",
    label: "ZAI CN",
    piProviderIds: ["zai-coding-cn"],
    fetch: fetchZaiCodingCnUsage,
    authKind: "bearer",
  },
  {
    key: "codebuddy",
    label: "CodeBuddy",
    piProviderIds: ["codebuddy", "codebuddy-intl"],
    fetch: (credential, config, endpoints, context) =>
      fetchCodeBuddyUsage(credential, config, endpoints, context.piProviderId === "codebuddy-intl" ? "intl" : "cn"),
    authKind: "bearer",
  },
  {
    key: "commandcode",
    label: "CommandCode",
    piProviderIds: ["commandcode"],
    fetch: fetchCommandCodeUsage,
    authKind: "bearer",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    piProviderIds: ["deepseek"],
    fetch: fetchDeepSeekUsage,
    authKind: "bearer",
  },
  {
    key: "kimi-coding",
    label: "Kimi Code",
    piProviderIds: ["kimi-coding"],
    fetch: fetchKimiCodingUsage,
    authKind: "bearer",
  },
  {
    key: "antigravity",
    label: "Antigravity",
    piProviderIds: ["antigravity"],
    fetch: fetchAntigravityUsage,
    authKind: "google-oauth-json",
  },
  {
    key: "opencode-go",
    label: "OpenCode Go",
    piProviderIds: ["opencode-go"],
    fetch: fetchOpenCodeGoUsage,
    authKind: "bearer",
  },
];

export function providerByKey(key: ProviderKey): ProviderDescriptor | undefined {
  return PROVIDERS.find((provider) => provider.key === key);
}

/** Map a Pi provider id (possibly a virtual/multiprovider id) onto a provider key. */
export function detectProviderKey(piProviderId: string | undefined): ProviderKey | undefined {
  if (!piProviderId) return undefined;
  const normalized = piProviderId.toLowerCase();
  if (normalized in PI_PROVIDER_IDS) return PI_PROVIDER_IDS[normalized];
  const direct = PROVIDERS.find((provider) => provider.piProviderIds.includes(normalized));
  return direct?.key;
}

export { resolveEndpoints };
