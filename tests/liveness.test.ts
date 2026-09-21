import { describe, expect, it } from "vitest";
import { createSessionLiveness, isStaleContextError } from "../src/core/liveness.js";

describe("createSessionLiveness", () => {
  it("keeps a token live for the session that captured it", () => {
    const liveness = createSessionLiveness();
    const token = liveness.begin();
    expect(liveness.isLive(token)).toBe(true);
    // Repeated checks must stay true for the whole session, or legitimate
    // in-flight work would be dropped mid-poll.
    expect(liveness.isLive(token)).toBe(true);
  });

  it("invalidates in-flight work when the session ends", () => {
    // The /new bug: session_shutdown aborts the fetch, then Pi invalidates ctx.
    // The aborted fetch resumes afterwards and must see its token as stale.
    const liveness = createSessionLiveness();
    const inFlight = liveness.current();
    liveness.end();
    expect(liveness.isLive(inFlight)).toBe(false);
  });

  it("does not revive an old token in the replacement session", () => {
    const liveness = createSessionLiveness();
    const old = liveness.begin();
    liveness.end();
    const replacement = liveness.begin();
    expect(replacement).not.toBe(old);
    expect(liveness.isLive(old)).toBe(false);
    expect(liveness.isLive(replacement)).toBe(true);
  });

  it("invalidates work from a session that never began", () => {
    const liveness = createSessionLiveness();
    const beforeStart = liveness.current();
    liveness.begin();
    expect(liveness.isLive(beforeStart)).toBe(false);
  });
});

describe("isStaleContextError", () => {
  it("matches Pi's stale-context guard", () => {
    // Exact message from pi's extension runner.
    expect(
      isStaleContextError(
        new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
        ),
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated errors", () => {
    expect(isStaleContextError(new Error("fetch failed"))).toBe(false);
    expect(isStaleContextError(new Error("HTTP 500"))).toBe(false);
    expect(isStaleContextError(undefined)).toBe(false);
    expect(isStaleContextError("stale")).toBe(false);
  });
});
