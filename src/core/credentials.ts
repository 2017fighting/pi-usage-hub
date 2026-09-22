/**
 * Credential and account resolution.
 *
 * Order of resolution for a provider:
 *  1. If pi-multiprovider pools this provider, resolve the *active account's*
 *     token through its in-process service event, so the numbers shown belong
 *     to the account that is actually serving the session.
 *  2. Otherwise ask Pi's model registry (`getApiKeyForProvider`).
 *  3. Otherwise fall back to reading Pi's own `auth.json` for the provider id.
 *
 * For multiprovider *virtual* providers the serving backend is only observable
 * when the user pinned it with `/switch-account`; that pin is a session entry.
 * We read it so `dsv4` can render as `dsv4 → kimi-coding#account`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderKey } from "../core/types.js";

export const MULTIPROVIDER_SERVICE_EVENT = "pi-multiprovider:service";
export const SESSION_PIN_ENTRY_TYPE = "pi-multiprovider:switch-account";
export const VIRTUAL_ID_SEPARATOR = "::";
/**
 * Multiprovider's id for the provider's own credential (auth.json, environment,
 * or provider ambient auth). It is not a stored account and carries no token in
 * the account store, so its credential is resolved by Pi instead.
 */
export const UPSTREAM_ACCOUNT_ID = "pi:default";

export interface MultiProviderActiveAccount {
  id: string;
  label: string;
  authKind?: string;
}

export interface MultiProviderServiceAnnouncement {
  getActiveAccount?(providerId: string, ctx: unknown): Promise<MultiProviderActiveAccount | undefined>;
  resolveActiveAccountAuth?(
    providerId: string,
    ctx: unknown,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; label: string; source?: string } | undefined>;
  /**
   * Resolve one *named* pool account's credential, not just the active one.
   * Added to our multiprovider fork so `/usage` can report account-scoped usage
   * for every account in a pool. Returns undefined for `pi:default` (Pi owns
   * that credential), and for an unknown provider or account id.
   */
  resolveAccountAuth?(
    providerId: string,
    accountId: string,
    ctx: unknown,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; label: string; source?: string } | undefined>;
  onActiveAccountChanged?(
    providerId: string,
    callback: (event: { providerId: string; account?: MultiProviderActiveAccount; ctx: unknown }) => void,
  ): () => void;
  /**
   * Per-account local cooldown snapshot, added by our multiprovider fork. Not
   * part of the upstream announcement, so it is optional and guarded.
   */
  getPoolSnapshot?(providerId: string): Promise<AccountSnapshot | undefined>;
  /**
   * The pool account most recently leased — the credential that served the
   * latest request. Added by our fork; preferred over `getActiveAccount` for
   * reporting, because affinity can name an account that upstream requests
   * bypass (the upstream credential carries no resolvable token).
   */
  getMostRecentlyUsedAccount?(providerId: string): Promise<MultiProviderActiveAccount | undefined>;
}

export interface AccountSnapshot {
  accounts: Array<{ id: string; label: string; status: string; cooldownUntil?: number }>;
}

/**
 * One account row in a pool snapshot, normalized for our use.
 *
 * These ids and labels are the account *identity* only: never a credential.
 */
export interface PoolAccount {
  id: string;
  label: string;
  status?: string;
  cooldownMs?: number;
}

/** True when a pool account id is the provider's own credential rather than a stored one. */
export function isUpstreamAccount(accountId: string | undefined): boolean {
  return accountId === UPSTREAM_ACCOUNT_ID;
}

/** Minimal surface of the Pi extension context we depend on. */
export interface ModelRegistryLike {
  getProviderAuthStatus?(provider: string): { configured?: boolean } | undefined;
  getProviderAuth?(provider: string): Promise<{ auth?: { apiKey?: string; headers?: Record<string, string> } } | undefined>;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getRegisteredProviderIds?(): readonly string[];
}

export interface SessionManagerLike {
  getEntries?(): Array<{ type?: string; customType?: string; data?: unknown }>;
}

export interface ResolvedCredential {
  token?: string;
  accountId?: string;
  accountLabel?: string;
  /** Local multiprovider cooldown for this account, in ms from now. */
  cooldownMs?: number;
  source: "multiprovider" | "model-registry" | "auth-file" | "none";
}

