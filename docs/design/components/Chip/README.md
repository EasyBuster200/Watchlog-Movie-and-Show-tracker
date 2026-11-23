# Chip

A slim, quiet pill for in-place choices: 30px tall, 12px text, a hairline `border-subtle` outline and no fill.

Selected chips get a soft tint instead of a solid fill: `accent-subtle` ground, `accent-mark` outline and `accent-text` label. An invisible hit area keeps the tap target about 44px tall. Only one chip in a row is `selected` unless the choices combine; in multi-select rows set `check` so a small check mark shows the state, not colour alone. Add `count` when the number helps choose. Lists that need filtering or sorting use `BrowseHeader` instead of chip rows; keep chips for short, visible choices (a theme picker, a quick tag).
