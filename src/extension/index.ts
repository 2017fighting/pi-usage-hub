/**
 * pi-usage-hub — unified quota/usage status bar and /usage dashboard.
 *
 * Supported providers: zai-coding-cn, codebuddy (+intl), commandcode,
 * deepseek, kimi-coding, antigravity, opencode-go.
 *
 * The footer shows usage for the provider actually serving the session,
 * resolved through pi-multiprovider when that provider is pooled or virtual.
 * `/usage` fetches every configured provider and lists available providers
 * first, then exhausted ones ordered by how soon their quota resets.
 */

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, type Focusable, type TUI } from "@earendil-works/pi-tui";

import type { AccountUsage, ProviderKey, ProviderUsage } from "../core/types.js";
import { PROVIDER_LABELS, PROVIDER_ORDER } from "../core/types.js";
import { accountUsable, availabilityOf, sortUsages, soonestUsableReset } from "../core/format.js";
import {
  accountDisplayLabel,
  formatAccountRow,
  formatHeadlineLine,
  formatWindow,
  formatFooterSummary,
  shortReset,
  colorForPercent,
  renderBar,
} from "../core/render.js";
import { resolveEndpoints } from "../core/endpoints.js";
import { PROVIDERS, providerByKey } from "../providers/registry.js";
import { resolveTarget, shortAccountLabel, type ActiveTarget } from "../core/target.js";
import {
  MULTIPROVIDER_SERVICE_EVENT,
  isUpstreamAccount,
  listPoolAccounts,
  resolveAccountCredential,
  resolveCredential,
  type MultiProviderServiceAnnouncement,
  type ModelRegistryLike,
  type SessionManagerLike,
} from "../core/credentials.js";
import { evaluateWarnings } from "../core/warnings.js";
import { createSessionLiveness, isStaleContextError } from "../core/liveness.js";

const EXTENSION_ID = "pi-usage-hub";
/**
 * Pi renders every `setStatus` entry on one footer line, sorted by key with
 * `localeCompare` (see footer.ts in the Pi source). `pi-token-speed` uses the
 * key `tokenSpeed`, so a `zz-` prefix places usage after it. Keep this in sync
 * if that plugin ever changes its key.
 */
const STATUS_KEY = "zz-usage";
const USAGE_UPDATE_EVENT = `${EXTENSION_ID}:update`;
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

interface UsageState {
  active?: ActiveTarget;
  usages: Map<ProviderKey, ProviderUsage>;
  available: Map<ProviderKey, boolean>;
}

/** Why the footer has nothing to show, surfaced so the reason is discoverable. */
let lastNoneReason: string | undefined = undefined;
/** A virtual provider whose backends are known but none is selected yet. */
let pendingVirtual: { virtualProviderId: string; backendLabels: string[] } | undefined;

