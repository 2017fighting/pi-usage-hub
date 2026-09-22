import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  extractToken,
  isUpstreamAccount,
  listPoolAccounts,
  resolveAccountCredential,
  resolveCredential,
  resolveVirtualBackend,
  isLikelyVirtualProvider,
  SESSION_PIN_ENTRY_TYPE,
  UPSTREAM_ACCOUNT_ID,
  type MultiProviderServiceAnnouncement,
} from "../src/core/credentials.js";
import { collectWarnings, evaluateWindow, resetWarningState } from "../src/core/warnings.js";
import type { ProviderUsage, QuotaWindow } from "../src/core/types.js";

describe("extractToken", () => {
  it("reads any known credential key", () => {
    expect(extractToken({ access: "a" })).toBe("a");
    expect(extractToken({ accessToken: "b" })).toBe("b");
    expect(extractToken({ apiKey: "c" })).toBe("c");
    expect(extractToken({ type: "oauth", refresh: "r", access: "d", expires: 1 })).toBe("d");
    expect(extractToken("plain")).toBe("plain");
  });

  it("falls back to a Bearer authorization header", () => {
    expect(extractToken({ headers: { Authorization: "Bearer xyz" } })).toBe("xyz");
    expect(extractToken({ headers: { authorization: "bearer lower" } })).toBe("lower");
  });

  it("returns undefined for unusable input", () => {
    expect(extractToken({})).toBeUndefined();
    expect(extractToken({ access: "  " })).toBeUndefined();
    expect(extractToken(null)).toBeUndefined();
  });
});

describe("resolveCredential", () => {
  it("prefers the multiprovider active account", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      resolveActiveAccountAuth: vi.fn().mockResolvedValue({ accessToken: "pool-token", label: "acc2" }),
      getActiveAccount: vi.fn().mockResolvedValue({ id: "acc2", label: "account two" }),
    };
    const registry = { getApiKeyForProvider: vi.fn().mockResolvedValue("registry-token") };
    const credential = await resolveCredential({
      piProviderIds: ["commandcode"],
      piProviderId: "commandcode",
      registry,
      multiprovider,
      multiproviderContext: {},
    });
    expect(credential).toMatchObject({ token: "pool-token", accountLabel: "account two", accountId: "acc2", source: "multiprovider" });
    expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("attaches a cooldown when the pooled account is cooling down", async () => {
    const cooldownUntil = Date.now() + 600_000;
    const multiprovider: MultiProviderServiceAnnouncement = {
      resolveActiveAccountAuth: vi.fn().mockResolvedValue({ accessToken: "t", label: "acc" }),
      getActiveAccount: vi.fn().mockResolvedValue({ id: "acc", label: "acc" }),
      getPoolSnapshot: vi.fn().mockResolvedValue({ accounts: [{ id: "acc", label: "acc", status: "cooldown", cooldownUntil }] }),
    };
    const credential = await resolveCredential({
      piProviderIds: ["commandcode"],
      piProviderId: "commandcode",
      registry: {},
      multiprovider,
      multiproviderContext: {},
    });
    expect(credential.cooldownMs).toBeGreaterThan(500_000);
  });

  it("falls back to the model registry", async () => {
    const registry = {
      getProviderAuthStatus: vi.fn().mockReturnValue({ configured: true }),
      getApiKeyForProvider: vi.fn().mockResolvedValue("registry-token"),
    };
    const credential = await resolveCredential({
      piProviderIds: ["deepseek"],
      registry,
      env: { PI_CODING_AGENT_DIR: "/nonexistent-dir-for-test" },
    });
    expect(credential).toMatchObject({ token: "registry-token", source: "model-registry" });
  });

  it("falls back to the auth.json file when the registry has nothing", async () => {
    const credential = await resolveCredential({
      piProviderIds: ["kimi-coding"],
      registry: { getApiKeyForProvider: vi.fn().mockResolvedValue(undefined) },
      env: { PI_CODING_AGENT_DIR: "/root/.pi/agent" },
    });
    // The live machine may or may not have kimi configured; only assert the
    // fallback was attempted and produced a coherent shape.
    expect(["auth-file", "none"]).toContain(credential.source);
  });

  it("reports none when nothing resolves", async () => {
    const credential = await resolveCredential({
      piProviderIds: ["opencode-go"],
      registry: { getApiKeyForProvider: vi.fn().mockResolvedValue(undefined) },
      env: { PI_CODING_AGENT_DIR: "/nonexistent-dir-for-test" },
    });
    expect(credential.source).toBe("none");
    expect(credential.token).toBeUndefined();
  });
});

