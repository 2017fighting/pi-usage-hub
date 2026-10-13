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
  clinepassUsage: string;
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
  clinepassUsage: "https://api.cline.bot/api/v1/users/me/plan/usage-limits",
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
  clinepassUsage: "PI_CLINEPASS_USAGE_ENDPOINT",
};

/**
 * ClinePass path appended to the ecosystem's own base override. Both ClinePass
 * pi packages honour `CLINE_API_BASE` for chat traffic, so the usage endpoint
 * has to follow it too: reporting quota from the real Cline API while chat goes
 * through a proxy would describe a different account. The exact-endpoint
 * variable above still wins over the derived one.
 */
const CLINEPASS_BASE_ENV = "CLINE_API_BASE";
const CLINEPASS_USAGE_PATH = "/api/v1/users/me/plan/usage-limits";

/** Resolve every endpoint against the process env (or an injected env for tests). */
export function resolveEndpoints(env: Record<string, string | undefined> = process.env): UsageEndpoints {
  const resolved = { ...DEFAULTS };
  const overridden = new Set<keyof UsageEndpoints>();
  for (const key of Object.keys(DEFAULTS) as (keyof UsageEndpoints)[]) {
    const override = env[ENV_KEYS[key]];
    if (typeof override === "string" && override.trim() !== "") {
      resolved[key] = override.trim();
      overridden.add(key);
    }
  }
  const base = env[CLINEPASS_BASE_ENV]?.trim().replace(/\/+$/, "");
  if (base && !overridden.has("clinepassUsage")) {
    resolved.clinepassUsage = `${base}${CLINEPASS_USAGE_PATH}`;
  }
  return resolved;
}

export const DEFAULT_ENDPOINTS = DEFAULTS;
export { ENV_KEYS as ENDPOINT_ENV_KEYS };