export default function usageHub(pi: ExtensionAPI): void {
  const state: UsageState = { usages: new Map(), available: new Map() };
  // Tracks which session the async poll work belongs to. Pi invalidates every
  // captured ctx/pi on /new, /resume, /fork and /reload; without this, an
  // aborted fetch resumes after invalidation and reads ctx.mode on a dead
  // context, throwing an unhandled "This extension ctx is stale" error.
  const liveness = createSessionLiveness();
  let currentContext: ExtensionContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let sessionController: AbortController | undefined;
  let pollInFlight = false;
  let pollQueued = false;
  let multiprovider: MultiProviderServiceAnnouncement | undefined;
  let multiproviderUnsubscribe: (() => void) | undefined;

  pi.registerFlag("usage", {
    description: "Print one-line usage JSON for the active provider and exit",
    type: "boolean",
    default: false,
  });

  // pi-multiprovider announces a service object at load and on every session
  // start. Capture it so we can resolve the account actually in use. Note this
  // fires for the whole process, not per session, so the handler must not act
  // on a session that has already shut down — `poll` re-checks liveness.
  multiproviderUnsubscribe = pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: unknown) => {
    multiprovider = value as MultiProviderServiceAnnouncement;
    if (state.active) void poll();
  });

  function registryOf(ctx: ExtensionContext): ModelRegistryLike {
    return ctx.modelRegistry as unknown as ModelRegistryLike;
  }

  function sessionsOf(ctx: ExtensionContext): SessionManagerLike {
    return ctx.sessionManager as unknown as SessionManagerLike;
  }

  /**
   * Determine which provider is really serving this session.
   *
   * Delegates to `resolveTarget` in core/target.ts, which owns the virtual
   * provider logic and is unit tested against the real shapes.
   */
  async function resolveActiveTarget(ctx: ExtensionContext): Promise<ActiveTarget | undefined> {
    const resolution = await resolveTarget({
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      multiprovider,
      multiproviderContext: ctx,
      sessionManager: sessionsOf(ctx),
    });
    if (resolution.kind === "provider") {
      const { kind: _kind, ...target } = resolution;
      lastNoneReason = undefined;
      return target;
    }
    if (resolution.kind === "pending") {
      // Backends known, none selected yet (before the session's first request).
      pendingVirtual = resolution;
      lastNoneReason = undefined;
      return undefined;
    }
    pendingVirtual = undefined;
    lastNoneReason = resolution.reason;
    return undefined;
  }

  async function fetchForTarget(target: ActiveTarget, signal?: AbortSignal): Promise<ProviderUsage | undefined> {
    const ctx = currentContext;
    if (!ctx) return undefined;
    const descriptor = providerByKey(target.provider);
    if (!descriptor) return undefined;

    const credential = await resolveCredential({
      piProviderIds: [target.piProviderId, ...descriptor.piProviderIds.filter((id) => id !== target.piProviderId)],
      piProviderId: target.piProviderId,
      modelId: ctx.model?.id,
      registry: registryOf(ctx),
      sessionManager: sessionsOf(ctx),
      multiprovider,
      multiproviderContext: ctx,
      signal,
      env: process.env,
    });
    if (!credential.token) {
      return {
        provider: target.provider,
        status: "unconfigured",
        windows: [],
        fetchedAt: Date.now(),
        error: "no credential",
      };
    }

    const endpoints = resolveEndpoints(process.env);
    const usage = await descriptor.fetch(
      credential.token,
      { signal, env: process.env },
      endpoints,
      { piProviderId: target.piProviderId },
    );
    return {
      ...usage,
      accountId: credential.accountId,
      accountLabel: credential.accountLabel,
      cooldownMs: credential.cooldownMs,
    };
  }

  function updateStatus(): void {
    const ctx = currentContext;
    if (!ctx) return;
    try {
      updateStatusWith(ctx);
    } catch (error) {
      // A stale context must never take the TUI down. The footer is decoration;
      // losing one frame of it is strictly better than an unhandled throw.
      if (!isStaleContextError(error)) throw error;
    }
  }

  function updateStatusWith(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const target = state.active;
    if (!target) {
      const theme = ctx.ui.theme;
      // A virtual provider with known backends but no selection yet: show the
      // pool so the footer is informative before the first request lands.
      if (pendingVirtual) {
        const labels = pendingVirtual.backendLabels.join(" | ");
        ctx.ui.setStatus(
          STATUS_KEY,
          theme.fg("dim", `${pendingVirtual.virtualProviderId} → rotating: `) + theme.fg("muted", labels),
        );
        return;
      }
      // Explain the absence instead of silently rendering nothing: a virtual
      // provider whose backend cannot be resolved used to leave the footer empty
      // with no clue why.
      const reason = lastNoneReason;
      const model = ctx.model?.provider;
      ctx.ui.setStatus(
        STATUS_KEY,
        reason && model ? theme.fg("dim", `${model}: ${reason}`) : undefined,
      );
      return;
    }
    const theme = ctx.ui.theme;
    const label = (target.virtualPrefix ?? "") + PROVIDER_LABELS[target.provider];
    const usage = state.usages.get(target.provider);
    // The account tag comes from the resolved credential, never from the target:
    // a virtual target's label names the *backend* ("Command Code ·
    // deepseek-v4.1-flash"), not the pooled account that actually served.
    const account = shortAccountLabel(usage?.accountLabel, PROVIDER_LABELS[target.provider]);
    const accountSuffix = account ? theme.fg("dim", `#${account}`) : "";

    if (!usage) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `${label}${accountSuffix} usage: loading…`));
      return;
    }
    if (usage.status === "error") {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `${label}${accountSuffix} usage unavailable (${usage.error})`));
      return;
    }
    if (usage.status !== "ok" || usage.windows.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    // Summary is a bar for quota providers, or a plain amount for balance-only
    // providers (a currency balance is not a fraction of a plan).
    const summary = formatFooterSummary(theme, usage.windows);
    if (!summary) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const parts: string[] = [theme.fg("dim", `${label}${accountSuffix}`), summary];
    if (usage.cooldownMs && usage.cooldownMs > 0) {
      parts.push(theme.fg("error", `cooldown ${shortReset(Date.now() + usage.cooldownMs)}`));
    }
    if (usage.stale) parts.push(theme.fg("warning", "stale"));
    ctx.ui.setStatus(STATUS_KEY, parts.join(" "));
  }

  async function poll(): Promise<void> {
    if (pollInFlight) {
      pollQueued = true;
      return;
    }
    pollInFlight = true;
    // Capture the session this run belongs to. Every continuation below compares
    // against it and abandons the run once the session has been replaced.
    const session = liveness.current();
    try {
      do {
        pollQueued = false;
        if (!liveness.isLive(session)) return;
        const ctx = currentContext;
        if (!ctx || ctx.mode !== "tui") return;
        const target = await resolveActiveTarget(ctx);
        // resolveActiveTarget awaits multiprovider/session lookups, so the
        // session may have been replaced while it was in flight.
        if (!liveness.isLive(session)) return;
        state.active = target;
        if (!target) {
          updateStatus();
          continue;
        }
        const controller = new AbortController();
        const composite = sessionController
          ? AbortSignal.any([sessionController.signal, controller.signal])
          : controller.signal;
        try {
          const usage = await fetchForTarget(target, composite);
          // The /new case: session_shutdown aborted this fetch and Pi then
          // invalidated ctx, so this continuation is running against a dead
          // context. Drop the result instead of touching ctx/pi.
          if (!liveness.isLive(session)) return;
          if (!usage) continue;
          state.usages.set(target.provider, usage);
          state.available.set(target.provider, availabilityOf(usage) === "available");
          updateStatus();
          pi.events.emit(USAGE_UPDATE_EVENT, {
            provider: target.provider,
            piProviderId: target.piProviderId,
            account: target.accountLabel,
            usage,
          });
          void evaluateWarnings(pi, ctx, usage);
        } catch (error) {
          // An aborted fetch during teardown is expected, not a failure worth
          // rendering — and rendering it would access the dead context.
          if (!liveness.isLive(session)) return;
          if (isStaleContextError(error)) return;
          state.usages.set(target.provider, {
            provider: target.provider,
            status: "error",
            windows: [],
            error: "fetch failed",
            fetchedAt: Date.now(),
          });
          updateStatus();
        }
      } while (pollQueued);
    } finally {
      pollInFlight = false;
    }
  }

  /**
   * Fetch every provider concurrently for the /usage dashboard.
   *
   * A multiprovider-pooled provider is fetched once *per account*, because each
   * account carries its own credential and therefore its own independent quota.
   * Fetching only the serving account — as the footer poll deliberately does —
   * cannot answer "how much is left on my other two CommandCode accounts".
   */
  async function fetchAll(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderUsage[]> {
    const endpoints = resolveEndpoints(process.env);
    const results = await Promise.all(
      PROVIDERS.map((descriptor) => fetchProvider(ctx, descriptor, endpoints, signal)),
    );
    return results;
  }

  async function fetchProvider(
    ctx: ExtensionContext,
    descriptor: (typeof PROVIDERS)[number],
    endpoints: ReturnType<typeof resolveEndpoints>,
    signal: AbortSignal,
  ): Promise<ProviderUsage> {
    const piProviderId = descriptor.piProviderIds[0]!;
    const accounts = await listPoolAccounts(multiprovider, piProviderId);

    if (accounts && accounts.length > 0) {
      const servingId = await resolveServingAccountId(ctx, piProviderId);
      const accountUsages = await Promise.all(
        accounts.map((account) =>
          fetchOneAccount(ctx, descriptor, account, endpoints, signal, servingId),
        ),
      );
      return aggregateProvider(descriptor.key, accountUsages);
    }

    // Not pooled (or multiprovider absent): one credential, one row.
    const credential = await resolveCredential({
      piProviderIds: descriptor.piProviderIds,
      piProviderId,
      modelId: ctx.model?.id,
      registry: registryOf(ctx),
      sessionManager: sessionsOf(ctx),
      multiprovider,
      multiproviderContext: ctx,
      signal,
      env: process.env,
    });
    if (!credential.token) {
      return { provider: descriptor.key, status: "unconfigured", windows: [], fetchedAt: Date.now() };
    }
    try {
      const usage = await descriptor.fetch(
        credential.token,
        { signal, env: process.env },
        endpoints,
        { piProviderId },
      );
      return {
        ...usage,
        accountId: credential.accountId,
        accountLabel: credential.accountLabel,
        cooldownMs: credential.cooldownMs,
      };
    } catch (error) {
      return {
        provider: descriptor.key,
        status: "error",
        windows: [],
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: Date.now(),
      };
    }
  }

  /**
   * The account that served the session's most recent request, used to mark one
   * pool row with `✓`. Prefers the most recently leased account (the credential
   * actually spent) over the affinity pin, matching `resolveCredential`.
   */
  async function resolveServingAccountId(
    ctx: ExtensionContext,
    poolId: string,
  ): Promise<string | undefined> {
    if (!multiprovider) return undefined;
    try {
      const account =
        (await multiprovider.getMostRecentlyUsedAccount?.(poolId)) ??
        (await multiprovider.getActiveAccount?.(poolId, ctx));
      return account?.id;
    } catch {
      return undefined;
    }
  }

  /** Fetch one pool account's usage with that account's own credential. */
  async function fetchOneAccount(
    ctx: ExtensionContext,
    descriptor: (typeof PROVIDERS)[number],
    account: { id: string; label: string; status?: string; cooldownMs?: number },
    endpoints: ReturnType<typeof resolveEndpoints>,
    signal: AbortSignal,
    servingId: string | undefined,
  ): Promise<AccountUsage> {
    const piProviderId = descriptor.piProviderIds[0]!;
    const cooldownMs = account.cooldownMs !== undefined && account.cooldownMs > 0 ? account.cooldownMs : undefined;
    const poolStatus = account.status === "disabled" ? "disabled" : cooldownMs ? "cooldown" : "ready";
    const shared = {
      accountId: account.id,
      accountLabel: account.label,
      poolStatus,
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
      ...(isUpstreamAccount(account.id) ? { isUpstream: true } : {}),
      ...(servingId === account.id ? { inUse: true } : {}),
    } as const;

    const credential = await resolveAccountCredential({
      piProviderId,
      accountId: account.id,
      registry: registryOf(ctx),
      multiprovider,
      multiproviderContext: ctx,
      signal,
      env: process.env,
    });
    if (!credential.token) {
      return {
        ...shared,
        usage: { provider: descriptor.key, status: "unconfigured", windows: [], fetchedAt: Date.now() },
      };
    }
    try {
      const usage = await descriptor.fetch(
        credential.token,
        { signal, env: process.env },
        endpoints,
        { piProviderId },
      );
      return { ...shared, usage };
    } catch (error) {
      return {
        ...shared,
        usage: {
          provider: descriptor.key,
          status: "error",
          windows: [],
          error: error instanceof Error ? error.message : String(error),
          fetchedAt: Date.now(),
        },
      };
    }
  }

  /**
   * Fold per-account results into the provider row.
   *
   * The top-level fields keep describing the *serving* account, so the footer
   * path and every existing renderer keep working unchanged; `accounts` carries
   * the full breakdown for the dashboard.
   */
  function aggregateProvider(key: ProviderKey, accounts: AccountUsage[]): ProviderUsage {
    const serving =
      accounts.find((account) => account.inUse) ??
      accounts.find((account) => account.usage.status === "ok") ??
      accounts[0]!;
    return {
      ...serving.usage,
      provider: key,
      accountId: serving.accountId,
      accountLabel: serving.accountLabel,
      ...(serving.cooldownMs === undefined ? {} : { cooldownMs: serving.cooldownMs }),
      accounts,
      pooled: true,
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    // Opens a new epoch, invalidating any async work still running for the
    // previous session (Pi rebinds extensions, so this instance also receives
    // the replacement session's session_start).
    const session = liveness.begin();
    currentContext = ctx;
    sessionController?.abort();
    sessionController = new AbortController();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;

    if (pi.getFlag("usage") === true) {
      const target = await resolveActiveTarget(ctx);
      if (!target) {
        console.log(
          JSON.stringify({
            extension: EXTENSION_ID,
            status: pendingVirtual ? "pending" : "unsupported",
            provider: ctx.model?.provider,
            ...(pendingVirtual
              ? { virtualProviderId: pendingVirtual.virtualProviderId, backends: pendingVirtual.backendLabels }
              : {}),
            reason: lastNoneReason,
          }),
        );
      } else {
        const usage = await fetchForTarget(target, sessionController.signal);
        console.log(
          JSON.stringify({
            extension: EXTENSION_ID,
            provider: target.provider,
            piProviderId: target.piProviderId,
            account: target.accountLabel,
            status: usage?.status ?? "error",
            ...(usage ?? {}),
          }),
        );
      }
      ctx.shutdown();
      return;
    }

    if (ctx.mode !== "tui") return;
    state.active = await resolveActiveTarget(ctx);
    if (!liveness.isLive(session)) return;
    updateStatus();
    void poll();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    pollTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    // Closing the epoch first makes every in-flight continuation bail out as
    // soon as it resumes, so none of them can touch the context Pi is about to
    // invalidate.
    liveness.end();
    sessionController?.abort();
    sessionController = undefined;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    multiproviderUnsubscribe?.();
    multiproviderUnsubscribe = undefined;
    const ctx = currentContext;
    currentContext = undefined;
    if (!ctx) return;
    try {
      if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch (error) {
      // Best-effort cleanup; a stale context here has nothing left to clear.
      if (!isStaleContextError(error)) throw error;
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    const session = liveness.current();
    currentContext = ctx;
    state.active = await resolveActiveTarget(ctx);
    if (!liveness.isLive(session)) return;
    updateStatus();
    void poll();
  });

  pi.on("agent_end", (_event, ctx) => {
    currentContext = ctx;
    void poll();
  });

  pi.registerCommand("usage", {
    description: "Show quota and balance for every configured provider",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      if (ctx.mode !== "tui") {
        const usages = await fetchAll(ctx, new AbortController().signal);
        ctx.ui.notify(renderPlainSummary(usages), "info");
        return;
      }
      const active = await resolveActiveTarget(ctx);
      await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
        new UsageDashboardComponent(tui, theme, keybindings, active?.provider, (signal) => fetchAll(ctx, signal), () => done()),
      );
      void poll();
    },
  });
}

