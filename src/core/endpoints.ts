/**
 * Default endpoints for every provider, each overridable through an
 * environment variable. Several of these providers are reverse-engineered
 * subscription surfaces, so endpoint drift is expected; env overrides let a
 * fix ship without a code change.
 */

export interface UsageEndpoints {
  zaiCodingCn: string;
  codebuddyCn: string;
  codebuddyIntl: string;
  commandcodeWhoami: string;
  commandcodeCredits: string;
  commandcodeSubscriptions: string;
  commandcodeUsageSummary: string;
  deepseekBalance: string;
  kimiCoding: string;
  antigravity: string;
  opencodeGo: string;
  opencodeGoConfig: string;
}

const DEFAULTS: UsageEndpoints = {
  zaiCodingCn: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  codebuddyCn: "https://www.codebuddy.cn",
  codebuddyIntl: "https://www.codebuddy.ai",
  commandcodeWhoami: "https://api.commandcode.ai/alpha/whoami",
  commandcodeCredits: "https://api.commandcode.ai/alpha/billing/credits",
  commandcodeSubscriptions: "https://api.commandcode.ai/alpha/billing/subscriptions",
  commandcodeUsageSummary: "https://api.commandcode.ai/alpha/usage/summary",
  deepseekBalance: "https://api.deepseek.com/user/balance",
  kimiCoding: "https://api.kimi.com/coding/v1/usages",
  antigravity: "https://daily-cloudcode-pa.googleapis.com",
  opencodeGo: "https://opencode.ai/zen/go/v1/usage",
  opencodeGoConfig: "https://opencode.ai/zen/go/v1/config",
};

const ENV_KEYS: Record<keyof UsageEndpoints, string> = {
  zaiCodingCn: "PI_ZAI_CODING_CN_USAGE_ENDPOINT",
  codebuddyCn: "PI_CODEBUDDY_CN_ENDPOINT",
  codebuddyIntl: "PI_CODEBUDDY_INTL_ENDPOINT",
  commandcodeWhoami: "PI_COMMANDCODE_WHOAMI_ENDPOINT",
  commandcodeCredits: "PI_COMMANDCODE_CREDITS_ENDPOINT",
  commandcodeSubscriptions: "PI_COMMANDCODE_SUBSCRIPTIONS_ENDPOINT",
  commandcodeUsageSummary: "PI_COMMANDCODE_USAGE_SUMMARY_ENDPOINT",
  deepseekBalance: "PI_DEEPSEEK_BALANCE_ENDPOINT",
  kimiCoding: "PI_KIMI_USAGE_ENDPOINT",
  antigravity: "PI_ANTIGRAVITY_ENDPOINT",
  opencodeGo: "PI_OPENCODE_GO_USAGE_ENDPOINT",
  opencodeGoConfig: "PI_OPENCODE_GO_CONFIG_ENDPOINT",
};

/** Resolve every endpoint against the process env (or an injected env for tests). */
export function resolveEndpoints(env: Record<string, string | undefined> = process.env): UsageEndpoints {
  const resolved = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof UsageEndpoints)[]) {
    const override = env[ENV_KEYS[key]];
    if (typeof override === "string" && override.trim() !== "") resolved[key] = override.trim();
  }
  return resolved;
}

export const DEFAULT_ENDPOINTS = DEFAULTS;
export { ENV_KEYS as ENDPOINT_ENV_KEYS };
