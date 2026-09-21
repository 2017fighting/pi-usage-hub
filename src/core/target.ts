/**
 * Deciding which provider's usage the footer should show.
 *
 * The hard case is a multiprovider **virtual** provider: `ctx.model.provider` is
 * the virtual id (e.g. `dsv4`), which maps onto several backing
 * (providerId, modelId) pairs. The usage shown must belong to the backend
 * actually serving the session, not to whichever backend happens to be first.
 *
 * Resolution order for a model whose provider id is not one we natively serve:
 *  1. Ask the multiprovider service for the active account of that virtual
 *     provider. Its account id is `${backendProviderId}::${backendModelId}`.
 *  2. Fall back to a `/switch-account` session pin, which is all an unpatched
 *     multiprovider exposes.
 *  3. Otherwise the backend is genuinely unobservable (automatic rotation on an
 *     unpatched multiprovider) and the footer reports why rather than guessing.
 *
 * This module is deliberately free of Pi UI types so it can be unit tested
 * against the real shapes.
 */

import type { ProviderKey } from "./types.js";
import { detectProviderKey } from "../providers/registry.js";
import {
  VIRTUAL_ID_SEPARATOR,
  resolveVirtualBackend,
  type MultiProviderServiceAnnouncement,
  type SessionManagerLike,
} from "./credentials.js";

export interface ActiveTarget {
  provider: ProviderKey;
  /** The real Pi provider id whose credential and usage we query. */
  piProviderId: string;
  /** Pooled account label, when the provider is pooled. */
  accountLabel?: string;
  /** Display prefix for a virtual provider, e.g. `"dsv4 → "`. */
  virtualPrefix?: string;
}

export type TargetResolution =
  | ({ kind: "provider" } & ActiveTarget)
  /**
   * A virtual provider whose backends are known but none has been selected yet.
   * This is the normal state before the session's first request: the scheduler
   * only records a selection once it has leased a backend. Showing the pool's
   * members is more useful than showing nothing.
   */
  | { kind: "pending"; virtualProviderId: string; backendLabels: string[] }
  | { kind: "none"; reason: string };

export interface TargetResolutionInput {
  model: { provider?: string; id?: string } | undefined;
  multiprovider?: MultiProviderServiceAnnouncement;
  multiproviderContext?: unknown;
  sessionManager?: SessionManagerLike;
}

/** Virtual backend account ids are `${backendProviderId}::${backendModelId}`. */
export function backendProviderIdFromAccountId(accountId: string | undefined): string | undefined {
  if (!accountId) return undefined;
  const [providerId] = accountId.split(VIRTUAL_ID_SEPARATOR);
  return providerId && providerId !== "" ? providerId : undefined;
}

/**
 * Resolve the provider whose usage the footer should show.
 *
 * A provider id we natively serve is always treated as a real provider, even
 * when Pi reports no registered providers (as in `--no-extensions` runs). Only
 * an id we do not recognise is considered a virtual provider.
 */