/** Non-interactive fallback summary. */
export function renderPlainSummary(usages: ProviderUsage[]): string {
  return sortUsages(usages)
    .map((usage) => {
      const label = PROVIDER_LABELS[usage.provider];
      const availability = availabilityOf(usage);
      const badge = availability === "available" ? "OK" : availability === "exhausted" ? "EXHAUSTED" : "?";
      const line = `${label} [${badge}] ${describeUsage(usage)}`;
      const accounts = usage.accounts;
      if (!accounts || accounts.length === 0) return line;
      // Indent one line per account so a non-interactive /usage still lists every
      // pooled credential rather than a single aggregate.
      const rows = accounts.map((account) => {
        const status = accountStatusPlain(account);
        const usable = accountUsable(account) ? "OK" : availabilityOf(account.usage) === "unknown" ? "?" : "EXHAUSTED";
        const inUse = account.inUse ? " ✓" : "";
        return `  - ${accountDisplayLabel(account)} [${usable}${status}]${inUse} ${describeUsage(account.usage)}`;
      });
      return [line, ...rows].join("\n");
    })
    .join("\n");
}

/** One provider's or account's windows as a single plain-text line. */
function describeUsage(usage: ProviderUsage): string {
  if (usage.status !== "ok") return usage.error ?? usage.status;
  return usage.windows
    .map(
      (window) =>
        `${window.label} ${window.usedPercent !== undefined ? `${Math.round(window.usedPercent)}%` : window.note ?? "—"}`,
    )
    .join(", ");
}

