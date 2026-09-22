import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import usageHub, { renderPlainSummary } from "../src/extension/index.js";
import type { MultiProviderServiceAnnouncement } from "../src/core/credentials.js";
import { availabilityOf } from "../src/core/format.js";
import type { ProviderUsage } from "../src/core/types.js";

/**
 * End-to-end coverage for the feature this plugin exists for on pooled
 * providers: `/usage` must list *every* account in a multiprovider pool, each
 * fetched with its own credential, not just the account serving the session.
 *
 * The scenario mirrors the real machine: a CommandCode pool with the upstream
 * credential plus two stored OAuth accounts (`google`, `github`), where only one
 * of them is currently being used.
 */

const UPSTREAM = "pi:default";

interface Harness {
  pi: ExtensionAPI;
  /** The `/usage` command handler, captured from registerCommand. */
  runUsage(): Promise<string>;
}

/**
 * Build a Pi double whose `/usage` runs against a stub ctx. Non-interactive mode
 * is used so `/usage` renders the plain summary, which is the whole dashboard
 * content without needing a real TUI.
 */
function createHarness(options: {
  multiprovider?: MultiProviderServiceAnnouncement;
  provider?: string;
  model?: string;
} = {}): Harness {
  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let status: string | undefined;
  const notifications: string[] = [];

  const ui = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setStatus: (_key: string, value: string | undefined) => {
      status = value;
    },
    notify: (message: string) => {
      notifications.push(message);
    },
  };

  const modelRegistry = {
    getProviderAuthStatus: () => ({ configured: true }),
    getApiKeyForProvider: async (provider: string) => `registry-token-${provider}`,
  };
  const sessionManager = { getEntries: () => [] };

  const ctx = {
    ui,
    mode: "print" as const,
    hasUI: false,
    cwd: "/tmp",
    sessionManager,
    modelRegistry,
    model: { provider: options.provider ?? "commandcode", id: options.model ?? "deepseek/deepseek-v4.1-flash" },
    isIdle: () => true,
    abort: () => {},
    shutdown: () => {},
  } as unknown as ExtensionContext;

  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    registerCommand: (name: string, config: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      if (name === "usage") commandHandler = config.handler;
    },
    events: {
      on: (event: string, handler: (value: unknown) => void) => {
        if (event === "pi-multiprovider:service" && options.multiprovider) {
          handler(options.multiprovider);
        }
        return () => {};
      },
      emit: () => {},
    },
    on: () => {},
  } as unknown as ExtensionAPI;

  usageHub(pi);

  return {
    pi,
    async runUsage() {
      if (!commandHandler) throw new Error("/usage command was not registered");
      notifications.length = 0;
      await commandHandler("", ctx);
      expect(status).toBeUndefined(); // print mode must not touch the footer
      return notifications.join("\n");
    },
  };
}

/** A CommandCode pool of three accounts, with the usage API stubbed per token. */
function commandCodePool(mruAccountId = "89a8cbab"): MultiProviderServiceAnnouncement {
  const cooldownUntil = Date.now() + 12 * 60_000;
  return {
    getPoolSnapshot: async (providerId: string) =>
      providerId === "commandcode"
        ? {
            accounts: [
              { id: UPSTREAM, label: "hello@raenzo.com", status: "ready" },
              { id: "89a8cbab", label: "google", status: "ready" },
              { id: "577098a6", label: "github", status: "cooldown", cooldownUntil },
            ],
          }
        : undefined,
    getMostRecentlyUsedAccount: async () => ({ id: mruAccountId, label: "google" }),
    // The token identifies the account, so the stubbed HTTP layer can answer
    // with that account's own numbers.
    resolveAccountAuth: async (_providerId, accountId) =>
      accountId === UPSTREAM
        ? undefined // upstream resolves through Pi, not the pool
        : { accessToken: `token-${accountId}`, label: accountId },
    resolveActiveAccountAuth: async () => ({ accessToken: "token-89a8cbab", label: "google" }),
    getActiveAccount: async () => ({ id: mruAccountId, label: "google" }),
  };
}

/** Percent used, keyed by the credential token the request carried. */
function stubUsageApi(byToken: Record<string, number | undefined>): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    // The upstream account's token comes from the registry double.
    const effective = token === "registry-token-commandcode" ? UPSTREAM : token.replace(/^token-/, "");
    const percent = byToken[effective];
    if (percent === undefined) {
      return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
    }
    const resetsAt = new Date(Date.now() + 4 * 3600_000).toISOString();
    const body = {
      credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        fiveHour: { used: percent, cap: 100, resetAt: resetsAt },
        weekly: { used: percent, cap: 100, resetAt: resetsAt },
      },
    };
    void url;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  });
}

