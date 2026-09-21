import { describe, expect, it, vi } from "vitest";
import { resolveTarget, backendProviderIdFromAccountId, shortAccountLabel } from "../src/core/target.js";
import { SESSION_PIN_ENTRY_TYPE } from "../src/core/credentials.js";
import type { MultiProviderServiceAnnouncement } from "../src/core/credentials.js";

// Mirrors the real multiprovider-auth.json on this machine:
//   virtuals: { dsv4: { models: [{ id: "dsv4", backends: [
//     commandcode::deepseek/deepseek-v4.1-flash,
//     codebuddy::deepseek-v4.1-flash ] }] } }
const VIRTUAL_MODEL = { provider: "dsv4", id: "dsv4" };

describe("backendProviderIdFromAccountId", () => {
  it("splits the backend provider id off a virtual account id", () => {
    expect(backendProviderIdFromAccountId("commandcode::deepseek/deepseek-v4.1-flash")).toBe("commandcode");
    expect(backendProviderIdFromAccountId("codebuddy::deepseek-v4.1-flash")).toBe("codebuddy");
  });

  it("rejects unusable ids", () => {
    expect(backendProviderIdFromAccountId(undefined)).toBeUndefined();
    expect(backendProviderIdFromAccountId("")).toBeUndefined();
    expect(backendProviderIdFromAccountId("::model")).toBeUndefined();
  });
});

describe("resolveTarget — real providers", () => {
  it("passes through a supported provider id", async () => {
    const result = await resolveTarget({ model: { provider: "zai-coding-cn", id: "glm-5.3" } });
    expect(result).toMatchObject({ kind: "provider", provider: "zai-coding-cn", piProviderId: "zai-coding-cn" });
  });

  it("treats a supported provider as real even with no registered providers", async () => {
    // `--no-extensions` runs report no registered ids; a known id must still win.
    const result = await resolveTarget({ model: { provider: "deepseek", id: "deepseek-v4-pro" } });
    expect(result).toMatchObject({ kind: "provider", provider: "deepseek" });
  });

  it("reports why an unknown provider shows nothing", async () => {
    const result = await resolveTarget({ model: { provider: "mystery", id: "x" } });
    expect(result.kind).toBe("none");
    if (result.kind === "none") expect(result.reason).toContain("mystery");
  });

  it("reports no model as none", async () => {
    const result = await resolveTarget({ model: undefined });
    expect(result.kind).toBe("none");
  });
});

describe("resolveTarget — multiprovider virtual providers", () => {
  it("resolves the backend actually serving, via the service", async () => {
    // This is the reported bug: with the virtual provider "dsv4" active, the
    // footer showed nothing because the provider id was unrecognised and the
    // code took an early return instead of asking multiprovider.
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue({
        id: "commandcode::deepseek/deepseek-v4.1-flash",
        label: "commandcode · deepseek-v4.1-flash",
      }),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result).toMatchObject({
      kind: "provider",
      provider: "commandcode",
      piProviderId: "commandcode",
      virtualPrefix: "dsv4 → ",
    });
    expect(multiprovider.getActiveAccount).toHaveBeenCalledWith("dsv4", {});
  });

  it("resolves whichever backend is live, including the second one", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue({ id: "codebuddy::deepseek-v4.1-flash", label: "codebuddy" }),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result).toMatchObject({ provider: "codebuddy", piProviderId: "codebuddy" });
  });

  it("falls back to a session pin when the service cannot tell", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue(undefined),
    };
    const sessionManager = {
      getEntries: () => [
        { customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "dsv4::dsv4", accountId: "codebuddy::deepseek-v4.1-flash" } },
      ],
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {}, sessionManager });
    expect(result).toMatchObject({ provider: "codebuddy", virtualPrefix: "dsv4 → " });
  });

  it("falls back to a session pin when no service is announced", async () => {
    const sessionManager = {
      getEntries: () => [
        { customType: SESSION_PIN_ENTRY_TYPE, data: { pool: "dsv4::dsv4", accountId: "commandcode::deepseek/deepseek-v4.1-flash" } },
      ],
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, sessionManager });
    expect(result).toMatchObject({ provider: "commandcode" });
  });

  it("explains a rotating virtual rather than guessing a backend", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue(undefined),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result.kind).toBe("none");
    if (result.kind === "none") expect(result.reason).toContain("not a supported provider");
  });

  it("reports the pool before any backend has been selected", async () => {
    // Reproduces the live dsv4 state at session_start: getActiveAccount is
    // undefined because no request has been made, but the pool is known. The
    // footer must say something useful rather than stay empty.
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue(undefined),
      getPoolSnapshot: vi.fn().mockResolvedValue({
        accounts: [
          { id: "commandcode::deepseek/deepseek-v4.1-flash", label: "Command Code", status: "ready" },
          { id: "codebuddy::deepseek-v4.1-flash", label: "CodeBuddy", status: "ready" },
        ],
      }),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result).toMatchObject({ kind: "pending", virtualProviderId: "dsv4" });
    if (result.kind === "pending") {
      expect(result.backendLabels).toEqual(["commandcode", "codebuddy"]);
    }
    expect(multiprovider.getPoolSnapshot).toHaveBeenCalledWith("dsv4::dsv4");
  });

  it("resolves a single-backend virtual before the first request", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue(undefined),
      getPoolSnapshot: vi.fn().mockResolvedValue({
        accounts: [{ id: "kimi-coding::k3", label: "kimi", status: "ready" }],
      }),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result).toMatchObject({ kind: "provider", provider: "kimi-coding", virtualPrefix: "dsv4 → " });
  });

  it("reports the pool even when no member is a supported provider", async () => {
    // Better to name the pool than to silently show nothing; the labels are
    // informational and the footer simply cannot show usage for it.
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue(undefined),
      getPoolSnapshot: vi.fn().mockResolvedValue({
        accounts: [{ id: "exotic::model", label: "x", status: "ready" }],
      }),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result).toMatchObject({ kind: "pending", backendLabels: ["exotic"] });
  });

  it("explains a virtual whose backend we do not support", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockResolvedValue({ id: "some-exotic-provider::model", label: "x" }),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result.kind).toBe("none");
    if (result.kind === "none") expect(result.reason).toContain("some-exotic-provider");
  });

  it("survives the service throwing", async () => {
    const multiprovider: MultiProviderServiceAnnouncement = {
      getActiveAccount: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const result = await resolveTarget({ model: VIRTUAL_MODEL, multiprovider, multiproviderContext: {} });
    expect(result.kind).toBe("none");
  });
});

describe("shortAccountLabel", () => {
  it("drops a redundant provider prefix from a multiprovider label", () => {
    expect(shortAccountLabel("Command Code · deepseek/deepseek-v4.1-flash", "CommandCode")).toBe("deepseek-v4.1-flash");
    expect(shortAccountLabel("CodeBuddy · deepseek-v4.1-flash", "CodeBuddy")).toBe("deepseek-v4.1-flash");
  });

  it("keeps labels that carry real information", () => {
    expect(shortAccountLabel("work", "CommandCode")).toBe("work");
    expect(shortAccountLabel("account two", "CodeBuddy")).toBe("account two");
  });

  it("returns undefined when nothing would remain", () => {
    expect(shortAccountLabel("Command Code", "CommandCode")).toBeUndefined();
    expect(shortAccountLabel("", "CommandCode")).toBeUndefined();
    expect(shortAccountLabel(undefined, "CommandCode")).toBeUndefined();
  });
});