/** Plain-text pool-health tag: `, cooling 12m` / `, disabled`. */
function accountStatusPlain(account: AccountUsage): string {
  if (account.poolStatus === "disabled") return ", disabled";
  if (account.cooldownMs !== undefined && account.cooldownMs > 0) {
    return `, cooling ${shortReset(Date.now() + account.cooldownMs)}`;
  }
  return "";
}

/** The /usage dashboard: available providers first, exhausted by reset time. */
class UsageDashboardComponent extends Container implements Focusable {
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly hintText: Text;
  private readonly requestController = new AbortController();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly activeProvider?: ProviderKey;
  private readonly fetchAllFn: (signal: AbortSignal) => Promise<ProviderUsage[]>;
  private readonly onDone: () => void;

  private usages: ProviderUsage[] = [];
  private filtered: ProviderUsage[] = [];
  private selectedIndex = 0;
  private viewportStart = 0;
  private loading = true;
  private failed = false;
  private disposed = false;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    activeProvider: ProviderKey | undefined,
    fetchAll: (signal: AbortSignal) => Promise<ProviderUsage[]>,
    onDone: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.activeProvider = activeProvider;
    this.fetchAllFn = fetchAll;
    this.onDone = onDone;

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.hintText = new Text("", 0, 0);
    this.addChild(this.hintText);
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    this.updateHint();
    this.updateList();
    void this.load();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  private async load(): Promise<void> {
    try {
      const results = await this.fetchAllFn(this.requestController.signal);
      if (this.disposed || this.requestController.signal.aborted) return;
      this.usages = sortUsages(results);
      this.filtered = this.usages;
      this.loading = false;
    } catch {
      if (this.disposed || this.requestController.signal.aborted) return;
      this.loading = false;
      this.failed = true;
    }
    this.updateHint();
    this.updateList();
    this.tui.requestRender();
  }

