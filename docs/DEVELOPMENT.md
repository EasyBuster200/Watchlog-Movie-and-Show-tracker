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
- **Notifications** aren't available on the web yet (see the roadmap).

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

Every push to `main` then deploys the site, live at **https://watchlog.duartecruzcoelho.workers.dev**,
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
  https://watchlog.duartecruzcoelho.workers.dev/v1/health.
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
| `POST /v1/accounts` `{ displayName, deviceName }` | no | Creates an account; returns `{ account, session, token, accountKey }` (the only time the key is sent) |
| `POST /v1/sessions` `{ accountKey, deviceName }` | no | Signs a device in with the key |
| `POST /v1/sessions/pair` `{ code, deviceName }` | no | Signs a device in with a pairing code |
| `GET /v1/account` | yes | `{ account, session }` |
| `PATCH /v1/account` `{ displayName }` | yes | Renames the account |
| `DELETE /v1/account` | yes | Deletes the account and all its sessions and codes |
| `POST /v1/account/key` | yes | Makes a new key (the old one stops working; devices stay signed in) |
| `POST /v1/pairing-codes` | yes | `{ code, expiresAt }` for adding a device |
| `GET /v1/sessions` | yes | The account's devices, `current` marking this one |
| `DELETE /v1/sessions/:id` | yes | Signs one of the account's devices out |
| `DELETE /v1/session` | yes | Signs this device out |
| `GET /v1/tmdb/<TMDB path>` | yes | TMDB, asked with the owner's token (below) |
| `POST /v1/sync` | yes | Sends this device's changes and returns everyone else's (below) |

Errors a client should expect: `400` (`name_required`, `invalid_key_format`,
`invalid_code_format`, `invalid_json`), `401` (`signed_out`, `wrong_key`, `wrong_code`), `404`,
and `429 too_many_requests` with a `Retry-After` header. Sign-up is open for now, so creating
accounts is limited per address (5 an hour) and overall (100 a day); signing in with a key or code
is limited per address (10 per 15 minutes), and making keys and codes per account
(`LIMITS` in `routes/accounts.js`). Rate-limit counters store a hash of the address, never the
address. The weekly job (`cleanup.js`) deletes expired sessions and codes and old counters
before the backup.

#### Sync API

`POST /v1/sync` (`server/src/routes/sync.js`, signed in) both sends a device's changes and returns
everything changed since that device last asked:

```
request:  { since: <cursor, 0 the first time>, changes: [{ kind, key, data, deleted, updatedAt }] }
response: { cursor, changes: [...same shape...], more, accepted }
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
is an ordinary profile with an `account` on it; its library stays on the device until syncing
exists (roadmap Phase 4). Online profiles get movie and show information through the TMDB proxy
above, so creating an account, or signing in on a new device, asks for no token. Signing out (or
deleting the account) asks whether to keep a copy on the device, which then needs its own TMDB
token to work offline, or remove it; a kept copy remembers its account, so signing in again
reattaches it with its library.

**It's all hidden** until then. To try it, open the browser console on the app (a pull request's
preview, so the preview database is used) and run
`localStorage.setItem('watchlog_preview_online_accounts', '1')`, then reload. The web app calls the
server on its own address; the Android app calls production; setting
`localStorage.watchlog_server_url` points either at another server (it must allow the page's
origin, see CORS above).

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
auto-backups, notification scheduling and the background-check sync, TMDB key validation, and
the web app's offline file list, manifest and backup reminder.
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
