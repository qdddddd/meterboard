# Meterboard

A local dashboard showing today's usage, balance, and quotas across multiple providers — AI routing relays, AI subscriptions, and network services.

What it shows:
- subscription rate-limit meters for flat-rate plans, and traffic quotas
- provider-level usage, spend, and balance details
- per-provider refresh buttons and direct dashboard links

There are deliberately no cross-provider headline totals. Tokens, queries, and
cost only mean the same thing across the balance relays; the subscription
meters report rate-limit windows, and no dollar figure is available for the
Codex plan at all (its API exposes only undifferentiated daily token counts),
so a combined number would be summing unlike things.

## Supported providers

Balance-based API relays — these drive the token, query, cost, and balance figures:

- `right-code`
- `micu`
- `timicc`
- `packy`

Subscription meters — flat-rate plans measured by rate-limit window rather than
balance. They render in their own "Subscription meters" panel and contribute
nothing to the spend and balance totals:

- `gpt` — Codex / ChatGPT plan, read live via the local `codex` binary
- `claude` — Claude Code / claude.ai plan, read from Claude Code's local usage cache
- `v2free` — v2free.org traffic quota (GB per cycle rather than a rate-limit window)

### How the `claude` meter gets its numbers

Claude Code writes the usage payload to
`~/.claude/cache/usage-utilization.json` as it runs, and the provider reads that
file. No request leaves the dashboard, and no token is involved. The plan
label comes from the account record in `~/.claude.json` (the credentials
file's tier is frozen at token-issue time and goes stale across plan changes),
and the meter still renders with neither.

The cache is refreshed by Claude Code on its own schedule, not on every API
call, so meters are stamped `as of <time>` from the file's mtime. Once a
window's reset has passed, its cached percentage describes a window that no
longer exists, so the meter reports `window reset since <time>` at 0%.

#### Cost figure

The card also shows what the usage would have cost at API prices. A flat-rate
plan bills nothing per token, so this is a reference number, not money spent.

It is Claude Code's own figure, not a recomputation: each session transcript
carries `cost-state` records holding the `totalCostUSD` that `/cost` reports,
and the provider sums the latest one per session. Recomputing from per-message
token counts was tried and abandoned — `cost-state` labels models its own way
(`claude-opus-5[1m]`), and streaming leaves duplicate message ids, so the two
cannot be reconciled without guessing at internals that change per release.

That figure is exact per session but cumulative over the session's whole life,
and `cost-state` records are written infrequently — often once, days after the
session began. **Per-day attribution is therefore impossible**, which is why the
line reads "N sessions active in 7d" rather than "today": a long-running session
contributes its entire cost, including days before the window.

| Variable | Effect |
| --- | --- |
| `CLAUDE_COST_WINDOW_DAYS` | Days of session activity to include (default 7) |
| `CLAUDE_SHOW_COST=false` | Hide the cost line entirely |
| `CLAUDE_PROJECTS_DIR` | Override the transcript directory |
| `CLAUDE_USAGE_CACHE_PATH` | Override the cache file |
| `CLAUDE_CONFIG_DIR` | Override the directory the cache and credentials live under |
| `CLAUDE_CREDENTIALS_PATH` | Credentials file, a fallback for the plan label |

`CLAUDE_USAGE_SOURCE=network` exists and should stay unset. It calls
`api.anthropic.com/api/oauth/usage` directly — a non-public endpoint whose
polling from this dashboard previously got the account banned. Nothing falls
back to it.

### How the `v2free` meter gets its numbers

v2free.org is an SSPanel instance; `/user` serves the usage HTML only to a
logged-in session. The provider reuses the session cookie maintained by
`~/Documents/scripts/v2free_fetch.py` and parses the page's remaining / used /
today figures into one traffic meter (percent of the cycle quota, reset date,
plan label). When the cookie has expired it runs that script to re-login — the
site's bot gate requires its Chrome impersonation, which Node cannot do — and
retries once. See `V2FREE_*` in `.env.example`.

### How the `gpt` meter gets its numbers

The dashboard never calls `chatgpt.com` itself. It runs the local `codex` binary
as a JSON-RPC app server and asks it `account/rateLimits/read` — the same call
the Codex UI makes, answered with the same live numbers. The binary
authenticates with its own stored credentials and refreshes them the normal way,
so the traffic is the official client doing an ordinary operation.

The meters report **used**; the Codex UI reports **remaining**. 12% used here is
the same number as "88%" there.

`codex` is looked up on `PATH`, then under `~/.vscode/extensions/openai.chatgpt-*`,
then `~/.local/bin`. Set `CODEX_BIN` to pin a specific one. Because the binary
makes that request itself and a systemd unit inherits none of the shell's proxy
variables, the dashboard passes `SUBSCRIPTION_PROXY_URL` (or `HTTPS_PROXY`) down
to the child process.

#### Meters

An account is metered by several limits at once — the base Codex quota plus
per-model ones such as `GPT-5.3-Codex-Spark` — and each carries its own windows
and reset clocks. The card renders every window of every limit reported in
`rateLimitsByLimitId`, suffixing each label with the limit's own name so two
windows that both read "Weekly" stay distinguishable.

A window nobody has touched yet reports `resetsAt` as *now plus its own
duration*, a placeholder that walks forward on every poll. Rendering it as a
countdown would show a timer that never ticks down, so such a window is drawn
at 0% with no reset clock. A window that has genuinely started keeps a fixed
anchor across polls.

#### Account stats

Some plans expose a single rate-limit window, which leaves the card with one
bar and little else. The same app-server session also calls
`account/usage/read`, and the card lists what it returns: lifetime tokens, the
current daily streak, and any available rate-limit reset credits. A failure
there costs the stats only — the meters still render, and the card records
`meta.usageUnavailable`.

**The daily buckets lag a full day, so there is no "tokens today" to show.**
`dailyUsageBuckets` never contains the current date: the eleven buckets sum to
exactly `summary.lifetimeTokens`, and the whole aggregate stays frozen while the
live rate-limit meter climbs. Days with no usage are omitted from the array
entirely rather than reported as zero, so an absent bucket means "not
aggregated yet" and can never be read as "you used nothing". The card therefore
shows `Today — not reported yet` alongside the most recent day the account did
report (`Sep 7 (latest)`), and leaves the live intraday signal to the meters.

Reconstructing today's figure from the local rollout files is not a substitute:
summed per-request deltas reproduce none of the account's daily buckets under
any day boundary (UTC, Asia/Shanghai or US/Pacific), and this machine accounts
for only about 70% of lifetime tokens.

Providers publish these as `meta.stats` (`{label, value}` entries), which the
page renders generically, so any provider can add context under its meters.

#### Offline fallback

If the app server cannot be reached, the provider falls back to the rate-limit
snapshot Codex last wrote into `~/.codex/sessions/**/rollout-*.jsonl`, and
records why in `meta.degradedFrom`. That snapshot only advances when a Codex
turn actually runs on this machine, so those meters are stamped `as of <time>`
and are a lower bound. Once a window's reset time has passed, the recorded
percentage describes a window that no longer exists, so the meter reports
`window reset since <time>` at 0%.

Only each record's `timestamp` and `payload.rate_limits` are read. Those files
also hold conversation transcripts; nothing in this project touches them.

| Variable | Effect |
| --- | --- |
| `CODEX_BIN` | Full path to the `codex` binary |
| `GPT_SESSIONS_DIR` | Override the fallback session directory (default `$CODEX_HOME/sessions`) |
| `GPT_SESSION_SCAN_LIMIT` | How many recent session files to scan (default 10) |
| `GPT_USAGE_SOURCE=local` | Skip the app server, read snapshots only |
| `GPT_USAGE_SOURCE=network` | Call the usage endpoint directly — see below |

`GPT_USAGE_SOURCE=network` makes the dashboard call
`chatgpt.com/backend-api/codex/usage` itself with the OAuth token from
`~/.codex/auth.json`. That host sits behind a Cloudflare challenge: from a
challenged network it returns `403` with an HTML page for any request,
authenticated or not, and the provider reports it as a challenge rather than as
an expired token. There is deliberately no automatic fallback onto this path —
the app server is the supported way to get live numbers.

Network calls go through `HTTPS_PROXY` / `https_proxy` (or
`SUBSCRIPTION_PROXY_URL`) and honour `NO_PROXY`, since Node's global `fetch`
ignores proxy environment variables.

## Requirements

Node.js 18+ (uses global `fetch`).

## Quick start

1. Copy the example env file:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Collect each provider's auth token. For every provider you enable, sign in to its console in any browser, open DevTools → Console, and paste the relevant expression. Add the printed values to `.env` (see `.env.example` for the full variable list).

   - Right Code: `localStorage.getItem("userToken")` → `RIGHT_CODE_AUTH_TOKEN`
   - TimiCC: `localStorage.getItem("auth_token")` → `TIMICC_AUTH_TOKEN`
   - Packy: generate a token at https://www.packyapi.com/console → `PACKY_AUTH_TOKEN`; `JSON.parse(localStorage.user).id` → `PACKY_USER_ID`
   - Micu: generate a token at https://www.micuapi.ai/console → `MICU_AUTH_TOKEN`; `JSON.parse(localStorage.user).id` → `MICU_USER_ID`

   The `gpt` meter needs no step here — it asks the local `codex` binary, which
   uses its own stored credentials.

4. Start the dashboard:

```bash
node server.js
```

5. Open `http://localhost:8088`

## How it works

- The server defaults to today's date in `Asia/Shanghai` when fetching usage.
- Balance providers call their vendor's JSON API directly — no browser, no scraping.
- The `gpt` meter asks the local `codex` binary for live rate limits, falling back to its stored session snapshots.
- The main refresh button reloads all enabled providers; the small icon on a provider card reloads just that one and recalculates the combined totals.

## Configuration

Main settings in `.env`:

- `PORT` — local server port
- `PROVIDERS` — comma-separated provider ids; response ordering follows this list
- `RIGHT_CODE_COST_MULTIPLIER` — optional cost multiplier for Right Code

Optional provider display name overrides:

- `RIGHT_CODE_PROVIDER_ID`
- `MICU_PROVIDER_ID`
- `TIMICC_PROVIDER_ID`
- `PACKY_PROVIDER_ID`
- `GPT_PROVIDER_ID`

## Notes

- If a token expires, the owning provider starts returning 401 — regenerate or re-copy the token and restart the service.
- If a provider fails, only that provider's card shows an error; the others still render.
