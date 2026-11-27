# Watchlog — development guide

Everything technical: how the app works, building it, testing it, and publishing a release.
For using the app, see the [README](../README.md). For a deeper, file-by-file architecture
reference (data flow, storage shape, the conventions shared between pages), see
[CLAUDE.md](../CLAUDE.md).

## How it works

Watchlog is a plain HTML/CSS/JavaScript app (`public/`) wrapped in an Android app with
[Capacitor](https://capacitorjs.com/) 6, and also published as an installable web app (see
[The web app](#the-web-app-iphone-and-browsers)). There's no server, no bundler and no build step for the
web code: pages load their scripts with ordinary `<script>` tags.

- **No backend.** `public/scripts/localApi.js` patches `window.fetch` and answers the app's own
  `/api/...` requests locally, so the pages are written as if there were a server.
  - `/api/tmdb/*` requests go straight to [TMDB](https://developer.themoviedb.org/docs), using
    the active profile's own API Read Access Token as a bearer token.
  - Everything else (lists, watched, favorites, stats, recommendations, schedule) reads
    and writes the active profile's own IndexedDB database (`localDb.js`), one database per
    profile.
  - TMDB calls are rate-limited, retried, de-duplicated and, for movie/show details and credits,
    cached for 7 days.
- **Profiles** are a small registry in `localStorage` (`profiles.js`). Each holds a display name
  and a TMDB token; the token is checked against TMDB before it's saved.
- **Backups** (`backup.js`) are a JSON export of a profile's database, without the TMDB token.
  `autoBackup.js` writes one per profile per week to the phone's public `Documents/Watchlog`
  folder.
- **Settings** (`settings.js`) are kept per profile on its registry entry (`profiles.js`):
  theme and accent (applied before paint by `theme.js`), region and TMDB language, the three
  notification switches and auto-backup.
- **Notifications** (`notifications.js`) use `@capacitor/local-notifications` to schedule
  new-episode notifications, release reminders for Watchlist movies and a weekly recap when the
  app opens. A native daily job keeps them coming without
  opening the app: `android/.../WatchlogBackgroundPlugin.java` + `EpisodeCheckWorker.java`,
  which use WorkManager.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer.
- **JDK 17** for the Android build. The Gradle/AGP versions that Capacitor 6 uses predate JDK 21
  support, so don't build with 21+.
- The [Android SDK](https://developer.android.com/studio#command-line-tools-only) (platform 34,
  build-tools 34, platform-tools), or Android Studio, which includes it.
- A TMDB API Read Access Token to use the app (see the README).

## Build

```bash
npm install
npm run sync   # copies public/ into the Android project (npx cap sync android)
```

Then build an APK (bash/Git Bash shown; set the paths for your machine):

```bash
cd android
JAVA_HOME="C:/Program Files/Java/jdk-17" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" ./gradlew assembleRelease
```

The APK is `android/app/build/outputs/apk/release/app-release.apk`. Install it on a phone
connected with USB debugging:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`npm run open:android` opens the project in Android Studio instead.

**Versioning:** `versionCode` is the number of commits on the current branch
(`git rev-list --count HEAD`), and `versionName` is `2.<that number>` (the 2.x series is the redesign; 1.x was the original design, up to 1.61). Every build from a newer
commit is a higher version, so it installs as an update and keeps the app's data.

### Signing

Release builds are signed with a key kept **outside the repository**. Gradle reads its details
from `~/.android/watchlog-release.properties`, or from the file named by the
`WATCHLOG_SIGNING_PROPERTIES` environment variable:

```properties
storeFile=C:/Users/you/.android/watchlog-release.jks
storePassword=...
keyAlias=watchlog
keyPassword=...
```

Create the keystore once (`keytool` comes with the JDK):

```bash
keytool -genkeypair -v -keystore watchlog-release.jks -alias watchlog -keyalg RSA -keysize 2048 -validity 10000
```

Without the properties file, release builds come out unsigned and can't be installed.

> **Never lose the key, and never sign a build with a different one.** Android only installs an
> update signed with the same key as the installed app. A differently-signed build can only be
> installed by uninstalling first, which deletes the user's data. Keep the keystore and its
> passwords backed up. For the same reason, don't install a debug build (signed with your
> machine's debug key) over a release build.

## Running it without Android

The app is a static site until Capacitor wraps it, so most of it can be developed in a browser:
serve `public/` with any static file server (`.claude/launch.json` has an `npx serve public`
configuration) and open `profile-picker.html` to create a profile. Turn off "clean URLs" if your
server has them (`serve.json` does this for `npx serve`): pages pass their parameters in the query
string, and `npx serve`'s redirect from `page.html?id=1` to `/page` drops it. Native-only
features (the weekly backup file, notifications, the hardware back button) need the real Android
build.

## The web app (iPhone and browsers)

The same `public/` folder is also published as a website that installs like an app (a PWA), which
is how Watchlog runs on an iPhone without the App Store: open the site in Safari, then Share →
**Add to Home Screen**. The pieces:

- **`manifest.webmanifest`** names the app and its icons (`images/icon-*.png`, plus
  `images/apple-touch-icon.png` for iPhone and `images/icon.svg` as the browser tab icon). Every
  page links it and carries the iPhone meta tags. The PNGs are rendered from
  `docs/icons/watchlog-launcher.svg`: the "any" icons with its rounded corners, the maskable and
  iPhone ones as a full square (the phone rounds them itself).
- **`sw.js`**, the service worker, makes the app open offline. It's network first: online, every
  file comes fresh from the server, so a deploy shows up on the next load; offline (or after 4 s
  with no answer) it uses the cached copy. Its `PRECACHE` list must name every file in `public/`;
  `tests/pwa.test.js` fails when it doesn't, so add new pages and scripts there.
- **`scripts/pwa.js`** registers the service worker and asks the browser to keep the site's
  storage (`navigator.storage.persist()`). It does nothing in the Android app.
- **`theme.js`** sets the `theme-color` tag from the theme, which colours the browser bar and the
  installed app's status bar. Layout CSS pads with `env(safe-area-inset-*)` for the notch and the
  home indicator.
- **Backups:** the web app has no automatic backup. Settings > Export data opens the share sheet
  on phones ("Save to Files" on iPhone) or downloads the file on a computer, and `backup.js`
  records when each profile last exported. The Profile page shows a reminder when there's never
  been an export or the last one is 7+ days old.
- **Version:** `tools/write-web-version.js` writes `public/version.json` (`2.<commit count>`, the
  same numbering as the APK, plus the commit id from git) during the deploy, and Settings shows
  it. It's not committed; without it Settings says "web preview".
- **Notifications** on the web come from the server, for online accounts ("Server notifications"
  below). Offline profiles in the web app have none.

### The domain

The app's address is **watchlogtracker.com**: a Custom Domain of the `watchlog` Worker
(dashboard: Workers & Pages → watchlog → Settings → Domains & Routes). `www.watchlogtracker.com`
is a second Custom Domain, sent on to the bare domain by a Redirect Rule on the zone ("Redirect
from WWW to root": `https://www.*` → `https://${1}`, 308, query string kept), so everyone uses
one address (a web app's data belongs to its exact address). The Android app's server is the
domain too (`serverApi.js`'s `PRODUCTION_SERVER_URL`).

The first address, `watchlog.duartecruzcoelho.workers.dev`, is being switched off (decided
with the user): the **Production** workers.dev toggle on that page. Keep the **Preview** toggle on:
pull request previews still live on workers.dev.

### Hosting on Cloudflare

The site is hosted for free as a [Cloudflare Worker](https://developers.cloudflare.com/workers/static-assets/),
deployed from GitHub. `wrangler.jsonc` (repository root) names the Worker `watchlog`, points it at
`public/` for the app's files, and at `server/src/index.js` for the server (see
[The server](#the-server)).

One-time setup in the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**,
pick this repository, then:

| Setting | Value |
|---|---|
| Project name | `watchlog` (must match `name` in `wrangler.jsonc`) |
| Build command | `npm run cf:build` (on **both** tabs, see below) |
| Deploy command | `npm run cf:deploy` |
| Preview command | `npx wrangler preview` |
| Preview builds | On |

Afterwards these live in the Worker's **Settings → Builds**, which has two tabs with separate
settings: **Production** (build and deploy command, used for `main`) and **Previews Base**
(build and preview command, used for every other branch). A change on one tab doesn't reach the
other, so the build command has to be `npm run cf:build` on both.

Two more traps in that page:

- **Each preview copies Previews Base when it's created and keeps that copy.** Changing Previews
  Base only affects branches pushed for the first time afterwards. An existing preview has its
  own **Build configuration** on its own Settings page (switch from Production to the branch at
  the top of the dashboard); change it there, or delete the preview and push again.
- Every section saves separately (the **Save** in the "Unsaved changes" bar), and the
  Production / Previews Base switch has been seen showing the other tab's values. After a change,
  reload the page and check both tabs.

Every push to `main` then deploys the site, live at **https://watchlogtracker.com** ("The domain" below),
and every other branch gets its own preview address, `https://<branch>-watchlog.<subdomain>.workers.dev`
(the pull request's "Workers Builds" check links to the build, whose **Visit** button opens it),
which can be opened on a phone to try a change before merging. `wrangler preview` refuses to run
without the `previews` block in `wrangler.jsonc`, so keep it. A preview's version number counts
the branch's own commits, so it can be higher than what `main` gets after a squash merge.

The build command runs for every build, previews and `main` alike: `cf:build` (`package.json`)
writes `version.json` and applies the database migrations to the **preview** database. Only
`main` then runs the deploy command, `cf:deploy`, which applies them to the **production**
database before deploying. Previews run the preview command, `npx wrangler preview`, which never
touches the production database. Keeping
the commands in `package.json` means changing them doesn't need the dashboard. Wrangler isn't a dependency of
this repository: Cloudflare's build runs it with `npx` (it needs a newer Node than the Node 18 the
app's tooling supports).

Cloudflare serves `page.html` at `/page` and redirects to it. The service worker caches pages
without the `.html`, so both addresses work offline.

### The server

The same Worker runs a small server for the features in the [roadmap](ROADMAP.md) (accounts, sync,
friends). It's plain JavaScript with no dependencies, in `server/`:

- **`server/src/index.js`** is the entry point. Cloudflare serves a file from `public/` when one
  matches the address; only when none does, this runs: `/v1/...` goes to the API (`api.js`),
  anything else back to the static files (which answer 404).
- **`server/src/api.js`**: the API lives under **`/v1/`**, not `/api/`, because the app's own
  `localApi.js` answers every `/api/...` request on the device. Responses are JSON; errors are
  `{ error, message }` and never include internals (those go to the Worker's logs, in the
  dashboard under the Worker's **Observability** tab). Routes live in `server/src/routes/` and
  register with `router.js`'s `route()`; a handler can throw an `ApiError` for an expected
  failure. `GET /v1/health` says whether the database answers and which migration it's on, e.g.
  https://watchlogtracker.com/v1/health.
- **CORS:** pages on the site's own address (including previews) can call the API; other origins
  only if listed in `ALLOWED_ORIGINS` (`wrangler.jsonc`), currently the Android app's
  `https://localhost`. CORS isn't authentication: signed-in requests carry a session token.
- The web app's service worker never caches `/v1/` responses.

#### Accounts API

Online accounts (roadmap Phase 3) sign in with an **account key**, not a password
(`server/src/auth.js`):

- **Account key:** 27 random characters of Crockford base32 plus a check character, shown as
  7 groups of 4. Reading it accepts lower case, spaces, dashes and the look-alikes O/0 and I/L/1;
  the check character rejects a mistyped or swapped character before any lookup. The server
  stores only a SHA-256 hash: the key is long and random, so a fast hash is safe and fits the
  free plan's 10 ms CPU limit.
- **Session token:** returned when a device signs in, sent as `Authorization: Bearer <token>`,
  stored hashed. Expires after 180 days unused; use renews it (written at most hourly).
- **Pairing code:** `XXXX-XXXX`, made on a signed-in device, single use, valid 10 minutes.
  Making a new one cancels the previous one.

| Request | Signed in | Does |
|---|---|---|
| `GET /v1/signup` | no | `{ mode, firstAccount }`: what the sign-up screen asks for (below) |
| `POST /v1/email-codes` `{ email }` | no | Sign-up step 1: emails a 6-digit code (an address that already has an account gets a note instead; same answer) |
| `POST /v1/accounts` `{ displayName, deviceName, email, emailCode, inviteCode?, note? }` | no | Creates an account (or a request to join); returns `{ account, session, token, accountKey }` (the only time the key is sent). `account.status` is `active` or `pending`, `account.email` the verified address |
| `POST /v1/sessions` `{ accountKey, deviceName }` | no | Signs a device in with the key |
| `POST /v1/sessions/pair` `{ code, deviceName }` | no | Signs a device in with a pairing code |
| `GET /v1/account` | yes, pending too | `{ account, session, isAdmin, recovery }`; how a waiting device sees it was approved |
| `POST /v1/account/email-code` `{ email }`, `PUT /v1/account/email` `{ email, code }` | yes, pending too | Changes the email: a code to the new address, then the change (the old address is told) |
| `POST /v1/recovery/code` `{ email }` | no | "Lost your key?": a code to the address, if it has an account (same answer either way) |
| `POST /v1/recovery` `{ email, code, deviceName }` | no | Starts a recovery: `{ recoveryToken, completesAt, displayName }`, 24 hours later |
| `POST /v1/recovery/complete` `{ recoveryToken, deviceName }` | no | After the hold: a new key, every other device signed out; returns a sign-in with `accountKey`. `409 recovery_waiting` before, `404 recovery_cancelled` if cancelled or replaced |
| `DELETE /v1/account/recovery` | yes, pending too | A signed-in device cancels a recovery ("Not you?") |
| `PATCH /v1/account` `{ displayName }` | yes | Renames the account |
| `DELETE /v1/account` | yes, pending too | Deletes the account and all its sessions and codes (withdraws a request) |
| `POST /v1/account/key` | yes | Makes a new key (the old one stops working; devices stay signed in) |
| `POST /v1/pairing-codes` | yes | `{ code, expiresAt }` for adding a device |
| `GET /v1/sessions` | yes | The account's devices, `current` marking this one |
| `DELETE /v1/sessions/:id` | yes | Signs one of the account's devices out |
| `DELETE /v1/session` | yes | Signs this device out |
| `GET /v1/tmdb/<TMDB path>` | yes | TMDB, asked with the owner's token (below) |
| `GET /v1/posters` | no | `{ posters }`: poster paths of this week's trending movies, for the sign-in screens' mosaic on laptops. Edge-cached 12 h; on a cache miss it counts in the daily TMDB total and is limited to 30 an hour per address; empty when the TMDB switch is off |
| `POST /v1/sync` | yes | Sends this device's changes and returns everyone else's (below) |
| `GET /v1/push/key`, `PUT`/`DELETE /v1/push/subscription` | yes (key: no) | Web Push for this device: `PUT` takes `{ endpoint, keys, kinds: { requests, episodes, releases, recap }, timeZone, region }` ("Server notifications" below) |
| `/v1/admin/...` | the admin | The admin page's API ("Admin and sign-ups" below) |

Errors a client should expect: `400` (`name_required`, `invalid_key_format`,
`invalid_code_format`, `invalid_json`, `wrong_invite`, `invalid_email`, `wrong_email_code`),
`409 email_taken`, `503` (`email_unavailable`, `email_busy` once the day's emails are used up), `401` (`signed_out`, `wrong_key`,
`wrong_code`), `403` (`account_pending` for a request still waiting, `account_suspended`,
`signup_closed`, `invite_required`), `404`, and `429 too_many_requests` with a `Retry-After`
header. Creating accounts is limited per address (5 an hour) and overall (100 a day), whatever
the sign-up mode; signing in with a key or code
is limited per address (10 per 15 minutes), and making keys and codes per account
(`LIMITS` in `routes/accounts.js`). Rate-limit counters store a hash of the address, never the
address. The weekly job (`cleanup.js`) deletes expired sessions and codes and old counters
before the backup.

#### Friends

Roadmap Phase 7, step 1 (`server/src/routes/friends.js`, migration `0007_friends.sql`). Its route
list is at the top of that file.

- **Friend codes:** `XXXX-XXXX` (8 Crockford characters, `accounts.friend_code`, unique), made the
  first time `GET /v1/friends` is asked; **New code** replaces it. People find each other only
  this way (decided with the user): no search, no usernames.
- **Requests** (`friend_requests`): sending to someone who already asked you makes you friends
  at once. Accept, decline, cancel. Up to 30 requests a day per account and 200 friends.
  **Friendships** are one row with the smaller account id first (`friendships`).
- **Blocking** (`blocks`) ends the friendship and any requests; the blocked account is told
  "Nobody has that friend code" either way.
- **What friends see** (`accounts.share_level`, decided with the user: `everything` by
  default; `lists` = lists and favourites; `nothing`). `GET /v1/friends/:id/library` checks the
  friendship and the level on every request, reads `sync_records` with `json_extract` so D1
  does the work (watched episodes come back as one row per show with a count), and never
  includes preferences.
- **Hearing about requests:** sync replies carry `friends: { incoming }` (banner on every device,
  `sync.js`'s `noteFriendRequests`), and the recipient's devices get a push of kind `friends`
  (`push_subscriptions.notify_friends`, Settings → Notifications → Friend requests, web only).
- **App:** `friends.html` (requests, friends, your code with Copy/Share/New code, Add a friend,
  What your friends see, Blocked) and `friend.html?id=` (numbers, then poster rows: watched
  shows, watched movies, favourites, Watchlist, lists; cards have the usual buttons; Remove
  friend and Block). Reached from Profile's Friends row and Settings → Online account →
  Friends. Offline profiles are offered "Make this an online account".
- **Step 2** (no new setting: it all follows the share level, decided with the user;
  `everything` shares watching, favourites, the Watchlist and lists, `lists` only favourites and
  list additions):
  - `GET /v1/friends/title/:type/:id`: which friends watched (for a show: episodes watched and
    the furthest one, specials left out), favourited or saved a title. One correlated subquery
    per fact on `sync_records`' primary key; a show's episodes by key range
    (`"<show>:"` to `"<show>;"`). Shown on the detail page (`detail.js`'s
    `renderTitleFriends`: "Ana is on S3 · E4", tap for the list).
  - `GET /v1/friends/activity`: the last 30 days (`ACTIVITY_DAYS`), at most 100 items, by the
    records' own times (`watchedAt`/`favoritedAt`/`addedAt`, so an imported history isn't
    news), episodes grouped per friend, show and day. Migration `0008_friend_activity.sql` adds an
    index on `sync_records(account_id, updated_at)` for it. Shown on Home (Friends, the newest
    3) and `activity.html`, both through `friendActivity.js`.
  - **Taste match**, in the library reply (`tasteMatch`): watched titles (movies, and shows with
    any watched episode) in common ÷ √(mine × theirs), as a percentage; null until both have 3
    (`TASTE_MIN_TITLES`); plus up to 20 titles in common. On `friend.html`.
  - Sync replies' `friends` also carry `count`, kept as `account.friendCount`; pages ask about
    friends only when `serverApi.js`'s `canAskAboutFriends` says so (signed in, not pending, and
    a count that isn't 0).

#### Email and account recovery

Every online account has a **verified email** (roadmap Phase 3c), used only to get back in
without the key and for notices about the account. `server/src/email.js` sends through
**Resend** (decided with the user: Cloudflare's own sending is free only to addresses verified in
the Cloudflare account): plain-text emails, 6-digit codes (hashed in `email_codes`, 15 minutes,
5 tries), at most 90 a day (`EMAIL_LIMITS`, under Resend's free 100). The address is stored with
a hash for looking it up (`accounts.email_hash`, unique).

- **Sign-up:** the picker asks for the email with the name, `POST /v1/email-codes` sends a code,
  and `POST /v1/accounts` needs it.
- **Recovery** (`routes/recovery.js`): "Lost your key?" sends a code; entering it starts a
  **24-hour hold** (`recoveries` table, decided with the user). Meanwhile the address gets an
  email, the account's devices get a push and a "Someone is recovering your account · Not you?
  Cancel" banner (each sync reply and `GET /v1/account` carry `recovery`), and Settings shows a
  Cancel row. After it, the device that asked (it keeps the token in localStorage
  `watchlog_recoveries`; the picker lists it) gets a new key, and every other session and
  pairing code is deleted.
- **The owner's alert:** each request to join is emailed to the admins' own account emails, with
  the person's name, email and note and a link to the admin page (on top of the push).
- Migration `0006_recovery_email.sql` **deleted every account made before it**, the owner's
  included (decided with the user: they were all tests).

**Setup (once):**

1. Make a free account at resend.com. **Domains → Add domain**: `watchlogtracker.com`. Resend
   lists DNS records (DKIM, SPF, MX for bounces); add them in Cloudflare (domain → DNS), or use
   Resend's Cloudflare button. Wait until Resend shows the domain as verified.
2. **API Keys → Create**: permission **Sending access**, domain `watchlogtracker.com`.
3. In Cloudflare: Workers & Pages → watchlog → Settings → Variables and Secrets, **Production**
   tab, type **Secret**: `RESEND_API_KEY` = that key. Optionally a `EMAIL_FROM` var (default
   `Watchlog <no-reply@watchlogtracker.com>`). Previews have no key, so sign-up there answers
   "Emails can't be sent right now" unless the key is added on the Previews tab too.
4. Make your own account on the live site (the first account gets in whatever the sign-up mode),
   then put its id in `ADMIN_ACCOUNT_IDS` again: the old one was deleted.

Locally, `EMAIL_DEV_LOG=on` in `.dev.vars` logs every email (codes included) instead of sending.

#### Admin and sign-ups

The owner's **admin page** (`public/admin.html`, `admin.js`; roadmap Phase 8 part 1) runs on the
`/v1/admin/...` API (`server/src/routes/admin.js`). Its own route list is at the top of that file.

- **Who's the admin:** accounts whose id is in the `ADMIN_ACCOUNT_IDS` Worker secret
  (comma-separated). There's no admin password: being signed in to that account on a device is
  what opens the page there. The page shows a signed-in account its id if it isn't the admin,
  for copying into the secret. If the owner's account started out waiting for approval, opening
  the admin page activates it.
- **Cloudflare Access** guards the page and its API as a second lock (set up in the dashboard,
  nothing in the code): Zero Trust (free plan, team `watchlog`) → Access → Applications →
  **Watchlog admin**, a self-hosted application on `watchlogtracker.com` with paths `admin*`
  and `v1/admin*`, session 24 hours, policy **Owner only** (Allow, Include → Emails → the owner's
  address), login method One-time PIN (an emailed code). So opening the admin page asks for that
  code first; the API checks the admin account as before. Side effects: the admin page doesn't
  work inside the Android app (its requests come from `https://localhost` and can't carry the
  Access cookie), so use a browser; the join banner, push and email still reach every device.
  Another admin needs their email added to the policy as well as their id to `ADMIN_ACCOUNT_IDS`.
  Anything else (the app, `/v1/push/...`, sync) is outside Access. The service worker copes:
  a page Access blocks isn't cached.
- **Sign-up modes** (`server/src/settings.js`, changed on the admin page): `closed`,
  `invite` (an invite code is required), `approval` (the default: anyone can ask, and waits as
  `pending` until approved; an invite code skips the wait) and `open`. While there's no account
  at all, the first sign-up gets in whatever the mode, so the owner can make theirs.
- **Pending accounts** have a key and a session, but every route except `GET`/`DELETE
  /v1/account` and `DELETE /v1/session` answers `403 account_pending`. The app shows them a
  "Waiting for approval" screen. Declining deletes the account.
- **Invites:** `XXXX-XXXX` codes (stored hashed), single use, 1 to 30 days, with a note only the
  owner sees.
- **Users:** approve, decline, sign out every device, suspend (signed out everywhere, can't sign
  in), unsuspend, delete. Admin accounts can't be changed from the page. The page shows counts,
  never anyone's library.
- **TMDB proxy:** an on/off switch and the daily cap (settings `tmdb_proxy`, `tmdb_daily_cap`),
  on top of the `TMDB_PROXY` var.
- **Audit log:** every admin action, shown under Activity.
- **Part 2: locked-out people** (an account's Manage dialog). **Email them a new key**
  (`POST /v1/admin/users/:id/new-key`): a new account key goes to the account's own verified
  email (decided with the user: the owner never sees it; the reply only says where it went,
  `r•••@example.com`). The email is sent first, so a failed send changes nothing; then the old
  key stops working, every device is signed out, and any recovery is cancelled. Up to 5 a day per
  account. **Cancel their recovery** (`DELETE /v1/admin/users/:id/recovery`, offered while the
  users list shows `recoveryUntil`): the person gets an email saying the owner cancelled it.
- **Part 2: burst limits** (`auth.js`'s `BURST_LIMITS`), per minute on top of each route's own
  hourly/daily limits: 20 requests per address shared by every route anyone can call without
  signing in (`POST /v1/email-codes`, `/accounts`, `/sessions`, `/sessions/pair`, `/recovery/code`,
  `/recovery`, `/recovery/complete`; `burstLimit`), 10 new accounts and 20 emails a minute in
  all, and 5 friend requests a minute per account.
- **Part 2: Turnstile** (`server/src/turnstile.js`): Cloudflare's bot check before the server
  emails a code (`POST /v1/email-codes` and `/v1/recovery/code` take `turnstileToken`;
  `bot_check_needed` 400, `bot_check_failed` 403, `bot_check_unavailable` 503). Creating the
  account needs that emailed code, so it isn't checked again. On only when both
  `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set (`GET /v1/turnstile` → `{ siteKey }`, null
  when off), so tests, `wrangler dev` and previews without them skip it. The widget runs on
  `public/turnstile.html` (`scripts/turnstile-frame.js`), which the sign-in screens frame from the
  server (`serverApi.js`'s `passBotCheck`, only when a code is about to be sent): Turnstile needs a
  real domain name, and the Android app's pages come from `https://localhost`. The frame posts the
  token only to its own origin and `https://localhost`; the screen checks the message's origin and
  source. The Android app allows third-party cookies in its WebView for it (`MainActivity`, as
  Cloudflare asks). Locally, Cloudflare's test keys (site `1x00000000000000000000AA`, secret
  `1x0000000000000000000000000000000AA`; `2x00000000000000000000AB` always fails) work in
  `.dev.vars`.
- **The owner hears about requests:** each sync reply for the admin carries
  `admin: { pendingRequests }`, which the app shows as a "N people want to join" banner on any
  device. On top of that a Web Push notification goes to every device where the owner switched
  notifications on (the admin page's "Notify me on this device"; iPhone needs the app added to
  the Home Screen, iOS 16.4+; the Android app can't get Web Push).
- **Web Push** (`server/src/push.js`, `webpush.js`, roadmap Phase 6's foundation): VAPID
  (RFC 8292) and aes128gcm encryption (RFC 8291) with Web Crypto only; `push_subscriptions`
  rows belong to a session, so signing out removes them, and subscriptions push services report
  gone (404/410) are deleted. The service worker shows the notification and opens its `url`.

**Setup (once, Cloudflare dashboard → Workers & Pages → watchlog → Settings → Variables and
Secrets, Production tab, type Secret):**

1. Create your own online account on the live site first (the first account gets in without
   approval). Open `/admin.html`: it shows your account id. Add it as `ADMIN_ACCOUNT_IDS`.
2. For the bot check: Cloudflare dashboard → Turnstile → Add widget: name "Watchlog", hostname
   `watchlogtracker.com`, mode Managed. Add its site key as `TURNSTILE_SITE_KEY` and its secret
   key as `TURNSTILE_SECRET_KEY` (both as secrets, Production tab only, so deploys keep them and
   previews skip the check). Without both, nothing is checked.
3. For push notifications: run `node tools/make-vapid-keys.mjs` and add the two keys it prints
   as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Keep them in a password manager: new keys
   break every existing subscription. Optionally `VAPID_SUBJECT` (an `https://` or `mailto:`
   contact address for push services; the repository's address by default).

To try it on this machine: `npx wrangler d1 migrations apply DB --local`, put
`ADMIN_ACCOUNT_IDS=...` (and VAPID keys) in a `.dev.vars` file (gitignored), and start the
`watchlog-worker` launch configuration.

#### Server notifications

The web app's notifications (roadmap Phase 6) are sent by the server: `server/src/notifications.js`,
run by an hourly Cron Trigger (`0 * * * *` in `wrangler.jsonc`, next to the Sunday backup).
The Android app keeps its own local notifications and never subscribes, so nothing arrives twice.

- **Who gets what:** each device's push subscription says which kinds it wants (Settings →
  Notifications in the web app; the admin page's switch is the sign-up requests kind), its
  time zone and the profile's region. The switches are per device, as in the Android app.
- **New episodes:** shows with any watched episode on the account, whose next episode airs
  today in the device's time zone, from 18:00. **Release reminders:** Watchlist movies released
  today in the device's region (cinemas first, else streaming), from 18:00. **Weekly recap:**
  Sundays from 19:00: the week's watched episodes and movies with their watch time, and how many
  tracked shows have an episode in the next 7 days.
- **Limits per run** (the free plan: 50 outside requests, 10 ms CPU): at most 15 titles are
  refreshed from TMDB (`tmdb_titles`, oldest first, with the owner's `TMDB_TOKEN`, counted in
  the TMDB daily cap and paused by the admin page's TMDB switch) and at most 30 notifications
  sent; anything left goes out an hour later. `push_log` stops repeats.
- **Setup:** nothing new beyond the VAPID keys (above) and `TMDB_TOKEN`.
- **Try it locally:** with VAPID keys in `.dev.vars`, the `watchlog-worker` launch configuration
  (it passes `--test-scheduled`), then open `http://localhost:8787/__scheduled?cron=0+*+*+*+*`;
  the result is logged as `Notifications {...}`.

#### Sync API

`POST /v1/sync` (`server/src/routes/sync.js`, signed in) both sends a device's changes and returns
everything changed since that device last asked:

```
request:  { since: <cursor, 0 the first time>, changes: [{ kind, key, data, deleted, updatedAt }] }
response: { cursor, changes: [...same shape...], more, accepted, serverTime }
```

- Every record of every account is one row of `sync_records` (migration `0003_sync.sql`), keyed by
  account, `kind` (`watched_movie`, `watched_episode`, `favorite`, `list`, `list_item`, `prefs`) and
  `key`. A deletion stays as a tombstone (`deleted: true`, `data: null`) so devices that were offline
  still hear about it.
- **Newest wins** per record: a change is stored only if its `updatedAt` is later than the stored
  one. `updatedAt` comes from the device's clock, capped at the server's clock plus 5 minutes, so
  a device whose clock runs ahead can't win every argument.
- **Order:** each stored change gets the account's next `seq` (`accounts.sync_seq`, reserved
  atomically per request). A device keeps the highest `seq` it has seen as its cursor and asks for
  everything after it. Its own changes come back too; applying them again changes nothing.
- **Pieces:** at most 200 changes per request (128 KB) and 500 per reply; `more: true` means ask
  again with the new cursor. That keeps each request well inside the 10 ms CPU limit.
- Limited to 600 requests per account per hour. Deleting an account deletes its records.

#### The TMDB proxy

Online accounts don't need a TMDB token of their own: the app sends their TMDB requests to
`GET /v1/tmdb/<path>?<query>` (`server/src/routes/tmdb.js`), and the Worker asks TMDB with the
owner's token. Offline profiles still call TMDB directly with their own token.

- The token is the Worker secret **`TMDB_TOKEN`** (TMDB's long API Read Access Token). It's never
  in the repository or the app. Set it in the dashboard: the Worker → **Settings → Variables and
  secrets**, on the **Production** tab and the **Previews Base** tab (type *Secret*). Previews
  copy Previews Base when they're created, so a preview that already exists needs it on its own
  Settings page. Or: `npx wrangler secret put TMDB_TOKEN` and
  `npx wrangler preview base-config secret put TMDB_TOKEN`. Without it the proxy answers
  `503 tmdb_unavailable`.
- Signed-in accounts only, `GET` only, and only read-only TMDB paths (`authentication`,
  `account`, `list`, `session`, `guest_session` are refused).
- Limits per day (`TMDB_LIMITS`): 5,000 requests per account and 40,000 overall. The overall cap
  also keeps TMDB traffic from using up the Worker's free 100,000 requests a day. They're D1
  counters: two small writes per request.
- `TMDB_PROXY` (a `wrangler.jsonc` var, `"on"`) set to `"off"` pauses it (`503 tmdb_paused`).
- Answers go into Cloudflare's edge cache for a while (a day for configuration and genres, 6 hours
  for a title's details, 10 minutes for searches, 30 minutes otherwise). Cloudflare's docs don't
  promise the Cache API on `workers.dev`, but it works there (checked: a repeated request comes
  back with `X-Watchlog-Cache: hit`). The cache is per data centre.
- Sign-up is open for now, so anyone who finds the API could make an account and use the proxy
  within those limits. Decided with the user: switch to invite-only before online accounts are
  shown to everyone.

#### Accounts in the app

`public/scripts/serverApi.js` makes the app's requests to the API above, and the profile picker
and Settings use it: create an account, save the key, sign in with the key or a code from another
device, add a device, see and sign out devices, sign out, delete the account. An online profile
is an ordinary profile with an `account` on it; its library is in its own IndexedDB like any profile's,
and `sync.js` keeps it the same on every signed-in device (below). Online profiles get movie and show information through the TMDB proxy
above, so creating an account, or signing in on a new device, asks for no token. Signing out (or
deleting the account) asks whether to keep a copy on the device, which then needs its own TMDB
token to work offline, or remove it. A kept copy is a separate offline profile from then on:
signing in again makes a new profile that starts from what's on the account, and nothing done in
the copy reaches it.

Online accounts are shown to everyone; who can make one is the admin page's sign-up mode (above).
The create screen asks for what that mode needs (an invite code, or a note for the owner), and a
request waits on a "Waiting for approval" screen (`profile-picker.html?screen=waiting`) that
every page sends a waiting profile to (`auth.js`). The web app calls the
server on its own address; the Android app calls production; setting
`localStorage.watchlog_server_url` points either at another server (it must allow the page's
origin, see CORS above).

#### Sync in the app

`public/scripts/sync.js` (loaded after `serverApi.js` on every page with `localApi.js`) uses the
Sync API above. Only profiles with an account sync; offline profiles record nothing.

- **Recording:** every `localApi.js` route that writes calls `recordSyncChanges(db, records)`,
  which puts the change in the profile's `sync_outbox` store (database v5), one row per record
  (`<kind>|<key>`), so a record changed twice is sent once. Settings records the synced
  preferences (theme, accent, region, language) with `recordPrefsChange`.
- **Lists** have a `syncId` (v5 gives existing lists one; the Watchlist is `watchlist` on every
  device). Pages keep using the local list numbers; list items travel as
  `<list sync id>:<movie|tv>:<id>`.
- **Syncing** (`syncNow`): sends up to 200 waiting changes (and at most 100 KB), applies what
  comes back, removes what was sent from the outbox, and repeats until both sides are through.
  An incoming change is skipped when this device has a newer one waiting (newest wins, as on the
  server). The cursor, the last sync time and the last error are in the `sync_state` store.
- **First sync** of a profile on an account (after "Make this an online account", or signing in
  on a new device, where the library starts empty): the whole library is queued, each record with
  its own time (when it was watched, added, favourited), so newer changes on the account still win.
  Preferences go with the oldest possible time, so an account that has some keeps them.
- **Clock:** changes are stamped with the server's time, not the device's. Each reply carries
  `serverTime`, and the device keeps the difference from its own clock (`sync_state`), so a phone
  whose clock is behind still has its latest change win.
- **Same-named lists** from two devices: the newer one (by `createdAt`, then sync id) is renamed
  "Name (2)" and the rename synced, so every device ends up with the same names.
- **Reset all data** on an online profile records a deletion for every record; Settings syncs
  before (to know everything the account has) and after.
- **When:** shortly after each page load (skipped if a sync finished in the last 10 seconds and
  nothing is waiting), 2 seconds after a change, when the connection comes back, when the app
  comes back to the screen, and Settings' "Sync now" (the Sync row shows the status). One sync at
  a time per page, and per profile across tabs (`navigator.locks`). When changes arrive after the
  page was drawn, the page reloads itself if the person hasn't touched it yet (at most once every
  15 seconds); otherwise a notice offers to refresh, so nothing moves under their finger.
- **Backups:** online profiles don't auto-back up on Android any more; the account has their
  library. Offline profiles keep the weekly file. Export data works for both.

To try two devices in one browser: two profiles signed in to the same account are two devices,
each with its own database. `npx wrangler d1 migrations apply DB --local` and the
`watchlog-worker` launch configuration (`wrangler dev --local`) run the whole thing on this
machine, with a local database (TMDB requests fail there: no token).

#### Server database

A [D1](https://developers.cloudflare.com/d1/) database (SQLite), bound as `DB`. Production uses
`watchlog`; previews use `watchlog-preview`, so trying a pull request never touches real data.
Both are named in `wrangler.jsonc`, and the preview one also in `wrangler.preview-db.jsonc`
(used to apply migrations to it); `tests/server-config.test.js` checks they match.

- **Changing the database structure:** add a numbered file to `server/migrations/`
  (`0002_accounts.sql`, ...). Every deploy applies the new ones before the code goes live, and D1
  records what's applied in its `d1_migrations` table. Never edit a migration that has already
  been applied: add another one.
- **Backups:** D1's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) can
  restore the database to any minute of the last 7 days. On top of that, every Sunday at 03:00 UTC
  the Worker's Cron Trigger copies the whole database to the R2 bucket `BACKUPS`
  (`server/src/backup.js`), keeping the newest 5. The new copy is written before old ones are
  deleted. Crons don't run in previews.
  - **How:** the Worker asks D1 to export the database (the same export `wrangler d1 export`
    uses), waits for it, and streams the finished file into R2 as `d1/watchlog-<time>.sql`.
    Cloudflare builds the file, so the run uses almost none of the free plan's 10 ms of CPU per
    Cron run, however big the database gets. While it exports, D1 holds other requests (seconds
    at this size): the app saves everything on the device first and syncs it afterwards, so
    nothing is lost.
  - **Setup (once):** in the Cloudflare dashboard, My Profile → API Tokens → Create Token →
    Custom token, with the permission **Account · D1 · Edit**, for your account only. Add it to
    the `watchlog` Worker as a secret named `BACKUP_API_TOKEN` (Settings → Variables and
    Secrets, **Production** only; previews don't back up). `BACKUP_DATABASE_ID` is already in
    `wrangler.jsonc` (a test keeps it equal to the production database). If the token can see more
    than one account, also add a `BACKUP_ACCOUNT_ID` variable (the id in the dashboard's address).
  - **Without the token** it still backs up, the old way: the Worker builds a JSON copy itself
    (`d1/watchlog-<time>.json`), which a big database will make it run out of CPU on. The log
    then says so.
- **Restoring a weekly copy:** download it from the R2 bucket in the dashboard. A `.sql` copy
  loads as it is: `npx wrangler d1 execute watchlog --remote --file <file>.sql`. A `.json` copy
  (made without the token) first needs `node tools/backup-to-sql.js <file>.json > restore.sql`.
  Either goes into an empty database (a new one, or after dropping the tables). For anything within the last week, Time Travel is simpler:
  `npx wrangler d1 time-travel restore watchlog --timestamp <time>`.

#### Server tests

`npm run test:server` runs `server/test/`. The database there is real SQLite (`node:sqlite`,
which needs **Node 22.5+**, so these tests are separate from `npm test`) with the migrations
applied the way Wrangler does; R2 and the static files are small in-memory stand-ins. CI runs
both suites in the one `test` check.

### Testing on iPhone without a Mac

Safari's developer tools on an iPhone need a Mac. Instead: Playwright's WebKit browser (the same
engine as Safari) runs on Windows, and most layout and storage problems show up there; anything
else, try on the phone with a branch's preview deploy.

## Tests

```bash
npm test
```

This runs the Node test suite in `tests/` with Node's built-in test runner. `tests/harness.js`
loads the app's real data-layer scripts into a sandbox that stands in for one page: an in-memory
IndexedDB (`fake-indexeddb`), `localStorage`, a fake TMDB server, and fakes of the Capacitor
plugins. The tests then call the same `/api/...` routes the pages use. They cover watch
tracking, show statuses, the schedule, stats, recommendations, caching and retries, backups and
auto-backups, notification scheduling and the background-check sync, TMDB key validation, online
accounts and sync (`tests/sync.test.js`: two devices against an in-memory stand-in for the
server), and the web app's offline file list, manifest and backup reminder.
Page and UI code isn't covered by tests; check it in a browser.

GitHub Actions (`.github/workflows/tests.yml`) runs the same `npm test` on Node 18 for every pull
request and every push to `main`.

## Working on the repository

- **`main` is always releasable.** Android releases are built from it, and once the web version is
  hosted (see [ROADMAP.md](ROADMAP.md)), every push to `main` deploys the website. Make changes on a
  short-lived branch and merge them with a pull request, after the tests pass.
- **Never force-push or rebase `main`.** `versionCode` is the commit count, so rewriting history
  can lower it, and Android then refuses to install the next APK as an update. Squash-merging pull
  requests is fine: each one adds a commit, so the count still only goes up.
- **Large features land in small pieces**, each leaving the app working. Hide an unfinished
  feature behind a switch rather than keeping a branch open for weeks.
- **Secrets never go in the repository.** The release signing file lives outside it (see
  [Signing](#signing)); the planned Cloudflare Worker's local secrets go in `.dev.vars`, which is
  ignored.
- What's planned next, and the decisions behind it, is in [ROADMAP.md](ROADMAP.md).

## Publishing a release

The README's download link points at
`https://github.com/EasyBuster200/Watchlog-Movie-and-Show-tracker/releases/latest/download/Watchlog.apk`,
so every release must attach the APK under exactly the name **`Watchlog.apk`**.

1. Commit and push everything (the version number comes from the commit count).
2. Build the signed release APK (see [Build](#build)), and note its version. `versionName` is
   `2.<commit count>`.
3. Copy it to `Watchlog.apk` and create the release, tagged with that version:

   ```bash
   cp android/app/build/outputs/apk/release/app-release.apk Watchlog.apk
   gh release create v2.<N> Watchlog.apk --title "Watchlog 2.<N>" --notes "What changed..."
   ```

Users then download the new APK and install it over the old one; their data is kept.

## Project structure

```
public/            the whole app: loaded into Capacitor's WebView, and published as the web app
  *.html           one page per screen (main, movies, shows, detail, episodes, person,
                   airing-soon, stats, lists, bookmarks (the Watchlist), media-list (every
                   "See all"), search, profile, settings, licences, profile-picker)
  scripts/         localApi.js (the fetch shim / local "server"), localDb.js (IndexedDB),
                   profiles.js, standardItem.js (shared item shape), media.js (shared UI
                   components), browse.js (Movies/Shows filter & sort), theme.js (theme and
                   accent, applied before paint), backup.js,
                   autoBackup.js, notifications.js, pwa.js (web app setup), one script per
                   page, vendor/ (Capacitor core and plugins as plain scripts)
  sw.js            the web app's service worker (offline)
  manifest.webmanifest, images/   the web app's name and icons
  styles/          tokens.css (design tokens), style.css (components and screens)
android/           Capacitor's native Android project. Hand-written parts: MainActivity.java,
                   WatchlogBackgroundPlugin.java, EpisodeCheckWorker.java, app/build.gradle
                   (versioning and signing), the launcher and notification icons
tests/             Node test suite (npm test)
server/            the Worker's server code: src/ (index.js, api.js, backup.js), migrations/
                   (database changes), test/ (npm run test:server)
tools/             write-web-version.js (version.json for the web deploy), backup-to-sql.js
                   (restores a weekly database copy)
docs/              this guide, design/ (the design system's tokens.json and reference
                   component CSS), screenshots/, icons/ (Material Symbols reference SVGs and
                   the app icon artwork)
CLAUDE.md          detailed architecture reference
```

## History

This repository was split off from
[Movie-and-Show-tracker-Website](https://github.com/EasyBuster200/Movie-and-Show-tracker-Website),
a server-backed multi-user website (Express + SQLite), at the commit that rebuilt it as this
local-first Android app. The earlier server version is still in this repository's git history.
The app was called "TVTimeClone" before being renamed to Watchlog; some internal identifiers
(the Android application id `com.tvtimeclone.app`, the backup format id) keep the old name on
purpose, because changing them would break updates and old backups.
