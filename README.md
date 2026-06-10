# Token Usage Dashboard

A local dashboard showing today's token usage, query volume, spend, and balance across multiple AI routing providers — all via their public JSON APIs.

What it shows:
- tokens used today
- total queries today
- estimated cost today
- provider-level usage and balance details
- per-provider refresh buttons and direct dashboard links

## Supported providers

- `right-code`
- `micu`
- `timicc`
- `packy`

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

4. Start the dashboard:

```bash
node server.js
```

5. Open `http://localhost:8088`

## How it works

- The server defaults to today's date in `Asia/Shanghai` when fetching usage.
- Each provider calls its vendor's JSON API directly — no browser, no scraping.
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

## Notes

- If a token expires, the owning provider starts returning 401 — regenerate or re-copy the token and restart the service.
- If a provider fails, only that provider's card shows an error; the others still render.
