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

import type { ProviderKey, ProviderUsage } from "../core/types.js";
import { PROVIDER_LABELS, PROVIDER_ORDER } from "../core/types.js";
import { availabilityOf, sortUsages, soonestUsableReset } from "../core/format.js";
import { formatWindow, formatFooterSummary, shortReset, colorForPercent, renderBar } from "../core/render.js";
import { resolveEndpoints } from "../core/endpoints.js";
import { PROVIDERS, detectProviderKey, providerByKey } from "../providers/registry.js";
import {
  MULTIPROVIDER_SERVICE_EVENT,
  resolveCredential,
  resolveVirtualBackend,
  type MultiProviderServiceAnnouncement,
  type ModelRegistryLike,
  type SessionManagerLike,
} from "../core/credentials.js";
import { evaluateWarnings } from "../core/warnings.js";

const EXTENSION_ID = "pi-usage-hub";
const STATUS_KEY = EXTENSION_ID;
const USAGE_UPDATE_EVENT = `${EXTENSION_ID}:update`;
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

interface ActiveTarget {
  provider: ProviderKey;
  piProviderId: string;
  accountLabel?: string;
  /** Virtual provider display prefix, e.g. "dsv4 → ". */
  virtualPrefix?: string;
}

interface UsageState {
  active?: ActiveTarget;
  usages: Map<ProviderKey, ProviderUsage>;
  available: Map<ProviderKey, boolean>;
}

