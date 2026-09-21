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
2. **`/usage` answers "what can I use right now?"** available providers first, exhausted ones ordered by **how soon their quota resets**, so the provider that comes back first is at the top. A provider is only available when *every* window that gates it has room, and the reset shown is the one that actually unblocks it.

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

An interactive dashboard listing every provider, grouped by availability, with the selected row expanded. Search filters by name. `↑`/`↓`/`PageUp`/`PageDown` navigate, `Esc` closes.

```
  AVAILABLE
  → ● ZAI CN
      5h █░░░░░░░░░░░░░ 4% ⟳ 14:08 (2h 44m)
      Weekly ██████████████ 100% ⟳ 9/25 10:27 (3d 23h)
  → ● CommandCode
      5h ███░░░░░░░░░░░ 21% ⟳ 15:57 (4h 34m)
      Monthly credits ██░░░░░░░░░░░░ 12% monthly 8.76 · purchased 0.00

  EXHAUSTED (soonest reset first)
  → ● DeepSeek
      Balance -CN¥0.20 · topped-up -CN¥0.20 · granted CN¥0.00
```

In non-interactive modes `/usage` prints a plain-text summary instead.

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

### Availability is a group AND, not a window OR

A provider is **available** only when some group of windows is entirely unblocked. Windows that apply to the same request are ANDed; independent pools are ORed:

- **ZAI** — the 5h window *and* the weekly cap both apply. A live account at 5h = 4% and weekly = 100% is **exhausted**, because the API answers `1310 weekly/monthly limit reached`. Reporting it available because the 5h window had room was a bug. Its monthly **web-search** quota is informational and never blocks coding requests.
- **Antigravity** — Gemini and Claude/GPT are independent pools (OR); within a pool the 5h and weekly buckets both apply (AND).
- **CodeBuddy** — credit packages are alternatives (OR): spending comes from whichever package still has credits.
- **Kimi** — the 5h window and the monthly pool both gate (AND). The monthly pool having room while 5h is exhausted does *not* make it usable... unless the monthly pool is what's exhausted; both must have room.

The **reset shown for an exhausted provider is the one that actually unblocks it** — a provider waiting on a weekly cap reports the weekly reset, never an earlier 5h reset that would leave it still blocked. Exhausted prepaid balances with no reset time sort last, under `no reset`.

- **CodeBuddy** sells credit packages. Each package carries its own cycle end time. Authentication uses the CodeBuddy OAuth JWT Pi already stores — no browser cookie is needed.
- **DeepSeek** is a prepaid balance with no reset. It reports as `exhausted` when the balance reaches zero (a negative balance is valid and shown as such).
- **Antigravity** prefers the grouped `retrieveUserQuotaSummary` (Gemini and Claude/GPT pools, each with 5h + weekly buckets). When that is gated, it falls back to per-model `quotaInfo`, which is **pool-shared**, not a private per-model budget.
- Fetch failures are reported as `unknown`, never as zero.

## Development

```bash
npm install
npm run typecheck
npm test
npx tsx scripts/live-check.ts   # hits the real APIs with your auth.json
```

## License

MIT