  private updateHint(): void {
    if (this.loading) {
      this.hintText.setText(this.theme.fg("dim", "Fetching usage from all configured providers…"));
      return;
    }
    if (this.failed) {
      this.hintText.setText(this.theme.fg("error", "Failed to fetch usage data"));
      return;
    }
    const available = this.usages.filter((usage) => availabilityOf(usage) === "available").length;
    const exhausted = this.usages.filter((usage) => availabilityOf(usage) === "exhausted").length;
    this.hintText.setText(
      this.theme.fg("success", `● ${available} available`) +
        this.theme.fg("dim", " · ") +
        this.theme.fg("error", `● ${exhausted} exhausted`) +
        this.theme.fg("dim", " · exhausted sorted by soonest reset · ✓ = in use"),
    );
  }

  private viewportSize(): number {
    return Math.max(1, Math.min(8, this.tui.terminal.rows - 14));
  }

  private ensureSelectedVisible(): void {
    const size = this.viewportSize();
    if (this.selectedIndex < this.viewportStart) this.viewportStart = this.selectedIndex;
    if (this.selectedIndex >= this.viewportStart + size) this.viewportStart = this.selectedIndex - size + 1;
    this.viewportStart = Math.max(0, Math.min(this.viewportStart, Math.max(0, this.filtered.length - size)));
  }

