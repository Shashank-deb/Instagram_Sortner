# Technical limits, risks and what actually works

Read this before you point the app at your real account.

## 1. The official APIs cannot do this

There are three official Meta APIs, and none of them covers "list who I follow and unfollow them":

| API | Can list who *you* follow? | Can unfollow? | Notes |
| --- | --- | --- | --- |
| **Instagram Graph API** (Business/Creator via a Facebook Page) | **No** | **No** | Exposes *your* media, comments, mentions, and aggregate insights. `followers_count` is a number, never a list. There has never been a "following" edge. |
| **Instagram Basic Display API** | **No** | **No** | Deprecated (shut down 4 Dec 2024). Only ever returned your own profile and media. |
| **Instagram API with Instagram Login** (the current replacement) | **No** | **No** | Messaging, comments, media, mentions. Same story: no social graph, no follow/unfollow write. |

There is no OAuth scope anywhere in Meta's platform that grants "read my following list" or "unfollow on my behalf". Unfollowing is deliberately not an API capability — it is a spam-control surface.

So any app that does what you asked for is, necessarily, driving Instagram's **private web/mobile endpoints** or **automating the UI**. There is no supported path. Everything below is about managing that fact.

## 2. The two honest ways to build it

### A. Data export import — zero risk, read-only

Instagram → Settings → **Accounts Centre** → *Your information and permissions* → **Download your information** → format **JSON**.

The export contains `connections/followers_and_following/following.json`, which is:

- complete (no pagination, no rate limit, no truncation),
- the **only** source that carries the **timestamp of when you followed each account**,
- produced by Meta for you, so using it breaks nothing.

What it cannot do: refresh on demand (you request a new export each time, delivery takes minutes to ~48h), give follower/following counts, give profile pictures, or unfollow anything.

This is the app's default provider.

### B. Session-cookie client — live data and real unfollows, at real risk

Instagram's own web app calls endpoints like:

```
GET  /api/v1/friendships/<your_id>/following/?count=50&max_id=<cursor>
GET  /api/v1/users/web_profile_info/?username=<name>
POST /api/v1/friendships/destroy/<target_id>/
```

authenticated with the `sessionid` cookie plus an `X-CSRFToken` header and the web client's `X-IG-App-ID`. This app talks to exactly those endpoints, using cookies from a browser session **you** log into yourself.

**This violates Instagram's Terms of Use** ("You can't attempt to create accounts or access or collect information in unauthorized ways... including by using automated means"). Understand the consequences before enabling it:

| Risk | What it looks like | Mitigation in this app |
| --- | --- | --- |
| **Action block** | "Try again later" on follow/unfollow, hours to days, sometimes weeks for repeat offenders | Hard daily cap (60), hourly cap (15), randomised 25–70 s gap, strictly serial queue |
| **Checkpoint / challenge** | Login gated behind a code or a "was this you?" screen | Detected on the response body; the queue stops itself and clears, and will not retry until you resume it manually |
| **Rate limit (HTTP 429)** | Responses dry up | Honoured with a cooldown (`Retry-After`, else 15 minutes) |
| **Session invalidation** | 401/302 to the login page | Surfaced as "log in again"; the app never re-submits credentials, because it never has them |
| **Account disable** | Permanent loss | Only realistic if you run large, fast, sustained automation. Don't. |

None of these numbers are published. The community-observed ceilings for an established account are roughly **150–200 follow/unfollow actions per day** and **~30–60 per hour**, lower for accounts younger than a few weeks. The defaults here sit deliberately below a third of that.

### C. Browser automation of the real UI — not used here, and why

Driving instagram.com with Playwright clicks is *slightly* less fingerprintable than raw API calls but much slower, much more brittle (the DOM changes constantly), and lands on the same rate limits. This app uses Playwright for **login only** — a real browser window, a real login, real 2FA, and then it keeps the cookies. That gets the authenticity benefit where it matters (session establishment) without the brittleness.

## 3. What "useful details" you can actually get

| Field | Data export | Live session | Notes |
| --- | --- | --- | --- |
| Username | ✅ | ✅ | |
| Full name | ❌ | ✅ | |
| Profile picture | ❌ | ✅ | Signed CDN URL, expires in days — proxied and cached locally |
| Private / verified | ❌ | ✅ | |
| **When you followed them** | ✅ | ❌ | **Only** the export knows this. Not recoverable from any API. |
| Follower / following counts | ❌ | ⚠️ | One extra request **per account**. 2 000 accounts = 2 000 requests. Fetched in small opt-in batches. |
| Do they follow you back | ✅ | ✅ | Requires walking your followers list too |

This is why the app merges both sources: import the export once for follow dates, then sync live for everything else. Archive rows are keyed `username:<name>` until a live sync resolves the real numeric id and adopts the date.

## 4. Login and credential handling

- The app **never asks for, sees, or stores your password.** `npm run login` opens a real Chromium window; you log in there, including 2FA. The app then reads the cookies the browser already holds.
- Cookies live in the local SQLite file, which is `chmod 600` on creation. They are sent to `instagram.com` and nowhere else.
- A `sessionid` is a full account bearer token. Treat that file like a password. Deleting it (Settings → Disconnect) is instant.
- The server binds to `127.0.0.1` by default. **Do not expose it.** Anyone who reaches the port controls your Instagram account. If you must bind elsewhere, set `APP_TOKEN` — the app warns loudly if you don't.
- Avatars are fetched server-side, so Instagram's CDN never sees your browser, and the proxy refuses any host that is not `*.cdninstagram.com` / `*.fbcdn.net`.

## 5. Deliberate omissions

- **No bulk unfollow.** Selecting 400 accounts and hitting "unfollow all" is the single most reliable way to get action-blocked. One at a time, through a confirmation, through a rate-limited queue.
- **No follower-growth tooling**, no follow-back automation, no scheduling. Those are what get accounts banned.
- **No credential storage**, ever.

## 6. Most practical recommendation

1. **Start with the export.** Import it, use the dashboard read-only. For "who am I following and when did I follow them", this is complete, free and risk-free.
2. **Add a session only when you actually want to unfollow.** Log in through the browser window.
3. **Leave the default limits alone.** 60 unfollows a day clears 1 800 accounts a month, which is faster than you'll decide who to cut.
4. **Do the pruning in sittings.** Queue a handful, let it drain, come back. If a checkpoint appears, stop for the day — resolve it in the real app, and don't resume until the next day.
5. **Keep it on localhost.**
