# Instagram Sortner

A local-first dashboard for the Instagram accounts **you** follow: search, filter, sort, and unfollow one at a time behind a confirmation and a rate limiter.

Runs entirely on your own machine. No hosted service, no third party ever sees your session, no password is stored anywhere — because the app never asks for one.

> **Read [`docs/LIMITS.md`](docs/LIMITS.md) first.** No official Instagram API can list who you follow or unfollow anyone. Anything that does this uses private endpoints, which is against Instagram's Terms of Use and carries a real risk of an action block. That document explains the limits, the risks, and how this app is built to stay under them.

## What it does

- **Complete list** of everyone you follow, stored locally in SQLite and kept across runs.
- **Details per account** — username, name, avatar, private/verified, follower and following counts, whether they follow you back, and **the date you followed them**.
- **Search, filter, sort** — instant search over username and name; filters for "doesn't follow back", verified and private; sorting by username, name, follower count, following count, follow date or first seen.
- **Unfollow** next to every row, behind a confirmation dialog, executed through a serial, persistent, rate-limited queue.
- **History**, not just state: accounts you unfollowed and accounts that quietly vanished from your list are kept and filterable, never deleted.
- **Works on a phone**, one hand, no horizontal scrolling. Light and dark follow the system.

## Two data sources, one dashboard

| | Data export (default) | Live session |
| --- | --- | --- |
| Risk | none | see `docs/LIMITS.md` |
| Setup | download your export from Instagram | log in through a browser window |
| Refresh | request a new export | on demand |
| Follow dates | ✅ **only source** | ❌ |
| Counts, avatars, names | ❌ | ✅ |
| Unfollow | ❌ | ✅ |

They merge: import the export once for follow dates, then sync live for everything else. An archive row is keyed by username until the first live sync resolves its real account id and adopts its follow date.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev            # http://127.0.0.1:4317
```

### Read-only, zero risk (recommended first)

Instagram → Settings → **Accounts Centre** → *Your information and permissions* → **Download your information** → format **JSON**. When the .zip arrives:

```bash
npm run import -- ~/Downloads/instagram-export.zip
```

…or drop it into **Settings → Import data export** in the dashboard.

### Live mode (needed to unfollow)

```bash
npm run login          # opens a browser; log in yourself, 2FA included
```

Then set `PROVIDER=web` in `.env` and restart. The app keeps the cookies that browser session produced; it never sees your password.

No browser on this machine? Paste `sessionid`, `ds_user_id` **and `csrftoken`** from your own logged-in browser into **Settings → Paste cookies manually**. All three are required: Instagram rejects every unfollow that arrives without a CSRF token, so the app refuses to store a session that cannot sign one rather than letting you discover it as a mystery 403 later.

Until the header pill reads **Live**, no click can change your account.

## Configuration

Everything is in `.env` ([`.env.example`](.env.example) documents each value). The ones worth knowing:

| Variable | Default | Why |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4317` | Loopback on purpose. Whoever reaches this port controls your account. |
| `APP_TOKEN` | empty | Shared secret required on every API call. Set it if `HOST` is not loopback. |
| `PROVIDER` | `archive` | `archive` (read-only) or `web` (live). |
| `UNFOLLOW_MAX_PER_DAY` | `60` | Hard daily ceiling. Community-observed limits are ~150–200/day; this sits well under. |
| `UNFOLLOW_MAX_PER_HOUR` | `15` | |
| `UNFOLLOW_MIN_GAP_MS` / `UNFOLLOW_MAX_GAP_MS` | `25000` / `70000` | Each unfollow waits a random gap in this range, so the cadence is not a metronome. |
| `CIRCUIT_BREAKER_FAILURES` | `3` | Consecutive failures before the queue stops itself. |
| `DRY_RUN` | unset | Simulate unfollows and send nothing. Setting it here locks it on. |

Quotas are stored in the database, not in memory, so restarting the app does **not** reset your daily budget.

## Will clicking Unfollow change my real account?

The header always answers this in one word:

| Pill | What a click does |
| --- | --- |
| **Read-only** (grey) | Nothing. Archive data; the button is not even rendered, and the API refuses the call. |
| **Dry run** (green) | Nothing is sent. The action is recorded so you can see what *would* happen, and you stay following them. |
| **Live** (red) | A real, immediate, permanent unfollow on your Instagram account. |

Dry run is toggled in **Settings → Safety**. Setting `DRY_RUN=true` in `.env` also *locks* it on: it cannot be switched off from the dashboard, so a stray click can never reach your account.

While an action is still `Queued`, each row carries its own **Cancel** button and nothing is sent. Once it flips to `Unfollowing…` it is in flight and cannot be called back.

## How the unfollow queue behaves

1. Clicking **Unfollow** opens a confirmation naming the account. The UI echoes the username back to the server, which refuses the action if it doesn't match the row — a list that shifted under you can't cost you the wrong account.
2. The action is persisted as `queued`. One action per account can be in flight, and the row offers a **Cancel** button for as long as it stays queued.
3. A single worker drains the queue **serially**, waiting for a rate-limit slot before each call.
4. On success the account moves to `unfollowed` and leaves your Following view.
5. On an Instagram checkpoint or 429, the queue **pauses itself and clears the rest of the queue**, and will not resume until you say so in Settings. Retrying is what turns a warning into a block.
6. A crash mid-flight is recovered on the next boot: `running` actions go back to `queued`.

## Commands

```bash
npm run dev            # dev server with reload
npm run build && npm start
npm run login          # capture a session through a real browser
npm run import -- FILE # load a data export from the CLI
npm test               # unit + integration tests against a mock Instagram
npm run test:e2e       # drives the real UI in a real browser (needs Playwright)
npm run typecheck
```

`npm test` and `npm run test:e2e` never touch a real account: both run against a local stand-in for instagram.com.

## Architecture

```
web/                 dashboard (no build step, no framework, no dependencies)
src/
  providers/         archive (data export) and web (private endpoints) behind one interface
  services/sync      paginates the graph, reconciles archive rows, marks departures
  services/unfollow  serial persistent queue + circuit breaker
  core/ratelimit     database-backed quotas that survive restarts
  db/                SQLite schema and every query
  routes/            JSON API
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the decisions behind that shape.

## Not included, on purpose

Bulk unfollow, follow-back automation, growth tooling and scheduling are all deliberately absent. They are the features that get accounts banned.

## Licence

MIT. Use it on your own account. You are responsible for how you use it.
