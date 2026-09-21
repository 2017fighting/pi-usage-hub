/**
 * Session liveness tracking.
 *
 * Pi tears a session down in this order: emit `session_shutdown`, invalidate
 * every captured `ctx`/`pi` so each accessor throws "This extension ctx is
 * stale after session replacement or reload", rebind a *new* extension
 * instance, then emit `session_start` on it.
 *
 * Async work started by the old instance therefore resumes *after* its
 * captured objects have been invalidated. A quota poll whose fetch is aborted
 * mid-flight is the concrete case: `session_shutdown` aborts the request, Pi
 * invalidates the context, and only then does the rejected fetch reach the
 * extension's `catch` block. That block must be able to tell it no longer
 * belongs to a live session instead of reading `ctx.mode` or emitting on `pi`.
 *
 * The model is an epoch counter. Async work captures `current()` once and
 * re-checks `isLive(token)` after every await before touching session-bound
 * objects. `begin()` and `end()` both bump the epoch, so a token captured
 * before either event never matches afterwards. Comparing epochs (rather than
 * asking "is a session running?") means an epoch captured while a session is
 * live keeps matching until that session actually ends, so no legitimate work
 * is discarded.
 */
export interface SessionLiveness {
  /** Open a new epoch for a starting session and return its token. */
  begin(): number;
  /** Close the current epoch, invalidating every token handed out so far. */
  end(): void;
  /** Token of the current epoch; capture this to detect later replacement. */
  current(): number;
  /** Whether `token` still belongs to the current epoch. */
  isLive(token: number): boolean;
}

/**
 * Whether an error is Pi's stale-context guard.
 *
 * Used as a defensive backstop only: liveness tracking is what normally keeps
 * us away from a dead context. If a future Pi release invalidates a context
 * without emitting `session_shutdown` first, the guard surfaces as this error,
 * and swallowing it is still correct — the work belonged to a session that no
 * longer exists, and re-throwing it would only crash the TUI.
 */
export function isStaleContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("stale after session replacement or reload");
}

export function createSessionLiveness(): SessionLiveness {
  // Starts at 0 ("no session yet"); every begin/end moves it forward so a
  // token is never valid across a boundary.
  let epoch = 0;
  return {
    begin() {
      epoch += 1;
      return epoch;
    },
    end() {
      epoch += 1;
    },
    current() {
      return epoch;
    },
    isLive(token) {
      return token === epoch;
    },
  };
}
