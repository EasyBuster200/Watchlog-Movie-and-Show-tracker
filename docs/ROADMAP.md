# Watchlog plan: web app, accounts, sync, friends, admin

Status: **Phase 1 (web app) is done and live at https://watchlogtracker.com. Phase 2 (server foundation) is built. Later phases not started.** This file collects what has been decided so far and the order to build it in. Update it as decisions change.

## Goals

1. Use Watchlog on an iPhone without a Mac or a paid Apple developer account, by also publishing it as an installable web app (PWA).
2. Optional **online accounts** that sync a person's library across their devices (Android app, iPhone/web).
3. **Friends**, with privacy settings that each person controls.
4. An **admin page** to see and control users, invites, usage and the server.
5. Spend nothing: everything runs on Cloudflare's free tier unless usage grows a lot.

## Decisions so far

| Topic | Decision |
|---|---|
| Hosting | Everything on **Cloudflare**: one Worker (`watchlog`, `wrangler.jsonc`) serves the app files now and will also run the API, D1 (SQLite) for the database, Worker secrets for keys. One account, one platform. |
| Sign-in | An **account key** (a long random key the person saves) plus a **required**, verified **recovery email**. Devices stay signed in; new ones are added with a one-time code from a signed-in device. No passwords, no passkeys for now (see Phase 3). |
| Architecture | **Local-first stays.** IndexedDB on the device is what the app reads and writes. The server is a sync partner and backup, never something a screen waits on. |
| Offline-only use | Still supported: a **local account** works like today's profiles, with no server and the person's own TMDB token. |
| Backups | Remove the automatic weekly backup to `Documents/Watchlog`. Keep manual **Export / Import**. For online accounts the server copy is the backup. |
| Friends | Yes, with a **privacy setting** that each person controls. |
| TMDB for online accounts | One server-held TMDB token (the owner's), used through the server. It never ships in the app or the APK. |
| Admin | A separate admin page, owner only. |

## How the pieces fit

```
 iPhone (PWA) / web browser          Android app (Capacitor)
          \                              /
           \   same public/ files       /
            v                          v
     +------------------------------------------+
     |  Device: IndexedDB (local-first)         |
     |  localApi.js fetch shim                  |
     |   - local account: TMDB direct, own token|
     |   - online account: TMDB via server,     |
     |     changes queued for sync              |
     +------------------------------------------+
                      |  HTTPS (online accounts only)
                      v
     +------------------------------------------+
     |  Cloudflare Worker  (api.<domain>)       |
     |   /auth    account keys, sessions, email  |
     |   /sync    push / pull changes           |
     |   /tmdb    TMDB proxy (owner's token)    |
     |   /friends friends, feed, shared lists   |
     |   /push    Web Push subscriptions        |
     |   /admin   owner-only API                |
     |   cron     episode checks, notifications |
     +------------------------------------------+
            |                    |
         D1 database        TMDB API (token is a
         (users, library,   Worker secret)
          friends, invites)
```

---

## Phase 1: Watchlog as a web app (PWA)

**Done, live at https://watchlogtracker.com** (first at a workers.dev address; `docs/DEVELOPMENT.md`, "The domain"). What was built and how is in `docs/DEVELOPMENT.md` ("The web app"). Hosted as a static-assets Cloudflare Worker (`wrangler.jsonc`) rather than Cloudflare Pages: Cloudflare now steers new projects to Workers, and the Phase 2 API joins the same Worker. Checked on the live site: every file is served, the service worker caches the whole app, and the `page.html` → `/page` redirect keeps the query string. Still to check on a real iPhone: status bar, safe areas, the share sheet. The backup reminder (7+ days since the last export) was brought forward from Phase 4, because the web app has no automatic backup.

Do this first: it works with today's local profiles and needs no backend.

1. **Host `public/` on Cloudflare** (done as a static-assets Worker). Connect the GitHub repo and deploy on every push, with a free `*.workers.dev` address with HTTPS.
2. **Check it in Safari as it is.** Profiles, browsing, tracking, stats and restore should mostly work already, because `localApi.js` doesn't need a server.
3. **Make it installable:**
   - a web app manifest (name, icons, `display: standalone`, theme colour)
   - `apple-touch-icon` (180×180 PNG, rendered from `docs/icons/watchlog-launcher.svg`)
   - iOS meta tags and `viewport-fit=cover`
   - safe-area padding for the fixed bottom nav and sticky headers
4. **Service worker** that caches the app's files, for fast and offline loads.
5. **`navigator.storage.persist()`** on startup, so the browser is less likely to clear IndexedDB.
6. **Web fallbacks for native-only bits:**
   - Export uses the browser share sheet (`navigator.share` with a file; "Save to Files" on iPhone) where available, or a download otherwise.
   - The installed version in Settings comes from a version string written at deploy time, not `WatchlogBackgroundPlugin.getAppInfo`.
7. **Testing without a Mac:** Playwright's WebKit browser on Windows, plus an on-page debug console (e.g. Eruda) loaded only with `?debug`.

**Why first:** it's the cheapest way to get the iPhone working, and every later phase builds on the hosted app.

## Phase 2: Backend foundation

**Built.** Details in `docs/DEVELOPMENT.md` ("The server"). What changed from the plan below: the API is under `/v1/` on the same address as the app (the app's own shim owns `/api/`); "two environments" are production and previews (every pull request's preview gets the `watchlog-preview` database); the weekly R2 copy keeps the newest 5; no secrets yet (none is needed until Phase 3). Not done yet: CORS for the Android app is configured but untested from the real app, since nothing calls the server yet.

1. Give the existing **`watchlog` Worker** (`wrangler.jsonc`, which only serves `public/` today) a script for `/api/*`, e.g. in `server/`. Same domain as the app, so no separate subdomain.
2. A **D1 database** with migrations checked into the repo.
3. **Secrets** (TMDB token, Web Push VAPID keys, session signing key) stored as Worker secrets, never in the repo, the app or the APK.
4. **Two environments**, `dev` and `prod`, so testing never touches real users' data.
5. **CORS:** allow only the app's own origins: the app's domain and Capacitor's Android origin, `https://localhost`.
6. **Weekly database export** to R2 (free tier) as an extra backup beyond D1's built-in restore window.

## Phase 3: Accounts

**In progress, in three parts:** **3a, the server** (accounts, account keys, sessions, pairing codes, device list, rate limits; built, see `docs/DEVELOPMENT.md`, "Accounts API"); **3b, the app** (create or sign in to an online account, save the key, add a device, the device list, upgrade a local profile; built, see `docs/DEVELOPMENT.md`, "Accounts in the app"; shown to everyone since the admin page (Phase 8 part 1) made sign-up approval-based; online accounts use the owner's TMDB token through the Phase 5 proxy, built alongside; signing out asks whether to keep a copy on the device or remove it, decided with the user); **3c, the recovery email** (built on watchlogtracker.com, see `docs/DEVELOPMENT.md`, "Email and account recovery": Resend, a code at sign-up, recovery with a 24-hour hold, every account made before it deleted, decided with the user). Decided with the user: the recovery email is **required** (accounts made before 3c will be asked to add one), the recovery hold is **24 hours**, and sign-up was **open** with rate limits until the admin page added sign-up modes (approval by default). Online accounts keep using their own TMDB token until Phase 5.

### Two kinds of account

- **Local account:** today's profile, unchanged. Data stays on the device. Uses the person's own TMDB token. Never talks to the server. Anyone can use the app this way at no cost to the owner.
- **Online account:** signs in with its account key (below). Syncs, can have friends, and uses TMDB through the server, so **no TMDB token is needed**.

The profile picker offers both. A local account can later be **upgraded** to an online one: sign up, then its existing IndexedDB data is uploaded as the first sync.

### Signing in: an account key, with a recovery email

Decided with the user after comparing passkeys, passwords, email codes, "Sign in with Google", Cloudflare Access and hosted login services. Passkeys were dropped as the main sign-in because they're tied to the domain, hard to use inside the Android app's WebView (it runs at `https://localhost`), and unavailable on older phones. Passwords were dropped because proper password hashing doesn't fit the free plan's 10 ms CPU per request, and a leaked password table is a liability.

**The account key**
- Creating an online account generates a long random **account key** (about 128 bits). It's shown in a human-friendly form, in groups with a check character so typos are caught (e.g. `WLG4-7KQ2-…`).
- It's the account's credential: entering it on any device signs that device in. The server stores only a hash of it. The key is random and long, so a fast hash (SHA-256) is safe and fits the free plan's CPU limit.
- At sign-up the app makes saving it easy: **Save to Files**, copy (for a password manager), or print. It then asks for the last few characters to confirm it was saved. Profile reminds people who never confirmed, like the web app's backup reminder.
- **Settings → Account key** shows it again on any signed-in device, and **Make a new key** replaces it (the old one stops working at once).
- No domain lock-in and no WebView problems: the key is typed (or scanned as a QR code) inside the app on every platform, including the Android app and older phones.

**Adding a device**
- Usually without the key: on a signed-in device, **Settings → Add a device** shows a one-time code and QR code (valid a few minutes). The new device enters or scans it and is signed in.
- Or by entering the account key.

**The recovery email**
- For when every signed-in device *and* the key are lost. Every online account must have an email address (decided with the user), **verified** with a code sent to it before it counts.
- **Recovery:** on a new device, "Lost your key?", then enter the email, then a one-time code arrives, then enter it. The account then gets a **new key** (the old one stops working), and every other session is signed out.
- **Safeguard against a hacked inbox:** recovery completes after a **hold** (proposed 24 hours). During it, every signed-in device shows "Someone is recovering your account. Not you? Cancel", and the address gets an email saying the same.
- Only the address is stored, and only for recovery and notices about the account (no newsletters). It can be changed or removed in Settings.
- **Sending email needs a domain we own:** every email service requires proving ownership of the sender's domain, and `workers.dev` can't be used. See [Open questions](#open-questions).

**Other safeguards**
- Signing in with a key and recovery requests are rate-limited (per address and per account); Turnstile guards account creation and recovery.
- **Settings → Devices** lists every signed-in device with its last use; any can be signed out from another.
- Last resort, for family: the owner can issue a new key from the admin page after checking identity (logged in the audit log).
- Even if an account is truly lost, the library isn't: it's on the person's devices and in their exported backups, and can fill a new account.

**Possible later additions:** trusted-friend recovery (once friends exist, Phase 7) and optional passkeys as a faster sign-in, once the domain is settled.

### Sessions

- On sign-in the Worker issues a **session token** (long-lived, revocable, stored hashed in D1). The app keeps it with the profile and sends it as a bearer token. Cookies are avoided because the Android app and the web app are different origins.
- Signing out or revoking a session from another device (or from the admin page) deletes it on the server.

### Who can sign up

Sign-up is **open for now** (decided with the user): creating accounts is rate-limited per address and overall. It becomes **invite-only** once the admin page can make invites, and before the TMDB proxy (Phase 5) is switched on; see [Keeping strangers off the TMDB token](#keeping-strangers-off-the-tmdb-token).

## Phase 4: Sync

**Built, in two parts:** **4a, the server** (`POST /v1/sync`, see `docs/DEVELOPMENT.md`, "Sync API") and **4b, the app** (`public/scripts/sync.js`: recording changes, sending and receiving them, applying them to the device; `docs/DEVELOPMENT.md`, "Sync in the app"). Online accounts were shown to everyone once the admin page (Phase 8 part 1) existed. Decided with the user:
- Lists with the same name made on two devices before they sync are **kept apart, one renamed** ("Horror (2)").
- **Reset all data** on an online profile **empties the library everywhere** (the server, so every signed-in device), with a clear warning.
- **Theme, accent colour, region and language sync**; the notification and auto-backup switches stay per device.
- Lists get a shared sync id (the Watchlist a fixed one); the app keeps using its device-local list numbers, so pages don't change.

**How it was built** differs from the plan below in a few places: one `POST /v1/sync` both sends and receives (not separate push and pull); record keys are `550` (watched movie), `1399:1:1` (episode), `movie:550` (favourite), the list's sync id, and `<list sync id>:movie:550` (list item); the notification switches don't sync (decided with the user). From "Effects on the rest of the app", decided differently: **only online profiles** stop auto-backing up (their library is on the account); offline Android profiles keep the weekly file, since nothing else protects them.

**Also decided with the user:** a page the person hasn't touched reloads itself when changes arrive (a touched one shows a Refresh notice); a copy kept at sign-out stays a separate offline profile, and signing in again starts from the account; changes are stamped with the server's clock (each sync reply carries `serverTime`), so a device with a wrong clock still has its newest change win.

**Backups and the CPU limit (solved):** the weekly R2 backup used to build the dump inside the Worker, which would outgrow the free plan's 10 ms of CPU per Cron run once synced libraries fill `sync_records`. It now asks D1 to export the database and only streams the finished file into R2 (decided with the user, over a GitHub Action or a backup split across runs). It needs the `BACKUP_API_TOKEN` secret (`docs/DEVELOPMENT.md`, "Server database").

### Rules

- IndexedDB stays the source of truth for the screen. Writes are instant and work offline.
- Every synced record has a **stable sync ID**, an **`updatedAt`** time, and a **`deleted`** flag (a "tombstone") instead of being removed, so deletions reach other devices.
  - Where a record has a natural key, use it: `movie:<id>` for watched movies, `tv:<id>:<s>:<e>` for watched episodes, `<type>:<id>` for favourites. Lists and list items get UUIDs.
  - This means a `localDb.js` version upgrade that adds the fields to existing rows.
- **What syncs:** watched movies, watched episodes, favourites, lists and list items (including the Watchlist), and profile preferences (theme, accent, region, language, notification switches).
- **What doesn't sync:** `tmdb_cache` (each device rebuilds it), and the local TMDB token.

### How

- `localApi.js` already handles every write, so it records each change in a small **outbox** store.
- **Push:** when online, send the outbox to `POST /sync/push`. Retry until the server confirms.
- **Pull:** `GET /sync/pull?since=<cursor>` returns everything changed since the last pull. The cursor is a **server-assigned sequence number**, never a device clock, because phone clocks can be wrong.
- **Conflicts:** the newest `updatedAt` wins, per record. For this data (on/off facts) conflicts are rare and harmless.
- **When:** on app open, when the connection comes back, after a write (debounced by a few seconds), and on Settings' "Sync now".
- Settings shows the last sync time and any error.

### Effects on the rest of the app

- **Backups:** an online account's server copy is its backup. Remove `autoBackup.js`, its Settings switch and the Profile status row. Keep manual Export / Import for everyone.
  - **Local accounts lose their automatic backup** with this change. Show a **backup reminder** for local accounts not exported in 7+ days.
  - Existing Android users: release notes should say that automatic backups stop, and point them to manual export or upgrading to an online account.
- **Recommendations, stats, show status:** unchanged; they read IndexedDB, which sync keeps filled.

## Phase 5: TMDB through the server

**The proxy is built** (pulled into Phase 3 with the user, so online accounts never ask for a TMDB token): `server/src/routes/tmdb.js`, `GET /v1/tmdb/*`, the `TMDB_TOKEN` secret, daily limits per account (5,000) and overall (40,000), the `TMDB_PROXY` on/off switch, edge caching where available. Details in `docs/DEVELOPMENT.md` ("The TMDB proxy"). Still to do from the list below: per-account usage on the admin page. Sign-up stays open while online accounts are hidden; it must become invite-only before they are shown to everyone (decided with the user).

For online accounts, `localApi.js`'s two TMDB chokepoints (`handleTmdbPassthrough`, `fetchLocalTmdb`) send requests to the Worker's `/tmdb/*` instead of `api.themoviedb.org`. Local accounts keep going direct with their own token.

The Worker:
1. checks the session and that the account is active,
2. applies per-account rate limits (see below),
3. caches GET responses with Cloudflare's Cache API (e.g. trending and popular for an hour, `/movie/{id}` for a day) so repeated requests from different people don't reach TMDB,
4. calls TMDB with the owner's token, held as a Worker secret,
5. counts calls per account per day for the admin page.

The existing client-side behaviour (20 concurrent requests, timeouts, retries, de-duplication, the 7-day detail cache, adult filtering, language) stays in `localApi.js` and works the same.

### Is a free TMDB token enough for friends and family?

Yes, as far as TMDB's terms go:
- TMDB's API has **no paid tier for this kind of use**. The free token is the normal token.
- There's **no daily quota**. The limit is a rate of roughly 50 requests per second, and the Worker's cache plus the app's own detail cache keep a family nowhere near it.
- **Non-commercial use is allowed**, with attribution (already on `profile-picker.html`). Don't charge for the app or show ads. Using the API commercially needs a separate agreement with TMDB.
- Re-read TMDB's API terms before launch (caching rules, attribution, who counts as an "end user"), since they can change.

The tighter limit is **Cloudflare's 100k Worker requests a day** on the free plan. A heavy page load can make a few dozen TMDB calls, so a rough budget:

| Users | Rough Worker requests/day | Fits free plan? |
|---|---|---|
| 5–10 | 2k–5k | Easily |
| 30–50 | 10k–30k | Yes |
| 200+ | Could exceed 100k | Workers Paid ($5/month) or per-user tokens |

## Keeping strangers off the TMDB token

The site and the APK are public, so assume anyone can open the app. Several layers:

1. **The token never leaves the server.** It's a Worker secret. It isn't in `public/`, the APK, the repo or any response. Someone reading the app's code finds nothing to steal.
2. **The proxy only serves signed-in, active online accounts.** A stranger who opens the app can still create a **local account with their own token**, which costs the owner nothing.
3. **Invite-only sign-up.** Creating an online account needs an **invite code** created on the admin page (single use, expiring). The admin page can switch sign-up between closed, invite-only and request-approval (anyone can ask; the owner approves).
4. **Cloudflare Turnstile** (free, privacy-friendly bot check) on sign-up and sign-up requests, against automated sign-ups. It runs in its own widget, not something the app solves.
5. **Per-account rate limits** on `/tmdb` (e.g. a per-minute burst limit and a daily cap), so even a real account can't run up usage.
6. **A global kill switch and daily cap.** If total TMDB proxy calls pass a threshold, the Worker stops forwarding and the admin page shows why. This protects the token's standing with TMDB.
7. **Suspend or delete** any account, and revoke its sessions, from the admin page.
8. **Rotate the token** if it ever leaks: make a new one on TMDB and update the Worker secret. No app release needed.

## Phase 6: Notifications through the server

**Built** (`server/src/notifications.js`; `docs/DEVELOPMENT.md`, "Server notifications"): an hourly run sends new episodes, release reminders and the weekly recap to web app devices of online accounts, from synced data, at 18:00 / Sundays 19:00 in each device's time zone. Decided differently from the plan below:
- **The switches stay per device**, stored on the device's push subscription (as the Android app's are per device, decided with the user earlier), not synced.
- The friend events wait for Phase 7. Android keeps its local notifications.
- Limits: 15 TMDB lookups and 30 notifications per run (free plan); titles in English; the recap's "coming up" counts one episode per show.

- **iPhone/web:** Web Push. The service worker subscribes; the Worker stores the subscription and sends pushes. iOS needs 16.4+ and the app installed to the home screen.
- **Android:** keep today's local notifications and `EpisodeCheckWorker` at first, since they work offline and don't need the server. Moving Android to server push (Firebase Cloud Messaging) can come later if useful.
- **Hourly cron** on the Worker:
  - **new episodes:** checks tracked shows' `next_episode_to_air` (known from synced watched episodes) and sends at 18:00 in each person's time zone,
  - **release reminders:** for Watchlist movies, from the synced Watchlist and region,
  - **weekly recap:** worked out on the server from synced data, accurate even if the app wasn't opened that week,
  - **friend events:** see Phase 7.
- The same per-person switches in Settings, now synced.
- Tapping a notification opens the same pages as today (`detail.html?type=tv&id=`, stats, the movie).

## Phase 7: Friends

**Step 1 is built** (`server/src/routes/friends.js`, `public/friends.html`, `friend.html`; `docs/DEVELOPMENT.md`, "Friends"): friend codes, requests (accept, decline, cancel), removing and blocking, what friends see, and a friend's profile. Decided with the user: people find each other **by friend code only** (no usernames, no search); friends see **everything by default** (the setting is "What your friends see": everything, lists and favourites, or nothing; per account, not per list yet); a new request shows as a banner on every device and as a Web Push notification where "Friend requests" is switched on (the Android app gets the banner). **Step 2 is built** too: friends on a title's page ("Ana is on S3 · E4"), the activity feed (Home and `activity.html`, the last 30 days) and taste match on a friend's page. Decided with the user: these **follow "What your friends see"** instead of a separate activity switch (so the "Activity feed: don't share" and "private by default" ideas below were not taken). Next: recommending a title, shared lists, per-list privacy.

### Privacy first

Each online account has a **privacy setting**, synced and enforced **on the server** (never trusted from the app):

| Setting | Options |
|---|---|
| Who can find me | Anyone with my username / Only with my friend code / Nobody |
| What friends see | Everything / Lists and favourites only / Nothing |
| Activity feed | Share my activity / Don't share |
| Per list | Private / Friends / Shared with chosen friends |

Default to **private**: findable by friend code only, activity not shared, lists private. People opt in.

Local accounts have no friends features.

### Features, in order

1. **Usernames and friend codes;** friend requests (send, accept, decline, remove, block).
2. **Friend profile:** what that friend's privacy setting allows (favourites, lists, stats summary).
3. **On a show or movie page:** "2 friends watched this", "Ana is on S3E4".
4. **Activity feed** on Home or Profile, built from synced changes that the author allowed to share.
5. **Recommend to a friend:** send a title with an optional note; it shows up as a notification and in a "Recommended by friends" row.
6. **Shared lists:** several members can add and remove items. Builds on lists with a members table and permissions; syncs like everything else.
7. **Taste match:** the overlap between two people's watched titles, as a percentage.
8. **Friend notifications** (optional, each switchable): new friend request, recommendation received, shared list changed.

### Server rules

- Every friends query checks the friendship **and** the target's privacy setting on the server.
- Blocking hides you from search and stops requests and recommendations.
- Rate-limit friend requests and recommendations, against spam.

## Phase 8: Admin page

**Part 1 is built** (`public/admin.html`, `server/src/routes/admin.js`; `docs/DEVELOPMENT.md`, "Admin and sign-ups"): sign-up requests (approve / decline), the sign-up mode (closed, invite-only, approval, open; **approval is the default**, decided with the user), invites, users (sign out, suspend, delete), counts, the TMDB proxy's switch and daily cap, the last backup, and the audit log. With it, online accounts stopped being hidden behind the preview switch (decided with the user). Decided differently from the plan below:
- **The admin is an account id in the `ADMIN_ACCOUNT_IDS` Worker secret**, not a role column, and **Cloudflare Access** (an emailed code, the owner's address only) guards `/admin*` and `/v1/admin*` since the move to watchlogtracker.com (`docs/DEVELOPMENT.md`, "Admin and sign-ups").
- **The owner hears about sign-up requests** as a banner on any signed-in device (from each sync) and as a **Web Push notification** (built here, Phase 6's foundation; iPhone and browsers, not the Android app). An **email** to the owner was added with Phase 3c.
- Not built yet from part 1: Turnstile, per-minute burst limits. Pending requests aren't cleaned up automatically.

### Access

- Lives at a separate path, e.g. `/admin`, served by the Worker, and **not linked from the app**.
- Protected two ways:
  1. **Cloudflare Access** (Zero Trust free plan, up to 50 users) in front of `/admin`, so only the owner's identity gets through to the page at all, and
  2. an **`admin` role** on the owner's account, checked by every admin API call.
- Every admin action is written to an **audit log**.

### What it shows and controls

**Users**
- list with username, created, last seen, devices/sessions, status (active, pending, suspended), storage used, TMDB calls today/this month
- approve pending sign-ups, suspend, unsuspend, delete (with their data), revoke sessions
- issue a new account key for someone locked out (after checking who they are), or cancel a recovery in progress

**Sign-ups and invites**
- sign-up mode: closed / invite-only / request-approval
- create invite codes (single use, expiry, optional note "for Mum"), see which were used and by whom

**Usage and limits**
- TMDB proxy calls per day (total and per user), cache hit rate, Worker requests against the free limit, D1 size
- per-account rate limits, global daily cap, TMDB proxy kill switch

**Health**
- recent errors, last cron runs (episode checks, notifications sent, failures), last database export to R2

**Notifications**
- send a test push to yourself; announcement push to everyone (e.g. "new version")

**Friends and safety**
- reports (if a "report user" button is added), blocks

### What it doesn't show by default

People's watch history and lists are **not** visible on the admin page. It shows counts and metadata only. That keeps the owner's own access in line with the privacy promises made to friends and family. If support ever needs it, an explicit "view data" action for one account, logged in the audit log, is the most it should allow.

## Privacy and legal basics (EU / GDPR)

- A short **privacy policy** page: what's stored (the account key's hash, the recovery email, username, library, friends, push subscriptions), where (Cloudflare), why, and for how long.
- **Export my data:** existing manual export, plus server-side data for online accounts.
- **Delete my account:** removes server data, sessions and push subscriptions; local data stays unless the person deletes the profile.
- Store only what's needed: no real names or emails required.
- TMDB attribution stays.

## Costs

| Item | Expected |
|---|---|
| Cloudflare Workers, D1, R2, Access, Turnstile | €0 at friends-and-family scale |
| TMDB API | €0 (non-commercial) |
| Apple developer account / Mac | Not needed |
| Custom domain | About €10/year. Needed to send recovery emails (the sender must be on a domain we own). |
| Email sending | Free at this scale (Cloudflare Email Sending or Resend's free tier; see Open questions). |
| If it grows past free limits | Workers Paid, $5/month |

## Build order

1. Phase 1: PWA (no backend). **Done.**
2. Phase 2: backend foundation
3. Phase 3: accounts (account key, device pairing, recovery email, invites, local vs online, upgrade a local account)
4. Phase 5: TMDB proxy (so online accounts need no token); can be built alongside Phase 3
5. Phase 8 (part 1): admin page with users, invites, limits and kill switch. **Done** (after Phase 4), with Web Push for sign-up requests.
6. Phase 4: sync, then remove auto-backup and add the local-account backup reminder
7. Phase 6: server notifications. **Done**
8. Phase 7: friends (steps 1 and 2 done: codes, requests, profiles, friends on titles, activity, taste match)
9. Phase 8 (part 2): the rest of the admin page

Each step leaves a working app.

## Open questions

- **Domain:** a custom domain is needed to send recovery emails (Phase 3). Which one? The app can stay on `workers.dev` and only email come from the domain, or the app can move to it too (no sign-in depends on the address any more, so moving later is safe).
- **Email service:** Cloudflare Email Sending (beta, same platform; check its free limits) or Resend (free tier, about 100 emails a day). Both need the domain's DNS records.
- **Several profiles on one device:** can each be a different online account (e.g. family members sharing a tablet)? Proposed: yes, one online account per profile.
- **Android notifications:** keep local notifications permanently, or move to server push later?
- **Usernames:** required for everyone, or only when turning on friends?
- **Existing Android users:** how to tell them auto-backup is going away (release notes, an in-app message, or both).
- **Docs:** once built, the user-facing parts go in the README (a user guide) and the technical parts in `docs/DEVELOPMENT.md` and `CLAUDE.md`.