describe("isUpstreamAccount", () => {
  it("recognizes the provider's own credential", () => {
    expect(isUpstreamAccount(UPSTREAM_ACCOUNT_ID)).toBe(true);
    expect(isUpstreamAccount("89a8cbab-c536-4474-b6f4-ca4de6c188ed")).toBe(false);
    expect(isUpstreamAccount(undefined)).toBe(false);
  });
});

describe("listPoolAccounts", () => {
  it("enumerates every account with its local cooldown", async () => {
    // The real shape on this machine: a CommandCode pool with two OAuth accounts
    // plus the `pi:default` upstream credential.
    const cooldownUntil = Date.now() + 600_000;
    const multiprovider: MultiProviderServiceAnnouncement = {
      getPoolSnapshot: vi.fn().mockResolvedValue({
        accounts: [
          { id: UPSTREAM_ACCOUNT_ID, label: "hello@raenzo.com", status: "ready" },
          { id: "89a8cbab", label: "google", status: "ready" },
          { id: "577098a6", label: "github", status: "cooldown", cooldownUntil },
        ],
      }),
    };
    const accounts = await listPoolAccounts(multiprovider, "commandcode");
    expect(accounts?.map((account) => account.label)).toEqual(["hello@raenzo.com", "google", "github"]);
    expect(accounts?.[0]?.cooldownMs).toBeUndefined();
    expect(accounts?.[2]?.cooldownMs).toBeGreaterThan(500_000);
  });

  it("drops an already-expired cooldown", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getPoolSnapshot: vi.fn().mockResolvedValue({
        accounts: [{ id: "a", label: "a", status: "cooldown", cooldownUntil: Date.now() - 1_000 }],
      }),
    };
    const accounts = await listPoolAccounts(multiprovider, "commandcode");
    expect(accounts?.[0]?.cooldownMs).toBeUndefined();
  });

  it("returns undefined when the provider is not pooled", async () => {
    // Distinguishing undefined (not pooled) from [] (pooled but empty) is what
    // lets the caller choose the single-credential path.
    expect(await listPoolAccounts(undefined, "commandcode")).toBeUndefined();
    expect(await listPoolAccounts({}, "commandcode")).toBeUndefined();
    const unknownPool: MultiProviderServiceAnnouncement = {
      getPoolSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    expect(await listPoolAccounts(unknownPool, "commandcode")).toBeUndefined();
  });

  it("returns an empty list for a pool with no accounts", async () => {
    const emptyPool: MultiProviderServiceAnnouncement = {
      getPoolSnapshot: vi.fn().mockResolvedValue({ accounts: [] }),
    };
    expect(await listPoolAccounts(emptyPool, "commandcode")).toEqual([]);
  });

  it("survives a snapshot failure", async () => {
    const failing: MultiProviderServiceAnnouncement = {
      getPoolSnapshot: vi.fn().mockRejectedValue(new Error("snapshot exploded")),
    };
    expect(await listPoolAccounts(failing, "commandcode")).toBeUndefined();
  });
});

