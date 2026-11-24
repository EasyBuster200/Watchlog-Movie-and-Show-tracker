# Watchlog plan: web app, accounts, sync, friends, admin

Status: **Phase 1 (web app) built; it goes live once the repository is connected to Cloudflare. Later phases not started.** This file collects what has been decided so far and the order to build it in. Update it as decisions change.

## Goals

1. Use Watchlog on an iPhone without a Mac or a paid Apple developer account, by also publishing it as an installable web app (PWA).
2. Optional **online accounts** that sync a person's library across their devices (Android app, iPhone/web).
3. **Friends**, with privacy settings that each person controls.
4. An **admin page** to see and control users, invites, usage and the server.
5. Spend nothing: everything runs on Cloudflare's free tier unless usage grows a lot.

## Decisions so far

| Topic | Decision |
|---|---|
| Hosting | Everything on **Cloudflare**: Pages for the app files, Workers for the API, D1 (SQLite) for the database, Worker secrets for keys. One account, one platform. |
| Sign-in | **Passkeys** (Face ID, fingerprint, screen lock). No passwords. |
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
     |   /auth    passkeys, sessions            |
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

**Built.** What was done and how is in `docs/DEVELOPMENT.md` ("The web app"). Hosted as a static-assets Cloudflare Worker (`wrangler.jsonc`) rather than Cloudflare Pages: Cloudflare now steers new projects to Workers, and the Phase 2 API joins the same Worker. Left to do: connect the repository in the Cloudflare dashboard (one-time) and try it on an iPhone. The backup reminder (7+ days since the last export) was brought forward from Phase 4, because the web app has no automatic backup.

Do this first: it works with today's local profiles and needs no backend.

1. **Host `public/` on Cloudflare Pages.** Connect the GitHub repo and deploy on every push. Pages gives a free `*.pages.dev` address with HTTPS.
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

1. A **Cloudflare Worker** project (e.g. `server/` in this repo), deployed with Wrangler, on its own subdomain or under `/api` on the same domain.
2. A **D1 database** with migrations checked into the repo.
3. **Secrets** (TMDB token, Web Push VAPID keys, session signing key) stored as Worker secrets, never in the repo, the app or the APK.
4. **Two environments**, `dev` and `prod`, so testing never touches real users' data.
5. **CORS:** allow only the app's own origins: the Pages domain and Capacitor's Android origin, `https://localhost`.
6. **Weekly database export** to R2 (free tier) as an extra backup beyond D1's built-in restore window.

## Phase 3: Accounts

### Two kinds of account

- **Local account:** today's profile, unchanged. Data stays on the device. Uses the person's own TMDB token. Never talks to the server. Anyone can use the app this way at no cost to the owner.
- **Online account:** signs in with a passkey. Syncs, can have friends, and uses TMDB through the server, so **no TMDB token is needed**.

The profile picker offers both. A local account can later be **upgraded** to an online one: sign up, then its existing IndexedDB data is uploaded as the first sync.

### Passkeys

- WebAuthn, with **SimpleWebAuthn** on the Worker (it runs on Workers).
- The relying party ID is the app's domain (the Pages domain or a custom one). **Decide the domain before launch:** passkeys are tied to it, so changing it later means everyone re-registers.
- **Multiple passkeys per account.** Passkeys sync within Apple's or Google's ecosystem, but not between them. Adding a second device:
  - sign in on the new device by scanning a QR code with a device that already has a passkey (the standard cross-device sign-in), then
  - offer to create a passkey on the new device.
- **Recovery:** losing every device must not mean losing the account. Show **one-time recovery codes** at sign-up (no email needed). Email recovery could come later.
- **Android app caveat:** the app runs in a WebView at `https://localhost`, where WebAuthn doesn't work by default. Options, to decide when building:
  1. enable WebView WebAuthn support (androidx.webkit) and publish a Digital Asset Links file (`/.well-known/assetlinks.json`) on the domain, tied to the release signing key; or
  2. use a Capacitor passkey plugin built on Android's Credential Manager (also needs `assetlinks.json`); or
  3. sign in through the system browser and hand a session back to the app via the existing `custom_url_scheme`.

### Sessions

- On sign-in the Worker issues a **session token** (long-lived, revocable, stored hashed in D1). The app keeps it with the profile and sends it as a bearer token. Cookies are avoided because the Android app and the web app are different origins.
- Signing out or revoking a session from another device (or from the admin page) deletes it on the server.

### Who can sign up

See [Keeping strangers off the TMDB token](#keeping-strangers-off-the-tmdb-token): sign-up is **invite-only** by default.

## Phase 4: Sync

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
- reset passkeys / generate new recovery codes for someone locked out

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

- A short **privacy policy** page: what's stored (username, passkey public keys, library, friends, push subscriptions), where (Cloudflare), why, and for how long.
- **Export my data:** existing manual export, plus server-side data for online accounts.
- **Delete my account:** removes server data, sessions and push subscriptions; local data stays unless the person deletes the profile.
- Store only what's needed: no real names or emails required.
- TMDB attribution stays.

## Costs

| Item | Expected |
|---|---|
| Cloudflare Pages, Workers, D1, R2, Access, Turnstile | €0 at friends-and-family scale |
| TMDB API | €0 (non-commercial) |
| Apple developer account / Mac | Not needed |
| Custom domain | Optional, about €10/year. Recommended before launch because passkeys are tied to the domain. |
| If it grows past free limits | Workers Paid, $5/month |

## Build order

1. Phase 1: PWA (no backend)
2. Phase 2: backend foundation
3. Phase 3: accounts (passkeys, invites, local vs online, upgrade a local account)
4. Phase 5: TMDB proxy (so online accounts need no token); can be built alongside Phase 3
5. Phase 8 (part 1): admin page with users, invites, limits and kill switch. **Needed before inviting anyone.**
6. Phase 4: sync, then remove auto-backup and add the local-account backup reminder
7. Phase 6: server notifications
8. Phase 7: friends
9. Phase 8 (part 2): the rest of the admin page

Each step leaves a working app.

## Open questions

- **Domain:** buy a custom domain, or stay on `*.workers.dev`? Decide before Phase 3 (passkeys are tied to it).
- **Android sign-in:** WebView WebAuthn, a Credential Manager plugin, or sign-in via the browser? Decide in Phase 3.
- **Several profiles on one device:** can each be a different online account (e.g. family members sharing a tablet)? Proposed: yes, one online account per profile.
- **Android notifications:** keep local notifications permanently, or move to server push later?
- **Usernames:** required for everyone, or only when turning on friends?
- **Existing Android users:** how to tell them auto-backup is going away (release notes, an in-app message, or both).
- **Docs:** once built, the user-facing parts go in the README (a user guide) and the technical parts in `docs/DEVELOPMENT.md` and `CLAUDE.md`.
