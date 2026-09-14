# Architecture

## Shape

```
browser (web/)  ──HTTP──►  express (src/routes)
                              │
                              ├── services/sync      ──► providers ──► instagram.com
                              ├── services/unfollow  ──┘   (or a data export on disk)
                              │      └── core/ratelimit
                              └── db (SQLite)
```

One process, one SQLite file, one static front end. No build step for the UI, no framework, no client-side state library — the dataset is a few thousand rows and the server already knows how to filter and sort them.

## Decisions

### Providers behind one interface

`Provider` (`src/providers/provider.ts`) declares `listFollowing`, optional `listFollowers`, `getProfile`, `unfollow`, and a `capabilities` record. Two implementations:

- `ArchiveProvider` — parses the official data export. Handles all three shapes Meta has shipped (bare array, `relationships_following` wrapper, HTML) because you cannot control which vintage a user downloads.
- `WebProvider` — the private web endpoints.

`capabilities` is not decoration: the API returns it, the UI reads it, and the Unfollow button does not render when `capabilities.unfollow` is false. One flag, honoured in three layers, rather than three places that can drift.

### Archive rows are keyed by username, live rows by account id

The export carries no numeric ids, only usernames, so archive rows use `pk = "username:<lowercase>"`. The first live sync that sees the same username takes that row's `followed_at`, deletes the placeholder, and writes a real numeric-id row (`takeArchivePlaceholder`).

This is the only design that lets a user import an export for follow dates *and* sync live for everything else without duplicate rows or lost dates. `upsertAccounts` uses `COALESCE` on every nullable column for the same reason: a live sync must not blank out what the archive knew, and vice versa.

### Nothing is deleted

An account that disappears from your following list becomes `gone`, not a missing row. Whether someone blocked you, deactivated, or you unfollowed them elsewhere is exactly the history worth keeping, and it costs one indexed column.

Departures are detected by **sync run id**, not by comparing `last_seen_at`: timestamps are second-precision, and two syncs inside the same second would make every departure invisible. The same query is scoped to the source's own keyspace (`pk LIKE 'username:%'` for archive rows, `NOT LIKE` for live ones), so an archive import cannot declare live rows gone merely because it had no way to see them.

### Rate limiting lives in the database

`RateLimiter` counts rows in a `rate_events` ledger rather than holding counters in memory. A purely in-memory limiter resets its daily budget on every restart — and crash-then-restart-then-resume is precisely the sequence that gets an account flagged. Quotas are hourly, daily, a randomised minimum gap, and an explicit cooldown that Instagram's own 429 can set.

### The unfollow queue is serial, persistent and self-stopping

Concurrency here buys nothing and costs the account. The worker claims one action at a time (`claimNextAction`, guarded by a unique partial index so an account can never have two live actions), waits for a slot, calls, and records the outcome. Three behaviours matter more than throughput:

- A **checkpoint** clears the rest of the queue and pauses it. Retrying through a challenge is how a warning becomes a block.
- N consecutive failures trip a circuit breaker requiring a manual resume.
- Actions left `running` by a crashed process go back to `queued` at boot, never silently dropped or silently repeated.

### Dry run is a property of the action, not of the click

The `dry_run` flag is written onto the action row when it is queued, not read from global state when it runs. Flipping the toggle mid-queue therefore cannot retroactively turn a simulated action into a real one, or vice versa: each action executes under the mode it was created in.

A simulated action deliberately leaves the account as `following` and consumes no rate-limit quota — no request was made, so charging one would corrupt the ledger the limiter depends on. `DRY_RUN` in the environment sets `dryRunLocked`, which `setDryRun` refuses to override, so the safety floor cannot be lifted from the browser.

### Confirmation is checked server-side

`POST /api/unfollow/:pk` requires the client to echo the username it displayed. If the row shifted between render and click, the server refuses. A client-side `confirm()` alone cannot make that guarantee.

### Avatars are proxied

Instagram's avatar URLs are signed, expire within days, and are served by a CDN that inspects `Referer`. Rendering them directly would leak every account you follow to that CDN and break as the signatures age. `/api/avatar/:pk` fetches server-side, caches to disk for a week, and refuses any host that is not `*.cdninstagram.com` or `*.fbcdn.net` — without that allowlist the endpoint would be an SSRF gadget, since it takes a URL out of the database.

### The front end has no build step

`web/app.js` is the shipped source: ES modules, `IntersectionObserver` for infinite scroll, `<dialog>` for modals, CSS custom properties for theming, `content-visibility` so long lists stay cheap. It polls `/api/status` at 2.5 s while work is in flight and 20 s when idle, and only re-renders visible rows when the queue signature actually changes, so a poll never interrupts scrolling.

## Testing

Scripts must run in PowerShell and cmd as well as a Unix shell, so nothing may rely on the shell for glob expansion or PATH resolution of `.cmd` shims. `test/run.mjs` discovers the test files itself and launches them with `process.execPath`; the end-to-end harness starts the server the same way rather than through `npx`.

- `test/integration.test.ts` runs the real client, sync service and unfollow queue against `test/mock-instagram.ts`, covering pagination, follow-back computation, departures, a completed unfollow, duplicate rejection, and checkpoint handling.
- `test/archive.test.ts` covers every export shape, including the failure case.
- `test/e2e.mjs` starts the real server against the mock and drives the real dashboard in a real browser: sync, unfollow with confirmation, the list refreshing itself, and cancelling sending nothing.

No test touches a real Instagram account. `IG_BASE_URL` exists solely as that seam.

## Where to extend

- **More providers**: implement `Provider`, declare capabilities, register in `src/providers/index.ts`.
- **More filters**: add the column to `accounts`, a clause in `listAccounts`, and a chip in `web/index.html`. The sort allowlist in `SORTABLE` is the injection boundary — keep new sorts inside it.
- **Scheduled syncs**: the sync service is already single-flight; a timer calling `syncService.run()` is enough. Mind the read quota.