/** Authorization header value may hold a bearer token when apiKey is absent. */
function bearerFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const value = headers["Authorization"] ?? headers["authorization"];
  if (typeof value !== "string") return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

/** Path to Pi's credential store, honouring PI_CODING_AGENT_DIR. */
export function authFilePath(env: Record<string, string | undefined> = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "auth.json");
}

/** Read a provider credential straight out of auth.json (last-resort fallback). */
export async function readAuthFileToken(
  providerIds: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    const raw = await readFile(authFilePath(env), "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    for (const providerId of providerIds) {
      const entry = store[providerId];
      if (!entry) continue;
      const token = extractToken(entry);
      if (token) return token;
    }
  } catch {
    // Missing/unreadable auth.json is not an error — the provider is simply unconfigured.
  }
  return undefined;
}

/** Pull a usable token out of any of the credential shapes auth.json stores. */
export function extractToken(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() === "" ? undefined : entry;
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  for (const key of ["access", "accessToken", "apiKey", "key", "token"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const headers = record.headers as Record<string, string> | undefined;
  return bearerFromHeaders(headers);
}

/** Find the multiprovider service announcement among events, if the extension is loaded. */
export function findMultiProviderService(
  getService: () => MultiProviderServiceAnnouncement | undefined,
): MultiProviderServiceAnnouncement | undefined {
  return getService();
}

export interface ResolveOptions {
  piProviderIds: string[];
  /** Pi provider id in play (may be a virtual provider id). */
  piProviderId?: string;
  modelId?: string;
  registry: ModelRegistryLike;
  sessionManager?: SessionManagerLike;
  multiprovider?: MultiProviderServiceAnnouncement;
  multiproviderContext?: unknown;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

/**
 * Enumerate a pool's accounts from multiprovider, including local cooldowns.
 *
 * Returns `undefined` when this provider is not pooled (no snapshot, or the
 * extension is unpatched/absent), and an empty array when the pool exists but
 * has no accounts. The distinction matters: `undefined` means "not pooled, use
 * the normal single-credential path", while `[]` means "pooled but empty".
 *
 * Only identity and health are read here — never a credential.
 */
export async function listPoolAccounts(
  multiprovider: MultiProviderServiceAnnouncement | undefined,
  poolId: string | undefined,
): Promise<PoolAccount[] | undefined> {
  if (!multiprovider?.getPoolSnapshot || !poolId) return undefined;
  let snapshot: AccountSnapshot | undefined;
  try {
    snapshot = await multiprovider.getPoolSnapshot(poolId);
  } catch {
    return undefined;
  }
  if (!snapshot) return undefined;
  const now = Date.now();
  return snapshot.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    ...(account.status === undefined ? {} : { status: account.status }),
    ...(account.cooldownUntil !== undefined && account.cooldownUntil > now
      ? { cooldownMs: account.cooldownUntil - now }
      : {}),
  }));
}

