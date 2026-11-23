# BrowseHeader

The title row above any browsable list, with a sort icon and a filter icon instead of rows of filter chips.

Give it a `title`, `sortOptions` (first is the default) and `sections` for the filter sheet: `single` groups render as a segmented bar where the first option means "no filter" (All), `multi` groups render as a two-column checklist (genres). The summary line under the title updates on its own ("Top rated · Drama, Thriller"); a dot on the filter icon shows when anything is active. Sort applies immediately from its menu; the sheet applies on "Show results" and can be cleared. In the app use the default bottom sheet; on design frames taller than a phone pass `placement="anchored"`.