export default function usageHub(pi: ExtensionAPI): void {
  const state: UsageState = { usages: new Map(), available: new Map() };
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
  // start. Capture it so we can resolve the account actually in use.
  pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: unknown) => {
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
   * Order of resolution for a virtual provider:
   *  1. Ask multiprovider directly (our fork routes virtual pools through the
   *     announcement, giving the real backend for both pinned and affinity
   *     selections).
   *  2. Fall back to the `/switch-account` session pin, which works with an
   *     unpatched upstream multiprovider.
   */
  async function resolveTarget(ctx: ExtensionContext): Promise<ActiveTarget | undefined> {
    const model = ctx.model;
    if (!model) return undefined;
    const rawProviderId = model.provider;
    if (!rawProviderId) return undefined;

    const registry = registryOf(ctx);
    const registeredIds = registry.getRegisteredProviderIds?.();
    // A provider id we natively support is always a real provider. Only an id we
    // do not recognise can be a multiprovider virtual, and this must be decided
    // from our own registry first: in `--no-extensions` runs Pi reports no
    // registered ids at all, which would otherwise mark every provider virtual.
    const knownKey = detectProviderKey(rawProviderId);
    const isVirtual = knownKey === undefined && (registeredIds ? !registeredIds.includes(rawProviderId) : true);

    if (isVirtual) {
      const backend = await resolveVirtualTarget(ctx, rawProviderId, model.id);
      if (!backend) return undefined;
      const key = detectProviderKey(backend.providerId);
      if (!key) return undefined;
      return {
        provider: key,
        piProviderId: backend.providerId,
        accountLabel: backend.accountLabel,
        virtualPrefix: `${rawProviderId} → `,
      };
    }

    if (!knownKey) return undefined;
    return { provider: knownKey, piProviderId: rawProviderId };
  }

  /** Resolve a virtual provider's serving backend, preferring the live service. */
  async function resolveVirtualTarget(
    ctx: ExtensionContext,
    virtualProviderId: string,
    modelId: string,
  ): Promise<{ providerId: string; accountLabel?: string } | undefined> {
    if (multiprovider?.getActiveAccount) {
      try {
        const account = await multiprovider.getActiveAccount(virtualProviderId, ctx);
        // Virtual backend account ids are `${backendProviderId}::${backendModelId}`.
        const backendProviderId = account?.id?.split("::")[0];
        if (backendProviderId) {
          return { providerId: backendProviderId, accountLabel: account?.label };
        }
      } catch {
        // Fall through to the session-pin path.
      }
    }
    const pinned = resolveVirtualBackend(sessionsOf(ctx), virtualProviderId, modelId);
    if (!pinned) return undefined;
    return { providerId: pinned.providerId };
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
    if (!ctx || ctx.mode !== "tui") return;
    const target = state.active;
    if (!target) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const label = (target.virtualPrefix ?? "") + PROVIDER_LABELS[target.provider];
    const accountSuffix = target.accountLabel ? theme.fg("dim", `#${target.accountLabel}`) : "";
    const usage = state.usages.get(target.provider);

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
    try {
      do {
        pollQueued = false;
        const ctx = currentContext;
        if (!ctx || ctx.mode !== "tui") return;
        const target = await resolveTarget(ctx);
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
        } catch {
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

  /** Fetch every provider concurrently for the /usage dashboard. */
  async function fetchAll(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderUsage[]> {
    const endpoints = resolveEndpoints(process.env);
    const results = await Promise.all(
      PROVIDERS.map(async (descriptor): Promise<ProviderUsage> => {
        // Skip fetching providers that are not configured at all.
        const credential = await resolveCredential({
          piProviderIds: descriptor.piProviderIds,
          piProviderId: descriptor.piProviderIds[0],
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
            provider: descriptor.key,
            status: "unconfigured",
            windows: [],
            fetchedAt: Date.now(),
          };
        }
        try {
          const usage = await descriptor.fetch(
            credential.token,
            { signal, env: process.env },
            endpoints,
            { piProviderId: descriptor.piProviderIds[0] },
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
      }),
    );
    return results;
  }

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    sessionController?.abort();
    sessionController = new AbortController();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;

    if (pi.getFlag("usage") === true) {
      const target = await resolveTarget(ctx);
      if (!target) {
        console.log(JSON.stringify({ extension: EXTENSION_ID, status: "unsupported", provider: ctx.model?.provider }));
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
    state.active = await resolveTarget(ctx);
    updateStatus();
    void poll();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    pollTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    sessionController?.abort();
    sessionController = undefined;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    multiproviderUnsubscribe?.();
    multiproviderUnsubscribe = undefined;
    const ctx = currentContext;
    if (ctx?.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("model_select", async (_event, ctx) => {
    currentContext = ctx;
    state.active = await resolveTarget(ctx);
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
      const active = await resolveTarget(ctx);
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
      const windows = usage.windows
        .map((window) => `${window.label} ${window.usedPercent !== undefined ? `${Math.round(window.usedPercent)}%` : "—"}`)
        .join(", ");
      return `${label} [${badge}] ${usage.status === "ok" ? windows : usage.error ?? usage.status}`;
    })
    .join("\n");
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
            usage.provider.includes(normalized),
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
    const account = usage.accountLabel ? theme.fg("dim", `#${usage.accountLabel}`) : "";
    const name = selected ? theme.fg("accent", theme.bold(PROVIDER_LABELS[usage.provider])) : PROVIDER_LABELS[usage.provider];
    this.listContainer.addChild(new Text(`${pointer}${badge} ${name}${account}${activeBadge}`, 0, 0));

    const indent = "      ";
    if (usage.status !== "ok") {
      const message = usage.status === "unconfigured" ? "not configured" : usage.error ?? usage.status;
      this.listContainer.addChild(new Text(indent + theme.fg("dim", message), 0, 0));
      return;
    }
    if (!selected && usage.windows.length > 0) {
      // Collapsed rows show a compact single line so the whole list fits.
      const first = pickHeadlineWindow(usage);
      if (first) {
        const percent = first.usedPercent;
        const text =
          percent !== undefined
            ? `${first.label} ${Math.round(percent)}%`
            : `${first.label} ${first.note ?? ""}`.trim();
        const reset = shortReset(first.resetsAt);
        this.listContainer.addChild(
          new Text(indent + theme.fg("dim", text + (reset ? ` · ⟳${reset}` : "")), 0, 0),
        );
      }
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

/**
 * The window that best collapses a provider into a single dashboard line: the
 * most-consumed gating quota window. Informational windows (ZAI's monthly web
 * quota) are excluded, and balance rows are used only when nothing else exists.
 */
function pickHeadlineWindow(usage: ProviderUsage) {
  const gating = usage.windows.filter((window) => window.gating !== false);
  const quotaWindows = gating.filter((window) => window.kind === "quota" && window.usedPercent !== undefined);
  const pool = quotaWindows.length > 0 ? quotaWindows : gating.length > 0 ? gating : usage.windows;
  return [...pool].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
}

export { PROVIDER_ORDER };
