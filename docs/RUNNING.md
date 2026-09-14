# Running it, and knowing it works

Six stages. Each one ends with a check that either passes or tells you what is wrong. Do them in order — the later stages assume the earlier ones passed.

At any point, `npm run doctor` inspects your setup and prints what works, what doesn't, and the command to fix it.

---

## Before you start

| Need | Check with | Expected |
| --- | --- | --- |
| Node 20.11 or newer | `node -v` | `v20.11.0` or higher (v22 recommended) |
| npm | `npm -v` | any recent version |
| Git | `git --version` | any |

If `node -v` is missing or too old, install from [nodejs.org](https://nodejs.org) and reopen your terminal.

**Windows, macOS and Linux are all supported.** Every `npm run …` command below works the same in PowerShell, cmd and a Unix shell. Paths in the examples use forward slashes; Windows accepts those too, so you can paste them as-is.

---

## Stage 1 — Install

```bash
git clone -b claude/instagram-follow-tracker-2e9bxq \
  https://github.com/Shashank-deb/Instagram_Sortner.git
cd Instagram_Sortner
npm install
```

`npm install` compiles `better-sqlite3`, a native module, so it takes a little longer than a pure-JS install. A `prebuild-install` deprecation warning is normal and harmless.

### ✅ Check: the test suite passes

```bash
npm test
```

**Expected — the last lines:**

```
# tests 20
# pass 20
# fail 0
```

These run the real sync, queue and rate limiter against a local stand-in for instagram.com. Nothing touches a real account. If they pass, the code is sound on your machine and any later problem is configuration, not code.

> **`npm test` fails on a SQLite error?** Run `npm rebuild better-sqlite3`. That rebuilds the native module against your exact Node version.
>
> **Seeing `Could not find ...\test\*.test.ts`?** You are on a version from before this was fixed. `git pull` and run `npm test` again. The old script relied on the shell expanding `test/*.test.ts`, which PowerShell and cmd do not do.

---

## Stage 2 — Run it, read-only

No configuration needed. Without a `.env` file the app defaults to archive mode, which cannot contact Instagram at all.

```bash
npm run dev
```

**Expected:**

```
INFO  [server] provider=archive db=/path/to/Instagram_Sortner/data/sortner.sqlite
INFO  [server] dashboard at http://127.0.0.1:4317
```

Open **http://127.0.0.1:4317** in a browser.

### ✅ Check: the dashboard loads

You should see the header with a grey **READ-ONLY** pill, four zeroed stat cards, the search bar and filters, and an empty list saying *"Nothing here yet"*. That empty list is correct — you have not loaded any data yet.

### ✅ Check: doctor agrees

In a **second terminal** (leave the server running in the first):

```bash
npm run doctor
```

**Expected — the important lines:**

```
[  OK  ] Node 22.x.x
[  OK  ] Dependencies installed
[  OK  ] SQLite driver loads
[  OK  ] Database opened
[ WARN ] No accounts stored yet
[  OK  ] Read-only: this app cannot change your Instagram account
[  OK  ] Server responded 200
Summary
Everything essential works. 1 thing(s) worth a look above.
```

The "No accounts stored yet" warning is expected at this stage. Stage 3 fixes it.

**Stop the server** at any time with `Ctrl+C` in the first terminal.

---

## Stage 3 — Load your real following list

This is the zero-risk path: a file Instagram gives you, read locally.

1. In the Instagram app or on the web: **Settings → Accounts Centre → Your information and permissions → Download your information**.
2. Request a download of **Followers and following**, format **JSON** (not HTML).
3. Wait for the email. This takes minutes to a couple of days — it is Meta's queue, not something the app controls.
4. Download the `.zip`. Do not unzip it.

Then either drag it into **Settings → Import data export** in the dashboard, or:

```bash
npm run import -- ~/Downloads/instagram-yourname.zip
```

**Expected:**

```
INFO  [archive] loaded 412 following / 380 followers from instagram-yourname.zip
Parsed 412 following and 380 followers.
Imported: 412 new, 0 updated, 0 no longer followed.
```

### ✅ Check: your real accounts are on screen

Reload the dashboard. You should now see:

- **Following** showing your real count — compare it against the number on your Instagram profile. They should match.
- **Doesn't follow back** with a real number.
- A **followed** date on every row. This is the column no API can give you.
- Search, the filter chips, and every sort option working on your own data.

Try: type part of a username into search; click **Doesn't follow back**; sort by **Date followed** — your oldest or newest follows appear first.

**Still read-only.** There are no Unfollow buttons yet, by design.

---

## Stage 4 — Connect a session (only if you want to unfollow)

> Read [`LIMITS.md`](LIMITS.md) first. This uses Instagram's private endpoints, which is against their Terms of Use and carries a real risk of a temporary action block.

**Turn dry run on before you connect**, so nothing can reach your account while you are still checking things:

```bash
cp .env.example .env
```

Then edit `.env` and set these two lines:

```ini
PROVIDER=web
DRY_RUN=true
```

`DRY_RUN=true` in `.env` *locks* simulation on — it cannot be switched off from the browser, so no click can reach Instagram until you deliberately remove that line.

Now log in:

```bash
npm run login
```

A real Chromium window opens on instagram.com. **Log in there yourself**, including 2FA. The app never sees your password — it waits until your browser holds a valid session and then copies the cookies.

**Expected:**

```
Waiting for you to log in in the browser window…
Session captured. You can close the browser window.

Session stored for @yourname.
```

> **`npm run login` says Playwright is not installed?** Run `npx playwright install chromium` once, then retry. Or skip it: copy `sessionid`, `ds_user_id` and `csrftoken` from your own logged-in browser's cookies into **Settings → Paste cookies manually**. All three are required.

### ✅ Check: Instagram accepts the session

```bash
npm run doctor -- --verify
```

**Expected:**

```
[  OK  ] Session stored for ds_user_id 1234567890
[  OK  ] DRY RUN is on and locked
[  OK  ] Instagram accepted the session (@yourname)
```

If this says *"Instagram rejected the session"*, the cookies are stale — run `npm run login` again. If it says *"Session has no csrftoken"*, you pasted an incomplete set; all three cookies are required.

### ✅ Check: live sync works

Restart the server (`Ctrl+C`, then `npm run dev`) so it picks up the new `.env`, reload the dashboard, and press **Sync**.

**Expected:** the button reads `Syncing… 50`, `Syncing… 100`… and finishes with a toast like *"Synced: 12 new, 3 no longer followed"*. Rows now gain profile pictures, real names, follower and following counts, and verified/private markers. The header pill turns green and reads **DRY RUN**.

A sync of a few thousand accounts takes a few minutes — it is paced deliberately.

---

## Stage 5 — Try an unfollow safely

With the green **DRY RUN** pill showing, click **Unfollow** on any row.

**Expected:**

1. The dialog is titled **"Simulate unfollow?"** with a plain **Simulate** button — not a red Unfollow one.
2. Confirming shows a toast: *"Dry run: nothing sent for @name"*.
3. **The account stays in your Following list.** Nothing changed.
4. Open that person's profile on Instagram in another tab — you are still following them.

### ✅ Check: the queue machinery works

Open **Settings** and look at **Unfollow queue**. You'll see Status, what's queued, and your remaining budget for the hour and day. This is the same machinery that will run real unfollows, so seeing it work here means the plumbing is sound.

---

## Stage 6 — A real unfollow

Only once Stage 5 behaved correctly.

1. Stop the server (`Ctrl+C`).
2. Remove — or comment out — the `DRY_RUN=true` line in `.env`.
3. `npm run dev`, reload the dashboard.

### ✅ Check: the pill is red and reads LIVE

If it doesn't, the app is still simulating. Nothing you click can reach Instagram until that pill is red.

Now click **Unfollow** on one account you genuinely want to drop.

**Expected sequence:**

1. Dialog titled **"Unfollow?"**, red **Unfollow** button, text saying *"This takes effect on your real account."*
2. Confirm → toast *"Queued unfollow for @name"*, row shows a **Queued** tag with its own **Cancel** button.
3. Within 25–70 seconds the tag changes to **Unfollowing…**, then the row leaves the Following list.
4. Switch the status dropdown to **Unfollowed** — the account is there with a green **Unfollowed** tag.

### ✅ The only check that really counts

Open `https://www.instagram.com/<that-username>/` in a browser where you are logged in.

**The button must say "Follow", not "Following".**

That is ground truth. The dashboard reports what it did; Instagram reports what is. If Instagram says Follow, the app is working end to end.

Changed your mind mid-way? Click **Cancel** on the row while it still says **Queued** — nothing is sent. Once it says **Unfollowing…** it is in flight and cannot be recalled.

---

## Troubleshooting

| What you see | What it means | Fix |
| --- | --- | --- |
| No Unfollow buttons at all | Archive mode | Set `PROVIDER=web` in `.env`, restart, and connect a session (Stage 4) |
| Green **DRY RUN** pill; clicks do nothing to Instagram | Working as designed | Remove `DRY_RUN=true` from `.env` and restart |
| "Session has no csrftoken" | Incomplete cookies | `npm run login` again, or paste all three cookies |
| "Instagram rejected the session" / "log in again" | Cookies expired | `npm run login` again |
| Queue paused: "Instagram raised a checkpoint" | Instagram wants you to confirm it's you | Open Instagram normally, clear the prompt, **stop for the day**, resume tomorrow in Settings |
| "Daily unfollow cap reached" | You hit 60 today | Wait. This limit is what protects the account |
| `EADDRINUSE` on startup | Port 4317 is taken | Set `PORT=4318` in `.env` |
| `npm test` fails on SQLite | Native module mismatch | `npm rebuild better-sqlite3` |
| `EBUSY: resource busy or locked` during test cleanup (Windows) | Old version; the database was still open when the tests tried to delete their temp folder | `git pull` — the suite now closes it first |
| `Could not find ...\test\*.test.ts` | Old version; the shell was expected to expand the glob | `git pull` — the runner now discovers test files itself |
| Blank page in the browser | Server not running | Check the terminal; run `npm run doctor` |

When something is wrong and it isn't in this table, run `npm run doctor` — it names the problem and the command that fixes it.

---

## Optional: prove the whole stack in a browser, automatically

```bash
npx playwright install chromium   # once
npm run test:e2e
```

This starts a stand-in Instagram, starts the real server, drives the real dashboard in a real browser, and asserts that a real unfollow leaves the app, that per-row cancel prevents one, and that dry run sends nothing.

**Expected:**

```
✓ sync populated 5 rows through the UI
✓ unfollow reached Instagram for demo_user_1 (pk 2001)
✓ per-row cancel stops a queued unfollow from ever being sent
✓ dry run sent nothing and left @demo_user_0 followed
✓ mode indicator tracks dry run / live
end-to-end unfollow flow verified
```

Your real account is never involved.

---

## Where your data lives, and how to remove it

Everything is in `data/` inside the project folder:

- `data/sortner.sqlite` — your account list, history, and **your session cookies**. Created `chmod 600`. Treat it like a password.
- `data/avatars/` — cached profile pictures.
- `data/browser-profile/` — the Chromium profile from `npm run login`.

To disconnect: **Settings → Disconnect**, which clears the stored session immediately.

To erase everything: stop the server and `rm -rf data/`. The app rebuilds an empty database on the next start.

Nothing is ever sent anywhere except instagram.com. There is no server, no account, no telemetry.
