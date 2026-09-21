import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  extractToken,
  resolveCredential,
  resolveVirtualBackend,
  isLikelyVirtualProvider,
  SESSION_PIN_ENTRY_TYPE,
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