/** Pull the per-account detail out of a plain summary render. */
function plainFor(usage: ProviderUsage[]): string {
  return renderPlainSummary(usage);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/usage with a multiprovider pool", () => {
  it("lists every account in the pool, not just the serving one", async () => {
    stubUsageApi({ [UPSTREAM]: 8, "89a8cbab": 21, "577098a6": 64 });
    const harness = createHarness({ multiprovider: commandCodePool() });
    const output = await harness.runUsage();

    // All three labels appear, with the upstream credential named by its email.
    expect(output).toContain("hello@raenzo.com");
    expect(output).toContain("google");
    expect(output).toContain("github");
  });

  it("fetches each account with its own credential and reports its own numbers", async () => {
    stubUsageApi({ [UPSTREAM]: 8, "89a8cbab": 21, "577098a6": 64 });
    const harness = createHarness({ multiprovider: commandCodePool() });
    const output = await harness.runUsage();

    // Each account's own 5h window, proving the fetch was per credential rather
    // than three copies of the active account's numbers.
    const section = output.split("\n").filter((line) => line.trim() !== "");
    const google = section.find((line) => line.includes("google"))!;
    const github = section.find((line) => line.includes("github"))!;
    const upstream = section.find((line) => line.includes("hello@raenzo.com"))!;
    expect(google).toContain("21%");
    expect(github).toContain("64%");
    expect(upstream).toContain("8%");
  });

  it("flags the account serving the session", async () => {
    stubUsageApi({ [UPSTREAM]: 8, "89a8cbab": 21, "577098a6": 64 });
    const harness = createHarness({ multiprovider: commandCodePool("89a8cbab") });
    const output = await harness.runUsage();
    // `getMostRecentlyUsedAccount` names google, so google is marked in use.
    const google = output.split("\n").find((line) => line.includes("google"))!;
    expect(google).toContain("✓");
  });

  it("shows a cooling-down account as such, with its remaining time", async () => {
    stubUsageApi({ [UPSTREAM]: 8, "89a8cbab": 21, "577098a6": 0 });
    const harness = createHarness({ multiprovider: commandCodePool() });
    const output = await harness.runUsage();
    const github = output.split("\n").find((line) => line.includes("github"))!;
    expect(github).toContain("cooling");
    expect(github).toContain("12m");
  });

  it("keeps the provider available while any account can serve", async () => {
    // google at 21%, github at 100%: the pool is still usable, and reporting it
    // exhausted would push the operator off a provider that works.
    stubUsageApi({ [UPSTREAM]: 100, "89a8cbab": 21, "577098a6": 100 });
    const harness = createHarness({ multiprovider: commandCodePool("89a8cbab") });
    const output = await harness.runUsage();
    const providerLine = output.split("\n").find((line) => line.startsWith("CommandCode"))!;
    expect(providerLine).toContain("[OK]");
  });

  it("reports the pool exhausted only when every account is out", async () => {
    stubUsageApi({ [UPSTREAM]: 100, "89a8cbab": 100, "577098a6": 100 });
    const harness = createHarness({ multiprovider: commandCodePool() });
    const output = await harness.runUsage();
    const providerLine = output.split("\n").find((line) => line.startsWith("CommandCode"))!;
    expect(providerLine).toContain("[EXHAUSTED]");
  });

  it("survives one account failing to fetch", async () => {
    // `github` errors; the other two accounts must still be reported.
    stubUsageApi({ [UPSTREAM]: 8, "89a8cbab": 21, "577098a6": undefined });
    const harness = createHarness({ multiprovider: commandCodePool() });
    const output = await harness.runUsage();
    expect(output).toContain("google");
    expect(output).toContain("hello@raenzo.com");
    const github = output.split("\n").find((line) => line.includes("github"))!;
    expect(github).toContain("[?, cooling");
    expect(github).toContain("HTTP 500");
  });

  it("falls back to a single row when the provider is not pooled", async () => {
    stubUsageApi({ [UPSTREAM]: 8 });
    // No multiprovider at all: the pre-pooling behaviour must be unchanged.
    const harness = createHarness({ provider: "deepseek" });
    const output = await harness.runUsage();
    expect(output).toContain("DeepSeek");
    expect(output).not.toContain("- ");
  });
});

describe("renderPlainSummary", () => {
  it("indents one line per pooled account", () => {
    const usage: ProviderUsage = {
      provider: "commandcode",
      status: "ok",
      windows: [],
      fetchedAt: 1,
      pooled: true,
      accounts: [
        {
          accountId: "89a8cbab",
          accountLabel: "google",
          poolStatus: "ready",
          inUse: true,
          usage: {
            provider: "commandcode",
            status: "ok",
            fetchedAt: 1,
            windows: [{ label: "5h", usedPercent: 21, kind: "quota" }],
          },
        },
        {
          accountId: "5770",
          accountLabel: "github",
          poolStatus: "cooldown",
          cooldownMs: 12 * 60_000,
          usage: {
            provider: "commandcode",
            status: "ok",
            fetchedAt: 1,
            windows: [{ label: "5h", usedPercent: 100, kind: "quota" }],
          },
        },
      ],
    };
    const output = plainFor([usage]);
    const lines = output.split("\n");
    expect(lines[0]).toContain("CommandCode");
    expect(lines[1]).toMatch(/^ {2}- google \[OK\] ✓ 5h 21%$/);
    expect(lines[2]).toContain("github");
    expect(lines[2]).toContain("EXHAUSTED");
    expect(lines[2]).toContain("cooling");
  });

  it("aggregates a pooled provider as available when one account has room", () => {
    const usage: ProviderUsage = {
      provider: "commandcode",
      status: "ok",
      windows: [],
      fetchedAt: 1,
      pooled: true,
      accounts: [
        {
          accountId: "a",
          accountLabel: "a",
          usage: { provider: "commandcode", status: "ok", fetchedAt: 1, windows: [{ label: "5h", usedPercent: 100, kind: "quota" }] },
        },
        {
          accountId: "b",
          accountLabel: "b",
          usage: { provider: "commandcode", status: "ok", fetchedAt: 1, windows: [{ label: "5h", usedPercent: 4, kind: "quota" }] },
        },
      ],
    };
    expect(availabilityOf(usage)).toBe("available");
  });
});
