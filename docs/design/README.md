# TV Tracker

The design system for TV Tracker, a mobile app for following movies and TV shows: what's trending, what you've watched, what's next, and how much time you've spent watching. It's built from screenshots of the current app (home, show detail, episodes and stats screens) and keeps that look: a near-black, poster-first interface with one burgundy accent, rgb(102, 0, 51).

## Content fundamentals

- **Voice:** short, plain and a little warm. Say what happened or what's next: "4/9 watched", "Next: Chapter Five", "Up to date".
- **Case:** Title Case for section headers ("Trending Shows", "Top Genres"); sentence case for everything else.
- **Numbers do the talking.** Counts read as `watched/total` ("29/42 episodes watched"), dates as `27 May 2022`, runtimes as `79m`, total time as `5D 14h`, ratings as `8.0/10`. Separate meta items with ` • `.
- **No emoji.** Icons carry meaning; words carry the rest.

## Visual foundations

- **Dark first.** Screens sit on `bg-page`. Grouped content sits on `bg-card` with a 1px `border-subtle` outline; `bg-surface` is for the bottom navigation bar only. Depth comes from these three steps, not from shadows (only posters get `shadow-poster`).
- **One accent.** Burgundy marks what's active or done. Solid fills (primary buttons, selected chips) use `accent`, the exact brand burgundy with white text. Thin marks drawn straight on the dark page (the active nav icon, progress bars, chart bars) use `accent-mark`, a brighter raspberry from the same family, because `#660033` alone reads faintly on near-black; in the light theme `accent-mark` is the brand burgundy itself. Toggles on artwork (watched, bookmark, favourite) never fill their circle: they keep the `scrim` backing and fill the icon in `accent-text`, the same for watched, bookmark and favourite. When the accent is text (stat values, "Show more", links) use `accent-text`, which is readable at small sizes. Never introduce a second brand hue; `rating` (gold) is only for stars.
- **Poster-first.** Artwork is the colour in the app. Posters are 2:3, `radius-md`, edge to edge with no frame. Icons over artwork sit on a round `scrim` backing so they read on any image.
- **Type:** Poppins throughout (Google Fonts, weights 400/500/600). One `screen-title` per screen, `section-title` for each section, `card-title` + `meta` inside cards.
- **Layout:** 16px (`space-4`) side padding, 24px (`space-6`) between sections, 8px (`space-2`) between rows and tiles, 12px (`space-3`) inside cards. Carousels scroll horizontally and bleed off the right edge.
- **Corners:** `radius-md` (10px) on almost everything, `radius-lg` on episode cards, `radius-pill` for round icon buttons and bars.
- **Motion:** 150ms ease-out on hover/press colour changes; nothing bounces.

## Themes and accent palettes

Two themes, **Dark** (the default) and **Light**, set with `data-theme="dark"` / `data-theme="light"` on the root. Light swaps the neutrals (page, cards, borders, text, scrim), deepens the status colours and the rating gold, and uses each palette's deeper `-text` tone so it stays readable on white.

Seven accent palettes are available, each with six tokens and a value per theme: `burgundy` (active), `indigo`, `ocean`, `teal`, `coral`, `magenta`, `amber`.

| Token | Role |
| --- | --- |
| `<palette>` | Fills: primary buttons, selected chips, active nav, chart bars |
| `<palette>-hover` | Hover state of fills |
| `<palette>-text` | Accent as text or filled icon: links, stat values, card toggles |
| `<palette>-subtle` | Tinted grounds: selected rows, icon tiles |
| `<palette>-on` | Text and icons on the fill (white, or dark for teal/coral/amber on dark and amber on light) |
| `<palette>-mark` | Thin marks drawn straight on the page: active nav icon, progress, chart bars. Same as the fill except burgundy on dark (`#de4a6f`) |

Components never use a palette directly: they read `accent`, `accent-hover`, `accent-text`, `accent-subtle`, `on-accent` and `accent-mark`, which point at the active palette (burgundy). To switch the whole app to another accent, repoint those six tokens (e.g. `accent` → `{teal}`, `accent-mark` → `{teal-mark}`). Avoid `amber` if star ratings matter on a screen: it sits close to `rating`.

## Browser layout

On laptops and desktops the app is a normal website, not a stretched phone screen:

- **Header and footer.** `TopNav` across the top (wordmark, text links with an `accent-mark` underline on the current page, a 300px search with a "/" hint, the avatar for Profile) and `SiteFooter` at the bottom (link columns and the TMDB credit). `BottomNav` and the back button aren't used in the browser; breadcrumbs replace the back button. `SideNav` stays in the system as an alternative.
- **Content width.** Content sits in a centred 1280px column with 40px side padding, the same as the header and footer.
- **Heroes.** Home and detail pages open with a full-width backdrop hero (image faded into `bg-page` from the left and bottom) holding the title, meta line, overview, progress and actions.
- **Grids.** Poster rows are 7 columns at 1280px (164px posters, 20px gaps), with "See all" and prev/next arrows on the right of the section title. Continue Watching uses `LandscapeCard`s, 4 across. Airing Soon becomes a 7-day week strip.
- **Detail pages.** A main column plus a 320px sidebar (next episode, details). Episodes are an `EpisodeRow` list under season tabs, and the cast is a full-width row.
- **Browse pages.** A 240px filter sidebar (genre checklist with counts, release year, hide watched) next to a 6-column grid, a sort dropdown in the page header, collection tabs, and numbered pagination.