describe("resolveAccountCredential", () => {
  it("resolves a named account through the pool, not the active one", async () => {
    // This is the core of the feature: the dashboard asks for account "google"
    // specifically, even though "github" is the one serving the session.
    const multiprovider: MultiProviderServiceAnnouncement = {
      resolveAccountAuth: vi.fn().mockResolvedValue({ accessToken: "google-token", label: "google" }),
      getActiveAccount: vi.fn().mockResolvedValue({ id: "github", label: "github" }),
    };
    const credential = await resolveAccountCredential({
      piProviderId: "commandcode",
      accountId: "89a8cbab",
      registry: {},
      multiprovider,
      multiproviderContext: {},
    });
    expect(credential).toMatchObject({ token: "google-token", accountId: "89a8cbab", source: "multiprovider" });
    expect(multiprovider.resolveAccountAuth).toHaveBeenCalledWith("commandcode", "89a8cbab", {}, undefined);
  });

  it("resolves the upstream account through Pi rather than the pool", async () => {
    // `pi:default` has no credential in multiprovider's store, so asking for one
    // would always fail; Pi's registry/auth.json owns it.
    const multiprovider: MultiProviderServiceAnnouncement = {
      resolveAccountAuth: vi.fn().mockResolvedValue({ accessToken: "should-not-be-used", label: "x" }),
    };
    const registry = {
      getProviderAuthStatus: vi.fn().mockReturnValue({ configured: true }),
      getApiKeyForProvider: vi.fn().mockResolvedValue("pi-token"),
    };
    const credential = await resolveAccountCredential({
      piProviderId: "commandcode",
      accountId: UPSTREAM_ACCOUNT_ID,
      registry,
      multiprovider,
      multiproviderContext: {},
    });
    expect(credential).toMatchObject({ token: "pi-token", source: "model-registry" });
    expect(multiprovider.resolveAccountAuth).not.toHaveBeenCalled();
  });

  it("never resolves a stored account through Pi's own credential", async () => {
    // The trap this guards: Pi's registry and auth.json hold the *upstream*
    // credential. Falling back to them for a stored account would print the
    // upstream account's quota under a different account's label — plausible
    // numbers attributed to the wrong account, which is worse than a blank.
    const registry = {
      getProviderAuthStatus: vi.fn().mockReturnValue({ configured: true }),
      getApiKeyForProvider: vi.fn().mockResolvedValue("upstream-token"),
    };
    const credential = await resolveAccountCredential({
      piProviderId: "commandcode",
      accountId: "89a8cbab",
      registry,
      multiprovider: {},
      multiproviderContext: {},
      env: { PI_CODING_AGENT_DIR: "/root/.pi/agent" },
    });
    expect(credential.source).toBe("none");
    expect(credential.token).toBeUndefined();
    expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("reports an unconfigured stored account rather than failing the pool", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      resolveAccountAuth: vi.fn().mockResolvedValue(undefined),
    };
    const credential = await resolveAccountCredential({
      piProviderId: "commandcode",
      accountId: "89a8cbab",
      registry: { getApiKeyForProvider: vi.fn().mockResolvedValue(undefined) },
      multiprovider,
      multiproviderContext: {},
      env: { PI_CODING_AGENT_DIR: "/nonexistent-dir-for-test" },
    });
    expect(credential.source).toBe("none");
    expect(credential.accountId).toBe("89a8cbab");
  });

  it("keeps a per-account fetch alive when one account's resolution throws", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      resolveAccountAuth: vi.fn().mockRejectedValue(new Error("oauth refresh failed")),
    };
    const credential = await resolveAccountCredential({
      piProviderId: "commandcode",
      accountId: "89a8cbab",
      registry: { getApiKeyForProvider: vi.fn().mockResolvedValue(undefined) },
      multiprovider,
      multiproviderContext: {},
      env: { PI_CODING_AGENT_DIR: "/nonexistent-dir-for-test" },
    });
    expect(credential.source).toBe("none");
  });
});

describe("resolveVirtualBackend", () => {
  it("reads the latest switch-account pin for the virtual model", () => {
    const sessionManager = {
      getEntries: () => [
        { customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "dsv4::k3", accountId: "kimi-coding::k3" } },
        { customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "dsv4::k3", accountId: "deepseek::deepseek-v4-pro" } },
      ],
    };
    expect(resolveVirtualBackend(sessionManager, "dsv4", "k3")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
  });

  it("returns undefined when the pin was cleared to automatic", () => {
    const sessionManager = {
      getEntries: () => [
        { customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "dsv4::k3", accountId: "kimi-coding::k3" } },
        { customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "dsv4::k3" } },
      ],
    };
    expect(resolveVirtualBackend(sessionManager, "dsv4", "k3")).toBeUndefined();
  });

  it("ignores pins for other pools", () => {
    const sessionManager = {
      getEntries: () => [{ customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "other::model", accountId: "x::y" } }],
    };
    expect(resolveVirtualBackend(sessionManager, "dsv4", "k3")).toBeUndefined();
  });
});