export interface ResolveAccountOptions {
  /** Real Pi provider id whose pool this account belongs to. */
  piProviderId: string;
  accountId: string;
  registry: ModelRegistryLike;
  multiprovider?: MultiProviderServiceAnnouncement;
  multiproviderContext?: unknown;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve one named pool account's credential.
 *
 * The two kinds of pool account resolve through entirely different owners, and
 * mixing them up would silently mislabel quota:
 *
 *  - A **stored** account resolves only through `resolveAccountAuth`. It must
 *    never fall back to Pi's registry or `auth.json`, because those hold the
 *    *upstream* credential: doing so would render the upstream account's quota
 *    under a different account's label. When the pool cannot resolve it, this
 *    reports `source: "none"` and the caller shows that one account as
 *    unconfigured, leaving the other accounts honest.
 *  - The **upstream** account (`pi:default`) has no credential in the pool at
 *    all, so Pi's registry and `auth.json` are its only sources — and they are
 *    the right ones, being exactly what Pi itself would send.
 */
export async function resolveAccountCredential(options: ResolveAccountOptions): Promise<ResolvedCredential> {
  const { piProviderId, accountId, registry, multiprovider, multiproviderContext, signal } = options;

  if (!isUpstreamAccount(accountId)) {
    if (!multiprovider?.resolveAccountAuth) return { source: "none", accountId };
    try {
      const auth = await multiprovider.resolveAccountAuth(piProviderId, accountId, multiproviderContext, signal);
      if (auth?.accessToken) {
        // For antigravity the token is a JSON credential blob; the provider
        // adapter knows how to interpret it.
        return { token: auth.accessToken, accountId, accountLabel: auth.label, source: "multiprovider" };
      }
    } catch {
      // One account failing to resolve must not fail the whole pool.
    }
    return { source: "none", accountId };
  }

  try {
    const status = registry.getProviderAuthStatus?.(piProviderId);
    if (!status || status.configured !== false) {
      const token = await registry.getApiKeyForProvider?.(piProviderId);
      if (typeof token === "string" && token.trim() !== "") {
        return { token, accountId, source: "model-registry" };
      }
      const auth = await registry.getProviderAuth?.(piProviderId);
      const fromHeaders = bearerFromHeaders(auth?.auth?.headers);
      const direct = auth?.auth?.apiKey;
      const resolved = typeof direct === "string" && direct.trim() !== "" ? direct : fromHeaders;
      if (resolved) return { token: resolved, accountId, source: "model-registry" };
    }
  } catch {
    // Fall through to the file fallback.
  }

  const fileToken = await readAuthFileToken([piProviderId], options.env ?? process.env);
  if (fileToken) return { token: fileToken, accountId, source: "auth-file" };

  return { source: "none", accountId };
}

/**
 * Resolve the credential for a provider, preferring the account that
 * multiprovider is actually using.
 */
export async function resolveCredential(options: ResolveOptions): Promise<ResolvedCredential> {
  const { piProviderIds, registry, multiprovider, multiproviderContext, signal } = options;

  // 1. multiprovider pooled account (non-virtual: provider id stays the real one).
  const pooledId = options.piProviderId ?? piProviderIds[0];
  if (multiprovider && pooledId) {
    const fromPool = await resolveFromPool(multiprovider, pooledId, multiproviderContext, signal);
    if (fromPool) return fromPool;
  }

  // 2. Pi's model registry.
  //
  // This is also the path taken for a pooled provider whose active account is
  // the upstream credential (`pi:default`): that account has no stored token to
  // resolve, and Pi's own registry already holds the ambient credential the
  // request will use. The account label is still reported so the footer names
  // the credential in use rather than showing nothing.
  const upstream = await describeUpstreamAccount(multiprovider, pooledId, multiproviderContext);
  for (const providerId of piProviderIds) {
    try {
      const status = registry.getProviderAuthStatus?.(providerId);
      if (status && status.configured === false) continue;
      const token = await registry.getApiKeyForProvider?.(providerId);
      if (typeof token === "string" && token.trim() !== "") {
        return { token, source: "model-registry", ...(upstream ?? {}) };
      }
      const auth = await registry.getProviderAuth?.(providerId);
      const fromHeaders = bearerFromHeaders(auth?.auth?.headers);
      const direct = auth?.auth?.apiKey;
      const resolved = typeof direct === "string" && direct.trim() !== "" ? direct : fromHeaders;
      if (resolved) return { token: resolved, source: "model-registry", ...(upstream ?? {}) };
    } catch {
      // Try the next id / fallback.
    }
  }

  // 3. auth.json fallback (covers providers whose extension stores creds directly).
  const fileToken = await readAuthFileToken(piProviderIds, options.env ?? process.env);
  if (fileToken) return { token: fileToken, source: "auth-file" };

  return { source: "none" };
}

/**
 * Resolve a credential from a multiprovider pool.
 *
 * Prefers the account most recently leased, since that is the credential the
 * last request actually spent. Falls back to the affinity-pinned active account
 * when the fork's `getMostRecentlyUsedAccount` is unavailable.
 *
 * Returns undefined for the upstream account: it has no stored token, so the
 * caller must fall through to Pi's own credential resolution.
 */
async function resolveFromPool(
  multiprovider: MultiProviderServiceAnnouncement,
  poolId: string,
  ctx: unknown,
  signal: AbortSignal | undefined,
): Promise<ResolvedCredential | undefined> {
  // Identify the account first so the reported label matches the resolved token.
  let account: MultiProviderActiveAccount | undefined;
  try {
    account = await multiprovider.getMostRecentlyUsedAccount?.(poolId);
    if (!account) account = await multiprovider.getActiveAccount?.(poolId, ctx);
  } catch {
    account = undefined;
  }

  // The upstream credential is not resolvable here; its token comes from Pi.
  if (account?.id === UPSTREAM_ACCOUNT_ID) return undefined;
  if (!multiprovider.resolveActiveAccountAuth) return undefined;

  try {
    const auth = await multiprovider.resolveActiveAccountAuth(poolId, ctx, signal);
    if (!auth?.accessToken) return undefined;
    const cooldownMs = await cooldownFor(multiprovider, poolId, account?.id);
    return {
      token: auth.accessToken,
      accountId: account?.id,
      accountLabel: account?.label ?? auth.label,
      cooldownMs,
      source: "multiprovider",
    };
  } catch {
    return undefined;
  }
}

/**
 * The pool's upstream account when it is the active one, so a caller can name
 * the credential in use even though its token is resolved by Pi.
 */
async function describeUpstreamAccount(
  multiprovider: MultiProviderServiceAnnouncement | undefined,
  poolId: string | undefined,
  ctx: unknown,
): Promise<{ accountId?: string; accountLabel?: string } | undefined> {
  if (!multiprovider || !poolId) return undefined;
  try {
    const account =
      (await multiprovider.getMostRecentlyUsedAccount?.(poolId)) ??
      (await multiprovider.getActiveAccount?.(poolId, ctx));
    if (account?.id !== UPSTREAM_ACCOUNT_ID) return undefined;
    return { accountId: account.id, accountLabel: account.label };
  } catch {
    return undefined;
  }
}

function cooldownFor(
  multiprovider: MultiProviderServiceAnnouncement,
  providerId: string,
  accountId: string | undefined,
): Promise<number | undefined> {
  if (!accountId) return Promise.resolve(undefined);
  return (async () => {
    try {
      const snapshot = await multiprovider.getPoolSnapshot?.(providerId);
      const account = snapshot?.accounts.find((entry) => entry.id === accountId);
      if (account?.cooldownUntil && account.cooldownUntil > Date.now()) {
        return account.cooldownUntil - Date.now();
      }
    } catch {
      // Snapshot is an optional enhancement.
    }
    return undefined;
  })();
}

/**
 * For a multiprovider virtual provider, read the `/switch-account` session pin
 * to discover which backend is serving. Returns the backend's Pi provider id and
 * model id, or undefined when the provider is rotating automatically.
 */
export function resolveVirtualBackend(
  sessionManager: SessionManagerLike | undefined,
  virtualProviderId: string | undefined,
  modelId: string | undefined,
): { providerId: string; modelId: string } | undefined {
  if (!sessionManager?.getEntries || !virtualProviderId || !modelId) return undefined;
  const poolId = `${virtualProviderId}${VIRTUAL_ID_SEPARATOR}${modelId}`;
  let entries: Array<{ type?: string; customType?: string; data?: unknown }>;
  try {
    entries = sessionManager.getEntries();
  } catch {
    return undefined;
  }
  // Last matching pin wins; a pin without accountId means "automatic".
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.customType !== SESSION_PIN_ENTRY_TYPE) continue;
    const data = entry.data as { pool?: unknown; accountId?: unknown } | undefined;
    if (data?.pool !== poolId) continue;
    if (typeof data.accountId !== "string") return undefined;
    const [providerId, backendModelId] = data.accountId.split(VIRTUAL_ID_SEPARATOR);
    if (!providerId) return undefined;
    return { providerId, modelId: backendModelId ?? modelId };
  }
  return undefined;
}

/** True when a Pi provider id looks like a multiprovider virtual provider id (not a real provider). */
export function isLikelyVirtualProvider(
  registryProviderIds: readonly string[] | undefined,
  piProviderId: string | undefined,
): boolean {
  if (!piProviderId) return false;
  if (!registryProviderIds) return false;
  return !registryProviderIds.includes(piProviderId);
}

export type { ProviderKey };