  private filter(query: string): void {
    const normalized = query.trim().toLowerCase();
    this.filtered = normalized
      ? this.usages.filter(
          (usage) =>
            PROVIDER_LABELS[usage.provider].toLowerCase().includes(normalized) ||
            usage.provider.includes(normalized) ||
            // Account labels are how a pooled provider is actually identified by
            // the operator, so "github" must find the CommandCode pool holding
            // it. Filtering only on the provider name would hide that row.
            usage.accounts?.some(
              (account) =>
                account.accountLabel.toLowerCase().includes(normalized) ||
                account.accountId.toLowerCase().includes(normalized),
            ) === true,
        )
      : this.usages;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.viewportStart = 0;
    this.ensureSelectedVisible();
  }

  private refresh(): void {
    this.updateList();
    this.tui.requestRender();
  }

  private renderGroupHeader(text: string, color: ThemeColor): void {
    this.listContainer.addChild(new Text(this.theme.fg(color, text), 0, 0));
  }

  private renderUsage(usage: ProviderUsage, selected: boolean): void {
    const theme = this.theme;
    const availability = availabilityOf(usage);
    const badge =
      availability === "available"
        ? theme.fg("success", "●")
        : availability === "exhausted"
          ? theme.fg("error", "●")
          : theme.fg("dim", "○");
    const pointer = selected ? theme.fg("accent", "→ ") : "  ";
    const activeBadge = this.activeProvider === usage.provider ? theme.fg("success", " ✓") : "";

    // A pooled provider's account tag belongs on the *header* only when there is
    // a single account to name. With several, each account is its own row below,
    // and repeating one account's label in the header would be misleading.
    const pooled = usage.accounts !== undefined && usage.accounts.length > 0;
    const accountTag = pooled ? undefined : shortAccountLabel(usage.accountLabel, PROVIDER_LABELS[usage.provider]);
    const account = accountTag ? theme.fg("dim", `#${accountTag}`) : "";
    const poolSuffix = pooled ? theme.fg("dim", ` ×${usage.accounts!.length}`) : "";
    const name = selected ? theme.fg("accent", theme.bold(PROVIDER_LABELS[usage.provider])) : PROVIDER_LABELS[usage.provider];
    this.listContainer.addChild(new Text(`${pointer}${badge} ${name}${account}${poolSuffix}${activeBadge}`, 0, 0));

    if (pooled) {
      this.renderAccounts(usage.accounts!, selected);
      return;
    }

    this.renderWindows(usage, selected, "      ");
  }