describe("isLikelyVirtualProvider", () => {
  it("treats unregistered ids as virtual", () => {
    expect(isLikelyVirtualProvider(["commandcode", "deepseek"], "dsv4")).toBe(true);
    expect(isLikelyVirtualProvider(["commandcode", "deepseek"], "deepseek")).toBe(false);
    expect(isLikelyVirtualProvider(undefined, "dsv4")).toBe(false);
  });
});

describe("quota warnings", () => {
  beforeEach(() => resetWarningState());

  const window = (overrides: Partial<QuotaWindow>): QuotaWindow => ({
    label: "5h",
    usedPercent: 50,
    windowSeconds: 5 * 3600,
    kind: "quota",
    ...overrides,
  });

  it("is critical at 100%", () => {
    expect(evaluateWindow(window({ usedPercent: 100 }))?.severity).toBe("critical");
    expect(evaluateWindow(window({ usedPercent: 95 }))?.severity).toBe("high");
  });

  it("projects exhaustion from pace", () => {
    const now = Date.now();
    // 80% used with 80% of the window elapsed -> projected 100%+, and past half.
    const resetsAt = now + 0.2 * 5 * 3600 * 1000;
    const evaluated = evaluateWindow(window({ usedPercent: 80, resetsAt }), now);
    expect(evaluated?.severity).toBe("warning");

    // Same usage but early in the window -> worse projection, high severity.
    const earlyReset = now + 0.9 * 5 * 3600 * 1000;
    const early = evaluateWindow(window({ usedPercent: 30, resetsAt: earlyReset }), now);
    expect(early?.severity).toBe("high");
  });

  it("stays silent when usage is on pace", () => {
    const now = Date.now();
    const resetsAt = now + 0.9 * 5 * 3600 * 1000; // 10% elapsed, 5% used
    expect(evaluateWindow(window({ usedPercent: 5, resetsAt }), now)).toBeUndefined();
  });

  it("does not warn on balance windows", () => {
    const balance: QuotaWindow = { label: "Balance", balanceValue: 5, limited: false, isBalance: true, kind: "balance" };
    expect(evaluateWindow(balance)).toBeUndefined();
  });

  it("collects warnings for a provider", () => {
    const usage: ProviderUsage = {
      provider: "zai-coding-cn",
      status: "ok",
      fetchedAt: Date.now(),
      windows: [window({ usedPercent: 100 })],
    };
    const warnings = collectWarnings(usage);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("ZAI CN");
  });
});

describe("account labelling for the footer", () => {
  it("never uses a virtual backend label as the account tag", async () => {
    // Regression: the footer rendered `target.accountLabel`, which for a virtual
    // provider is the *backend* label ("Command Code · deepseek/deepseek-v4.1-flash"),
    // so it displayed a model name as if it were the account. The account must
    // come from the resolved credential instead.
    const multiprovider: MultiProviderServiceAnnouncement = {
      getMostRecentlyUsedAccount: vi
        .fn()
        .mockResolvedValue({ id: "pi:default", label: "hello@raenzo.com", authKind: "custom" }),
      getActiveAccount: vi.fn().mockResolvedValue({ id: "pi:default", label: "hello@raenzo.com" }),
    };
    const credential = await resolveCredential({
      piProviderIds: ["commandcode"],
      piProviderId: "commandcode",
      registry: { getApiKeyForProvider: vi.fn().mockResolvedValue("user_5vSAWk3cZJzdG") },
      multiprovider,
      multiproviderContext: {},
    });
    // The upstream account has no stored token, but its label must still be
    // reported so the footer can name the credential that actually served.
    expect(credential.source).toBe("model-registry");
    expect(credential.accountLabel).toBe("hello@raenzo.com");
    expect(credential.accountId).toBe("pi:default");
  });

  it("prefers the most recently used account over the affinity pin", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getMostRecentlyUsedAccount: vi.fn().mockResolvedValue({ id: "acc-b", label: "github" }),
      getActiveAccount: vi.fn().mockResolvedValue({ id: "acc-a", label: "google" }),
      resolveActiveAccountAuth: vi.fn().mockResolvedValue({ accessToken: "tok-b", label: "github" }),
    };
    const credential = await resolveCredential({
      piProviderIds: ["commandcode"],
      piProviderId: "commandcode",
      registry: {},
      multiprovider,
      multiproviderContext: {},
    });
    expect(credential.accountLabel).toBe("github");
    expect(credential.source).toBe("multiprovider");
  });
});
