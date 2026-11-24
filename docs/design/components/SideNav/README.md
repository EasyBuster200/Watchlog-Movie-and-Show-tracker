# SideNav

The left sidebar for the browser version of the app, replacing `BottomNav` at desktop widths.

It holds the wordmark, the search field, the six sections (Home, Watchlist, Lists, Movies, Shows, Profile) and, at the foot, the signed-in profile and a settings button. The active section gets an `accent-subtle` ground with its icon in `accent-mark`. Pass `hrefs` so items are real links. Place it as the first child of a wrapping row: sidebar `flex: 1 1 232px`, content `flex: 999 1 560px; min-width: 0`, so it sits beside the content on desktop and stacks above it on narrow windows.