export async function resolveTarget(input: TargetResolutionInput): Promise<TargetResolution> {
  const { model, multiprovider, multiproviderContext, sessionManager } = input;
  if (!model?.provider) return { kind: "none", reason: "no active model" };

  const rawProviderId = model.provider;
  const knownKey = detectProviderKey(rawProviderId);
  if (knownKey) {
    return { kind: "provider", provider: knownKey, piProviderId: rawProviderId };
  }

  // Unknown to us: either a multiprovider virtual provider or a provider we do
  // not support. Try to resolve a virtual backend before giving up.
  const fromService = await resolveBackendFromService(
    multiprovider,
    multiproviderContext,
    rawProviderId,
  );
  if (fromService) {
    const key = detectProviderKey(fromService.providerId);
    if (key) {
      return {
        kind: "provider",
        provider: key,
        piProviderId: fromService.providerId,
        accountLabel: fromService.accountLabel,
        virtualPrefix: `${rawProviderId} → `,
      };
    }
    return {
      kind: "none",
      reason: `virtual backend "${fromService.providerId}" is not a supported provider`,
    };
  }

  const pinned = resolveVirtualBackend(sessionManager, rawProviderId, model.id);
  if (pinned) {
    const key = detectProviderKey(pinned.providerId);
    if (key) {
      return {
        kind: "provider",
        provider: key,
        piProviderId: pinned.providerId,
        virtualPrefix: `${rawProviderId} → `,
      };
    }
    return {
      kind: "none",
      reason: `pinned backend "${pinned.providerId}" is not a supported provider`,
    };
  }

  // Nothing selected yet. Before the session's first request the scheduler has
  // no active backend, which is the moment the user is most likely to look at
  // the footer. If every member of the pool maps onto a provider we serve, any
  // of them answers the question acceptably, so use the pool's first supported
  // member rather than showing nothing.
  const members = await poolMembers(multiprovider, multiproviderContext, rawProviderId, model.id);
  const usable = members.filter((providerId) => detectProviderKey(providerId) !== undefined);
  if (usable.length === 1) {
    const providerId = usable[0]!;
    return {
      kind: "provider",
      provider: detectProviderKey(providerId)!,
      piProviderId: providerId,
      virtualPrefix: `${rawProviderId} → `,
    };
  }
  if (members.length > 0) {
    return { kind: "pending", virtualProviderId: rawProviderId, backendLabels: members };
  }

  return {
    kind: "none",
    reason: `"${rawProviderId}" is not a supported provider`,
  };
}

/** Backend provider ids of a virtual pool, for display and fallback. */
async function poolMembers(
  multiprovider: MultiProviderServiceAnnouncement | undefined,
  ctx: unknown,
  virtualProviderId: string,
  modelId: string | undefined,
): Promise<string[]> {
  if (!multiprovider?.getPoolSnapshot) return [];
  const poolIds = [`${virtualProviderId}${VIRTUAL_ID_SEPARATOR}${modelId ?? ""}`];
  for (const poolId of poolIds) {
    try {
      const snapshot = await multiprovider.getPoolSnapshot(poolId);
      if (!snapshot) continue;
      return snapshot.accounts
        .map((account) => backendProviderIdFromAccountId(account.id))
        .filter((id): id is string => id !== undefined);
    } catch {
      // A pool snapshot is a best-effort enhancement.
    }
  }
  return [];
}

/** Ask the multiprovider service which backend of a virtual provider is serving. */
async function resolveBackendFromService(
  multiprovider: MultiProviderServiceAnnouncement | undefined,
  ctx: unknown,
  virtualProviderId: string,
): Promise<{ providerId: string; accountLabel?: string } | undefined> {
  if (!multiprovider?.getActiveAccount) return undefined;
  try {
    const account = await multiprovider.getActiveAccount(virtualProviderId, ctx);
    const providerId = backendProviderIdFromAccountId(account?.id);
    if (!providerId) return undefined;
    return { providerId, accountLabel: account?.label };
  } catch {
    return undefined;
  }
}

/**
 * A short account tag for the footer.
 *
 * Multiprovider labels are often "Provider · model", which duplicates the
 * provider name already shown next to it, so the redundant prefix is dropped:
 * "Command Code · deepseek/deepseek-v4.1-flash" becomes "deepseek-v4.1-flash".
 * Returns undefined when nothing informative would remain.
 */
export function shortAccountLabel(
  accountLabel: string | undefined,
  providerLabel: string,
): string | undefined {
  const tag = rawAccountTag(accountLabel, providerLabel);
  if (tag === undefined) return undefined;
  // Long labels (email addresses, model ids) crowd the footer line out.
  return tag.length > 14 ? `${tag.slice(0, 13)}…` : tag;
}

function rawAccountTag(accountLabel: string | undefined, providerLabel: string): string | undefined {
  if (!accountLabel) return undefined;
  const trimmed = accountLabel.trim();
  if (trimmed === "") return undefined;
  const parts = trimmed.split(/\s*[·|]\s*/).filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  const normalize = (value: string) => value.replace(/[\s_-]/g, "").toLowerCase();
  if (normalize(parts[0]!) === normalize(providerLabel)) {
    const rest = parts.slice(1).join(" · ");
    if (rest === "") return undefined;
    return rest.replace(/^deepseek\//, "");
  }
  return trimmed;
}
