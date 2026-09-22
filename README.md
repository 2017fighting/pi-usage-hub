# pi-usage-hub

Unified quota and usage indicators for [Pi](https://github.com/earendil-works/pi): a footer status bar for the provider **actually serving your session**, and a `/usage` dashboard that ranks every configured provider by whether you can use it right now.

Built for the provider mix Pi users actually run: Chinese coding plans, subscription credits, and pay-as-you-go balances side by side, including providers that pool multiple accounts through [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider).

## Supported providers

| Provider | Pi provider id(s) | What it reports |
| --- | --- | --- |
| ZAI Coding Plan (China) | `zai-coding-cn` | 5h + weekly token windows, monthly web-tool quota |
| CodeBuddy | `codebuddy`, `codebuddy-intl` | credit packages with per-package cycle reset times |
| Command Code | `commandcode` | 5h + weekly windows, monthly credits |
| DeepSeek | `deepseek` | account balance (topped-up / granted) |
| Kimi For Coding | `kimi-coding` | 5h window + monthly subscription pool |
| Google Antigravity | `antigravity` | Gemini and Claude/GPT pools (5h + weekly) |
| OpenCode Go | `opencode-go` | rolling 5h, weekly, monthly percentages |

## Why another usage plugin

No existing plugin covers this set. `@hk_net/pi-usage-bars` and `@latentminds/pi-quotas` support ZAI, Kimi and DeepSeek but have **no CodeBuddy, Command Code or Antigravity** — and neither understands multiprovider account pools.

Two behaviours are specific to this plugin:
1. **The footer follows the real account.** When a provider is pooled by pi-multiprovider, the footer shows usage for the account that is actually serving the session (`commandcode#acc2`), not the default credential. With the patched multiprovider fork, virtual providers resolve too (`dsv4 → kimi-coding`).
2. **`/usage` breaks a pool down per account.** Configure three CommandCode accounts and all three appear, each with its own quota, cooldown and disabled state — not one row showing whichever credential happened to be active.
3. **`/usage` answers "what can I use right now?"** available providers first, exhausted ones ordered by **how soon their quota resets**, so the provider that comes back first is at the top. A provider is only available when *every* window that gates it has room, and the reset shown is the one that actually unblocks it. For a pool, "available" means *any* account can serve, and the reset is the first account to return.

## Install

```bash
pi install /path/to/pi-usage-hub
```

Then remove any overlapping plugin so two footer bars do not fight:

```bash
pi remove npm:@hk_net/pi-usage-bars
pi remove npm:pi-quota-monitoring
```

## Use

### Footer status bar

When the active model belongs to a supported provider, the footer shows the most-consumed window:

```
ZAI CN ██░░░░ 4% ⟳2h 44m
```

Colours shift green → amber (≥70%) → red (≥90%). Pooled accounts are labelled (`commandcode#acc2`). Local multiprovider cooldowns are shown explicitly, since a cooling-down account can look "available" from quota alone:

```
commandcode#acc2 ██░░░░ 21% ⟳4h cooldown 12m
```

Refreshed every two minutes, on every turn end, on model switches, and immediately when multiprovider changes the active account.

### `/usage`

An interactive dashboard listing every provider, grouped by availability, with the selected row expanded. **Pooled providers list every account as its own sub-row**, each fetched with that account's credential, so a `commandcode` pool of three shows all three quotas. Search filters by provider *or account label*. `↑`/`↓`/`PageUp`/`PageDown` navigate, `Esc` closes.

```
  AVAILABLE
  → ● CommandCode ×3
      ● google           ✓
        Weekly 91% · ⟳3d
      ● hello@raenzo.com
        Weekly 100% · ⟳3d
      ● github            cooling 12m
        Weekly 100% · ⟳2d 12h

  EXHAUSTED (soonest reset first)
  → ● DeepSeek
      Balance -CN¥0.20 · topped-up -CN¥0.20 · granted CN¥0.00
```

The provider is `available` because `google` has room, even though the other two
accounts are out of quota. Selecting it expands every account's full window list:

```
  → ● CommandCode ×3
      ● google           ✓
        5h ███░░░░░░░░░░░ 23% ⟳ 16:08 (4h 30m)
        Weekly █████████████░ 91% ⟳ 9/25 11:38 (3d)
        Monthly credits ███████░░░░░░░ 54% monthly 5.40 · purchased 0.00
      ● hello@raenzo.com
        5h ███████░░░░░░░ 47% ⟳ 16:38 (5h)
        Weekly ██████████████ 100% ⟳ 9/25 11:38 (3d)
      ● github            cooling 12m
        5h ░░░░░░░░░░░░░░ 0% ⟳ 14:38 (3h)
        Weekly ██████████████ 100% ⟳ 9/24 23:38 (2d 12h)
```

Each account gets its own status dot, and the two reasons an account can be
unusable are shown separately because they are independent:

- **red dot** — out of quota (its own credential's windows are spent)
- **`cooling 12m`** — multiprovider has the account in a local cooldown, which is
  invisible in quota: an account at 0% used can still be skipped by the scheduler
- **`disabled`** — you turned the account off in `/multilogin`
- **`✓`** — the account that served the session's most recent request

The **provider's** badge summarises the pool: it is `available` when *any* account
can serve, and `exhausted` only when every account is out. That is the point of
pooling, and reporting a pool exhausted because the serving account ran dry would
send you away from a provider with two good accounts left.

Per-account fetching happens only when `/usage` is opened — each account is one
HTTP call, so the two-minute footer poll deliberately keeps fetching just the
serving account.

In non-interactive modes `/usage` prints a plain-text summary instead, with one
indented line per account:

```
CommandCode [OK] 5h 23%, Weekly 91%, Monthly credits 54%
  - google [OK] ✓ 5h 23%, Weekly 91%, Monthly credits 54%
  - hello@raenzo.com [EXHAUSTED] 5h 47%, Weekly 100%, Monthly credits 60%
  - github [EXHAUSTED, cooling 12m] 5h 0%, Weekly 100%, Monthly credits 60%
```

### `--usage`

Print one line of JSON for the active provider and exit — useful as a loader and credential smoke test:

```bash
pi --no-extensions -e ./src/extension/index.ts --usage
```

```json
{"extension":"pi-usage-hub","provider":"zai-coding-cn","status":"ok","windows":[...]}
```

`status` is `ok`, `unconfigured`, `unsupported`, or `error`. No credential is ever included.

## Quota warnings

When a window's consumption is on pace to hit its limit before it resets, Pi notifies you. Severity escalates `warning` → `high` → `critical` (100% used). Repeats are rate-limited to one per hour per window, and escalations always notify.

## Multiprovider integration

Credential resolution prefers the account in use:

1. pi-multiprovider's active pooled account (`resolveActiveAccountAuth`), when the provider is pooled
2. Pi's model registry (`getApiKeyForProvider`)
3. Pi's `auth.json` (last resort)

Only the token for the account being displayed is resolved; the plugin never reads multiprovider's private credential store directly.

### Every account, not just the serving one

The footer shows the serving account. `/usage` additionally enumerates the whole
pool through `getPoolSnapshot` and resolves each account through
`resolveAccountAuth(providerId, accountId, ctx)` — both additive methods on the
multiprovider service announcement.

The upstream (`pi:default`) account is resolved through Pi rather than the pool,
because it has no stored credential there. That distinction is enforced in both
directions: a *stored* account is **never** allowed to fall back to Pi's registry
or `auth.json`, since those hold the upstream credential and would print the
upstream account's quota under another account's label.

Against an unpatched multiprovider these methods are absent, and the plugin falls
back to the previous single-credential behaviour: one row per provider, no account
breakdown.

For **virtual providers**, the serving backend is resolved through the multiprovider service event. This requires a small patch to pi-multiprovider that routes virtual pools through the service announcement (`getVirtualIntegration`) and exposes pool health via `getPoolSnapshot`. Both are additive and optional: against an unpatched multiprovider the plugin falls back to reading `/switch-account` session pins, and simply shows nothing for automatically-rotating virtuals.

## Endpoint overrides

Several of these are reverse-engineered subscription surfaces, so endpoints drift. Every one is overridable without a code change:

| Variable | Default |
| --- | --- |
| `PI_ZAI_CODING_CN_USAGE_ENDPOINT` | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` |
| `PI_CODEBUDDY_CN_ENDPOINT` | `https://www.codebuddy.cn` |
| `PI_CODEBUDDY_INTL_ENDPOINT` | `https://www.codebuddy.ai` |
| `PI_COMMANDCODE_WHOAMI_ENDPOINT` | `https://api.commandcode.ai/alpha/whoami` |
| `PI_COMMANDCODE_CREDITS_ENDPOINT` | `https://api.commandcode.ai/alpha/billing/credits` |
| `PI_COMMANDCODE_SUBSCRIPTIONS_ENDPOINT` | `https://api.commandcode.ai/alpha/billing/subscriptions` |
| `PI_COMMANDCODE_USAGE_SUMMARY_ENDPOINT` | `https://api.commandcode.ai/alpha/usage/summary` |
| `PI_DEEPSEEK_BALANCE_ENDPOINT` | `https://api.deepseek.com/user/balance` |
| `PI_KIMI_USAGE_ENDPOINT` | `https://api.kimi.com/coding/v1/usages` |
| `PI_ANTIGRAVITY_ENDPOINT` | `https://daily-cloudcode-pa.googleapis.com` |
| `PI_OPENCODE_GO_USAGE_ENDPOINT` | `https://opencode.ai/zen/go/v1/usage` |

## Events for other extensions

Every successful poll broadcasts on `pi-usage-hub:update`:

```ts
pi.events.on("pi-usage-hub:update", ({ provider, account, usage }) => {
  // e.g. switch providers when a window is exhausted
});
```

## Notes on provider semantics

### Bars are for plans, amounts are for balances

Progress bars only appear where a percentage is real — a window with a defined cap. Providers that sell **prepaid balances** (DeepSeek, CodeBuddy credits, Command Code monthly credits) have no plan to be a fraction of, so they render as amounts:

```
DeepSeek  -CN¥0.20
CodeBuddy 1387.02 / 2000.00 credits
```

An earlier version drew an empty bar and `0%` for these, which was doubly wrong: the `0%` was invented, and it read as "nothing used" on an overdrawn account. Balance rows now carry no bar and no percentage, ever.

- **CodeBuddy** sells credit packages. The combined total is what gates availability; each package is informational, with its own cycle end time. Authentication uses the CodeBuddy OAuth JWT Pi already stores — no browser cookie is needed.
- **DeepSeek** is a prepaid balance with no reset. It reports as `exhausted` when the balance reaches zero (a negative balance is valid and shown as such).
- **Antigravity** prefers the grouped `retrieveUserQuotaSummary` (Gemini and Claude/GPT pools, each with 5h + weekly buckets). When that is gated, it falls back to per-model `quotaInfo`, which is **pool-shared**, not a private per-model budget.
- Fetch failures are reported as `unknown`, never as zero.

### Availability is a group AND, not a window OR

A provider is **available** only when some group of windows is entirely unblocked. Windows that apply to the same request are ANDed; independent pools are ORed:

- **ZAI** — the 5h window *and* the weekly cap both apply. A live account at 5h = 4% and weekly = 100% is **exhausted**, because the API answers `1310 weekly/monthly limit reached`. Reporting it available because the 5h window had room was a bug. Its monthly **web-search** quota is informational and never blocks coding requests.
- **Antigravity** — Gemini and Claude/GPT are independent pools (OR); within a pool the 5h and weekly buckets both apply (AND).
- **CodeBuddy** — the combined total gates usage; individual packages are informational alternatives (OR).
- **Kimi** — the 5h window and the monthly pool both gate (AND), so the provider needs room in both.

When a provider is **pooled** by multiprovider, grouping happens at two levels. Within an account the rules above apply; across accounts they are ORed at the provider, because any one account can serve a request:

```
provider available  =  ANY account usable
account usable      =  its quota has room  AND  it is not cooling down  AND  it is not disabled
```

Quota and pool health are deliberately kept apart, since they fail independently: an account at 0% used can still be skipped because multiprovider cooled it down after a failure, and an account can be out of quota while still being the pool's only member. `/usage` shows both, side by side.

The **reset shown for an exhausted provider is the one that actually unblocks it** — a provider waiting on a weekly cap reports the weekly reset, never an earlier 5h reset that would leave it still blocked. Exhausted prepaid balances with no reset time sort last, under `no reset`. For a pooled provider that reset is the **first** account to recover (the minimum, because accounts are alternatives) rather than the last.

Per-provider notes:

- **CodeBuddy** sells credit packages. Each package carries its own cycle end time. Authentication uses the CodeBuddy OAuth JWT Pi already stores — no browser cookie is needed.
- **DeepSeek** is a prepaid balance with no reset. It reports as `exhausted` when the balance reaches zero (a negative balance is valid and shown as such).
- **Antigravity** prefers the grouped `retrieveUserQuotaSummary` (Gemini and Claude/GPT pools, each with 5h + weekly buckets). When that is gated, it falls back to per-model `quotaInfo`, which is **pool-shared**, not a private per-model budget.
- Fetch failures are reported as `unknown`, never as zero. One account failing to fetch leaves the other accounts in the pool reported normally.

## Development

```bash
npm install
npm run typecheck
npm test
npx tsx scripts/live-check.ts   # hits the real APIs with your auth.json
```

## License

MIT