## Settings and admin pages

Settings-style pages are labelled sections (`tt-filter-label` on the phone, an 18px heading in the browser), each a `bg-card` with `SettingsRow`s: a chevron for navigation (with the current value, e.g. "English"), a `Switch` for on/off, a small pill button for an action ("Sync now", "Change", "Export"), and `kind="danger"` for destructive rows (Delete, Reset), which always confirm first. A `tt-badge` count sits before the control when something is waiting ("2 waiting to join"). The theme is a `SegmentedControl`; accent colours are 36–40px swatches with a `text-primary` ring on the chosen one. In the browser, Settings adds a sticky list of the sections on the left and keeps the content at most 800px wide.

The admin page leads with a strip of numbers (one `bg-card` split by hairlines; TMDB use against the daily cap gets a `ProgressBar`). Join requests are rows with Decline (secondary) and Approve (primary). Accounts and activity are grid "tables" (header row in uppercase `text-muted`, hairlines between rows) with `StatusPill`s: success = Active, warning = Recovering, danger = Suspended. Manage opens that account's actions in a row underneath, with Delete account last and red. The sign-up mode is a radio group of `OptionCard`s, each with the description of what it does. On the phone it's all one column of sections; in the browser the requests, accounts and activity take the main column and sign-up mode, invites, TMDB and this device sit in a 360px sidebar.

## Filters

Filtering and sorting never take a row of their own. Every browsable list starts with `BrowseHeader`: a title and a one-line summary of what is applied, with a sort icon (opens a small menu) and a filter icon (opens a sheet with segmented choices and a genre checklist; a `accent-mark` dot marks active filters). In the app the sheet slides up from the bottom; on design frames taller than a phone use `placement="anchored"` so it drops below the header. `Chip` stays for in-place choices that are not filters (Settings theme).

## Sign-in and forms

The app opens on **Who's watching?**: a card list of profiles (avatar, name, and a meta line with a `cloud` icon for synced accounts or a `lock` icon for offline ones, plus Edit and a `danger` Delete), then Sign in (primary) and two secondary buttons side by side: Offline profile and Import backup. Online accounts use **account keys**, not passwords: sign-up asks only for a name and an email, then shows the generated key (monospace, with Copy and Save as file) before continuing. Sign in is one password-type `TextField` for the key. The email is used only for recovery: "Lost your key?" sends a recovery link. An offline profile needs only a display name and a TMDB API Read Access Token (a password-type `TextField` with show/hide); it stays on the device and never syncs. Import backup takes the .json from Settings → Export data or Auto-backup, shows what's in it, then restores it as an offline profile or into a signed-in account.

Auth screens are a single centred column, max 400px: the Watchlog mark, a title and one line of context, `TextField`s, then one full-width primary `Button`. Secondary routes are text links in `accent-text`. Every auth screen ends with the TMDB credit: "This app uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB." plus the TMDB key line and TMDB's official logo (use the file from TMDB; never redraw it). In the browser, the form sits on the right of a split layout with a poster mosaic on the left.

## Iconography

Line icons, 24px grid, 1.8px stroke, round caps and joins, no fills. Inactive icons use `text-muted`; the active one uses `accent-mark`. The set (exported as `Icon`): home, bookmark, folder, film, tv, user, eye, heart, search, back, check, star, chevron, play, more, cloud, close, plus, sort, sliders, down, eyeoff, mail, lock. The current app's icon source wasn't available, so these are drawn to match its look; swap in the real files when you have them.

## Components

`Icon`, `Button`, `BackButton`, `SearchField`, `SectionHeader`, `PosterArt`, `PosterCard`, `MediaRow`, `AiringRow`, `CastCard`, `Chip`, `Switch`, `TextField`, `BrowseHeader`, `ProgressBar`, `SeasonRow`, `EpisodeCard`, `StatTile`, `BottomNav`, `SideNav`, `TopNav`, `SiteFooter`, `LandscapeCard`, `EpisodeRow`, `SettingsRow`, `SegmentedControl`, `StatusPill`, `OptionCard`. Each reads only tokens, so restyling the tokens restyles the app. Every show or movie artwork, at any size, is `PosterArt` (inside `PosterCard`, `MediaRow` and the show header), so posters look the same everywhere. Every screen below the top level uses `BackButton` at its top-left. Pass real poster/still URLs through `image`; without one, cards show a `bg-raised` placeholder with the title's initials.

## What's not here yet

Charts (the watch-time bar chart and genre bars are drawn in screens with `accent` bars on `bg-card`), sheets/dialogs and toasts. Exact hex values were sampled from screenshots, so compare them with the app's code and correct any that drifted.