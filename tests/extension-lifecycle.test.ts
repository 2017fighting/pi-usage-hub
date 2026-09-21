import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import usageHub from "../src/extension/index.js";

/**
 * Regression test for the /new crash:
 *
 *   error: This extension ctx is stale after session replacement or reload.
 *     at updateStatus (src/extension/index.ts)
 *     at poll (src/extension/index.ts)
 *
 * Sequence that produced it:
 *   1. a session poll is in flight, awaiting a usage fetch
 *   2. /new emits session_shutdown, whose handler aborts the in-flight fetch
 *   3. pi invalidates every captured ctx so each accessor throws
 *   4. the rejected fetch resumes inside poll()'s catch and calls updateStatus()
 *   5. updateStatus() reads ctx.mode -> throws -> unhandled rejection kills the TUI
 *
 * The fake below mirrors pi's real teardown order (shutdown event first, then
 * invalidation) and its contexts, whose getters all call assertActive().
 */

const STALE_MESSAGE =
  "This extension ctx is stale after session replacement or reload. " +
  "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), " +
  "ctx.switchSession(), or ctx.reload().";

interface FakeContext {
  ctx: ExtensionContext;
  invalidate(): void;
  /** Number of property reads that hit the context after invalidation. */
  staleReads(): number;
}

function createFakeContext(): FakeContext {
  let stale = false;
  let staleReads = 0;
  const assertActive = () => {
    if (stale) {
      staleReads += 1;
      throw new Error(STALE_MESSAGE);
    }
  };
  const ui = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setStatus: () => {},
    notify: () => {},
  };
  const modelRegistry = {
    getProviderAuthStatus: () => ({ configured: true }),
    getApiKeyForProvider: async () => "test-token",
  };
  const sessionManager = { getEntries: () => [] };

  const ctx = {
    get ui() {
      assertActive();
      return ui as never;
    },
    get mode() {
      assertActive();
      return "tui" as const;
    },
    get hasUI() {
      assertActive();
      return true;
    },
    get cwd() {
      assertActive();
      return "/tmp";
    },
    get sessionManager() {
      assertActive();
      return sessionManager as never;
    },
    get modelRegistry() {
      assertActive();
      return modelRegistry as never;
    },
    get model() {
      assertActive();
      return { provider: "deepseek", id: "deepseek-v4-pro" } as never;
    },
    isIdle: () => true,
    abort: () => {},
    shutdown: () => {},
  } as unknown as ExtensionContext;

  return {
    ctx,
    invalidate: () => {
      stale = true;
    },
    staleReads: () => staleReads,
  };
}

interface FakePi {
  pi: ExtensionAPI;
  /** Invoke every handler registered for an event, in registration order. */
  emit(event: string): Promise<void>;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    registerCommand: () => {},
    events: {
      on: () => () => {},
      emit: () => {},
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event }, currentCtx!);
      }
    },
  };
}

/** The context the fake pi hands to handlers; set by each test. */
let currentCtx: ExtensionContext | undefined;

/** A fetch that never settles until its signal aborts, like a slow quota call. */
function stubPendingFetch(): { started: Promise<void>; rejectWith(error: unknown): void } {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let rejectPending: ((error: unknown) => void) | undefined;

  const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    markStarted?.();
    return new Promise((_resolve, reject) => {
      rejectPending = reject;
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortError()));
    });
  });

  return {
    started,
    rejectWith: (error: unknown) => rejectPending?.(error),
  };
}

/** Let queued microtasks (the resumed poll) run to completion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  currentCtx = undefined;
});

describe("session replacement while a poll is in flight", () => {
  it("does not touch the invalidated context when the aborted fetch rejects", async () => {
    const fake = createFakeContext();
    currentCtx = fake.ctx;
    const { pi, emit } = createFakePi();
    const fetchStub = stubPendingFetch();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      usageHub(pi);
      await emit("session_start");
      // The poll is now awaiting the usage fetch.
      await fetchStub.started;

      // /new: session_shutdown aborts the fetch, then pi invalidates the ctx.
      await emit("session_shutdown");
      fake.invalidate();

      // The aborted fetch rejects only now, after invalidation.
      fetchStub.rejectWith(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      await settle();
      await settle();

      expect(fake.staleReads()).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not touch the invalidated context when the fetch resolves after invalidation", async () => {
    // The success path has the same hazard: it emits on `pi` and notifies via
    // ctx, both of which throw once pi has invalidated the old instance.
    const fake = createFakeContext();
    currentCtx = fake.ctx;
    const { pi, emit } = createFakePi();
    const fetchStub = stubPendingFetch();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      usageHub(pi);
      await emit("session_start");
      await fetchStub.started;

      await emit("session_shutdown");
      fake.invalidate();

      await settle();
      await settle();

      expect(fake.staleReads()).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the footer working in the replacement session", async () => {
    // The guard must discard only the dead session's work, not break the new one.
    const first = createFakeContext();
    currentCtx = first.ctx;
    const { pi, emit } = createFakePi();
    const fetchStub = stubPendingFetch();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      usageHub(pi);
      await emit("session_start");
      await fetchStub.started;
      await emit("session_shutdown");
      first.invalidate();

      // Replacement session, as pi rebinds and restarts extensions.
      const second = createFakeContext();
      currentCtx = second.ctx;
      await emit("session_start");
      await settle();

      // Whatever the new session's poll does, it must not read the dead context.
      expect(first.staleReads()).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
