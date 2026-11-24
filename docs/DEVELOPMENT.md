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
  same numbering as the APK) during the deploy, and Settings shows it. It's not committed;
  without it Settings says "web preview".
- **Notifications** aren't available on the web yet (see the roadmap).

### Hosting on Cloudflare

The site is hosted for free as a [Cloudflare Worker](https://developers.cloudflare.com/workers/static-assets/)
that only serves static files, deployed from GitHub. `wrangler.jsonc` (repository root) names the
Worker `watchlog` and points it at `public/`. The accounts and sync API planned in the roadmap
will be added to this same Worker.

One-time setup in the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**,
pick this repository, then:

| Setting | Value |
|---|---|
| Project name | `watchlog` (must match `name` in `wrangler.jsonc`) |
| Build command | `node tools/write-web-version.js` |
| Deploy command | `npx wrangler deploy` |
| Preview builds | On |

Every push to `main` then deploys the site at `https://watchlog.<your-subdomain>.workers.dev`,
and every other branch gets its own preview address (shown on its pull request), which can be
opened on a phone to try a change before merging. Wrangler isn't a dependency of this
repository: Cloudflare's build runs it with `npx` (it needs a newer Node than the Node 18 the
project supports).

Cloudflare serves `page.html` at `/page` and redirects to it. The service worker caches pages
without the `.html`, so both addresses work offline.

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
tools/             write-web-version.js (version.json for the web deploy)
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