  /**
   * One sub-row per pooled account: label, pool-health badge, and that account's
   * own windows. This is what makes "my other two CommandCode accounts" visible
   * — each has a separate credential and therefore a separate quota.
   */
  private renderAccounts(accounts: AccountUsage[], expanded: boolean): void {
    // Pad to the widest label so the status dots form a column.
    const labelWidth = Math.min(18, Math.max(...accounts.map((account) => accountDisplayLabel(account).length)));
    for (const account of accounts) {
      for (const line of formatAccountRow(this.theme, account, { labelWidth, expanded })) {
        this.listContainer.addChild(new Text(line, 0, 0));
      }
    }
    if (expanded) this.listContainer.addChild(new Spacer(1));
  }

  /** The non-account rows of a provider: its windows, notice, and cooldown. */
  private renderWindows(usage: ProviderUsage, selected: boolean, indent: string): void {
    const theme = this.theme;
    if (usage.status !== "ok") {
      const message = usage.status === "unconfigured" ? "not configured" : usage.error ?? usage.status;
      this.listContainer.addChild(new Text(indent + theme.fg("dim", message), 0, 0));
      return;
    }
    if (!selected && usage.windows.length > 0) {
      // Collapsed rows show a compact single line so the whole list fits.
      const headline = formatHeadlineLine(theme, usage);
      if (headline) this.listContainer.addChild(new Text(indent + headline, 0, 0));
      return;
    }
    for (const window of usage.windows) {
      this.listContainer.addChild(new Text(indent + formatWindow(theme, window, { barWidth: 14 }), 0, 0));
    }
    if (usage.notice) {
      this.listContainer.addChild(new Text(indent + theme.fg("muted", usage.notice), 0, 0));
    }
    if (usage.cooldownMs && usage.cooldownMs > 0) {
      this.listContainer.addChild(
        new Text(indent + theme.fg("warning", `multiprovider cooldown ⟳${shortReset(Date.now() + usage.cooldownMs)}`), 0, 0),
      );
    }
    this.listContainer.addChild(new Spacer(1));
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.loading) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  Loading…"), 0, 0));
      return;
    }
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching providers"), 0, 0));
      return;
    }
    this.ensureSelectedVisible();
    const size = this.viewportSize();
    const end = Math.min(this.filtered.length, this.viewportStart + size);
    if (this.viewportStart > 0) {
      this.listContainer.addChild(new Text(this.theme.fg("dim", `  ↑ ${this.viewportStart} more`), 0, 0));
    }
    let lastGroup: string | undefined;
    for (let index = this.viewportStart; index < end; index += 1) {
      const usage = this.filtered[index]!;
      const availability = availabilityOf(usage);
      const group = availability === "available" ? "available" : availability === "exhausted" ? "exhausted" : "unknown";
      const query = this.searchInput.getValue?.() ?? "";
      if (group !== lastGroup && query.trim() === "") {
        const heading =
          group === "available" ? "AVAILABLE" : group === "exhausted" ? "EXHAUSTED (soonest reset first)" : "UNKNOWN";
        const color = group === "available" ? "success" : group === "exhausted" ? "error" : "dim";
        this.renderGroupHeader(`  ${heading}`, color);
        lastGroup = group;
      }
      this.renderUsage(usage, index === this.selectedIndex);
    }
    if (end < this.filtered.length) {
      this.listContainer.addChild(new Text(this.theme.fg("dim", `  ↓ ${this.filtered.length - end} more`), 0, 0));
    }
  }

  handleInput(keyData: string): void {
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.ensureSelectedVisible();
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.ensureSelectedVisible();
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.viewportSize());
      this.ensureSelectedVisible();
      this.refresh();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + this.viewportSize());
      this.ensureSelectedVisible();
      this.refresh();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      this.dispose();
      this.onDone();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.confirm")) {
      this.dispose();
      this.onDone();
      return;
    }
    this.searchInput.handleInput(keyData);
    this.filter(this.searchInput.getValue?.() ?? "");
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestController.abort();
  }
}

export { PROVIDER_ORDER };
