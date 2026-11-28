import * as React from "react";

export type IconName = "home" | "bookmark" | "folder" | "film" | "tv" | "user" | "eye" | "heart" | "search" | "back" | "check" | "star" | "chevron" | "play" | "more" | "cloud" | "close" | "plus" | "sort" | "sliders" | "down";

export interface IconProps {
  name: IconName;
  /** Pixel size; default 24. */
  size?: number;
  strokeWidth?: number;
  /** Fill the shape with currentColor (active heart, star). */
  filled?: boolean;
}
export declare function Icon(props: IconProps): React.ReactElement;

export interface ButtonProps {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  icon?: IconName;
  /** Round 44px icon button; requires label. */
  iconOnly?: boolean;
  label?: string;
  onClick?: () => void;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface SearchFieldProps {
  placeholder?: string;
  value?: string;
  label?: string;
  onChange?: (value: string) => void;
}
export declare function SearchField(props: SearchFieldProps): React.ReactElement;

export interface SectionHeaderProps {
  title: string;
  /** Optional trailing link text, e.g. "See all". */
  action?: string;
  /** Makes the action a link (e.g. to the See all list). */
  actionHref?: string;
  onAction?: () => void;
}
export declare function SectionHeader(props: SectionHeaderProps): React.ReactElement;

export interface BackButtonProps {
  /** Where to go; renders a link. Without it, a button calling onClick. */
  href?: string;
  /** Accessible name; default "Back". */
  label?: string;
  onClick?: () => void;
}
export declare function BackButton(props: BackButtonProps): React.ReactElement;

export interface PosterArtProps {
  title: string;
  /** Poster image URL (2:3). Without it, initials on bg-raised. */
  image?: string;
  /** Width in px; height follows at 2:3. Default 132. */
  width?: number;
  /** Overlays (toggles) placed inside the art. */
  children?: React.ReactNode;
}
export declare function PosterArt(props: PosterArtProps): React.ReactElement;

export interface MediaRowProps {
  title: string;
  /** e.g. "Next: S2 · E5 · Chapter Five" */
  meta?: string;
  image?: string;
  /** Episodes watched / total; shows a progress bar and count when total > 0. */
  watched?: number;
  total?: number;
  /** Renders the row as a link. */
  href?: string;
  onClick?: () => void;
}
export declare function MediaRow(props: MediaRowProps): React.ReactElement;

export interface AiringRowProps {
  /** Short weekday, e.g. "Thu". */
  day: string;
  /** Day of the month, e.g. "19". */
  date: string | number;
  /** Show title. */
  title: string;
  /** e.g. "S2 · E3 · Chapter Three" */
  episode?: string;
  /** Relative time, e.g. "Tonight · 21:00", "In 2 days". */
  when?: string;
  /** Highlights `when` in accent-text (airs today). */
  soon?: boolean;
  /** Makes the row a link to the show. */
  href?: string;
}
export declare function AiringRow(props: AiringRowProps): React.ReactElement;

export interface CastCardProps {
  /** Actor's name. */
  name: string;
  /** Character played. */
  role?: string;
  /** Headshot URL (4:5). Without it, initials on bg-raised. */
  image?: string;
}
export declare function CastCard(props: CastCardProps): React.ReactElement;

export interface ChipProps {
  label: string;
  selected?: boolean;
  /** Optional result count shown after the label. */
  count?: number;
  /** Multi-select rows: show a check mark when selected. */
  check?: boolean;
  onClick?: () => void;
}
export declare function Chip(props: ChipProps): React.ReactElement;

export interface SwitchProps {
  /** Accessible name, usually the row's label. */
  label: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}
export declare function Switch(props: SwitchProps): React.ReactElement;

export interface TextFieldProps {
  label: string;
  type?: 'text' | 'email' | 'password';
  placeholder?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  /** Leading icon name, e.g. 'mail' or 'lock'. */
  icon?: string;
  helper?: string;
  error?: string;
  /** Element shown to the right of the label, e.g. a "Forgot password?" link. */
  aside?: React.ReactNode;
  autoComplete?: string;
  name?: string;
  id?: string;
}
/** Labelled 48px input. Password fields get a show/hide toggle. Focus uses accent-mark; errors use danger. */
export declare function TextField(props: TextFieldProps): React.ReactElement;

export interface BrowseSection {
  id: string;
  label: string;
  /** single: one choice (segmented bar; the first option means "no filter"). multi: any number (checklist). */
  kind: "single" | "multi";
  options: string[];
  value?: string | string[];
}
export interface BrowseHeaderProps {
  /** Section title, e.g. "Browse All Movies". */
  title?: string;
  /** 1 renders an h1; default h2. */
  level?: 1 | 2;
  /** Sort choices; the first is the default. Opens from the sort icon as a small menu. */
  sortOptions?: string[];
  sort?: string;
  /** Filter groups shown in the sheet from the filter icon. */
  sections?: BrowseSection[];
  /** Overrides the auto summary line ("Popular · Drama, Thriller"). */
  summary?: string;
  /** bottom (default): sheet slides up from the bottom of the screen. anchored: sheet drops below the header (for tall design frames). */
  placement?: "bottom" | "anchored";
  /** Fires when the sort changes or the sheet is applied. */
  onChange?: (state: { sort: string; values: Record<string, string | string[]> }) => void;
}
export declare function BrowseHeader(props: BrowseHeaderProps): React.ReactElement;

export interface PosterCardProps {
  title: string;
  /** e.g. "2026 • 8.0/10" */
  meta?: string;
  /** Optional line under the title, e.g. "45/45 episodes watched". */
  detail?: string;
  /** Poster image URL (2:3). Without it, initials on bg-raised. */
  image?: string;
  watched?: boolean;
  favorite?: boolean;
  /** On the watchlist: the bookmark shows filled in accent-text. */
  bookmarked?: boolean;
  onToggleBookmark?: (bookmarked: boolean) => void;
  /** Width in px; default 132. */
  width?: number;
  /** Shows a remove (×) button top-left in place of the watchlist button; for cards already in a list. */
  removable?: boolean;
  /** Name of the list for the remove button's label, e.g. "watchlist". */
  removeFrom?: string;
  onRemove?: () => void;
  onToggleWatched?: (watched: boolean) => void;
  onToggleFavorite?: (favorite: boolean) => void;
}
export declare function PosterCard(props: PosterCardProps): React.ReactElement;

export interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
}
export declare function ProgressBar(props: ProgressBarProps): React.ReactElement;

export interface SeasonRowProps {
  label: string;
  watched: number;
  total: number;
  onClick?: () => void;
}
export declare function SeasonRow(props: SeasonRowProps): React.ReactElement;

export interface EpisodeCardProps {
  number: number | string;
  title: string;
  date?: string;
  runtime?: string;
  synopsis?: string;
  /** Still image URL (16:9). */
  image?: string;
  watched?: boolean;
  onToggle?: (watched: boolean) => void;
}
export declare function EpisodeCard(props: EpisodeCardProps): React.ReactElement;

export interface StatTileProps {
  value: string | number;
  label: string;
}
export declare function StatTile(props: StatTileProps): React.ReactElement;

export interface SideNavProps {
  /** Active section. */
  active?: "home" | "watchlist" | "lists" | "movies" | "shows" | "profile";
  /** Links per section id (plus "settings"); items without one render as plain labels. */
  hrefs?: Partial<Record<"home" | "watchlist" | "lists" | "movies" | "shows" | "profile" | "settings", string>>;
  /** Wordmark next to the logo tile; default "Watchlog". */
  brand?: string;
  userName?: string;
}
/** Browser layout: left sidebar replacing BottomNav at desktop widths. */
export declare function SideNav(props: SideNavProps): React.ReactElement;

export interface BottomNavProps {
  active?: "home" | "watchlist" | "lists" | "movies" | "shows" | "profile";
  onChange?: (id: string) => void;
}
export declare function BottomNav(props: BottomNavProps): React.ReactElement;

export interface TopNavProps { active?: 'home' | 'watchlist' | 'lists' | 'movies' | 'shows' | 'profile'; hrefs?: Partial<Record<'home' | 'watchlist' | 'lists' | 'movies' | 'shows' | 'profile', string>>; brand?: string; userName?: string; searchPlaceholder?: string; maxWidth?: number; }
/** Browser header: brand, text links with an accent-mark underline on the active one, search with a "/" hint and the avatar (ringed on Profile). Sticky, 64px. */
export declare function TopNav(props: TopNavProps): React.ReactElement;
export interface SiteFooterProps { hrefs?: Partial<Record<'movies' | 'shows' | 'watchlist' | 'lists' | 'profile' | 'settings' | 'profiles', string>>; maxWidth?: number; }
/** Browser footer: about blurb, link columns and the TMDB credit with a logo placeholder. */
export declare function SiteFooter(props: SiteFooterProps): React.ReactElement;
export interface LandscapeCardProps { title: string; meta?: string; image?: string; badge?: string; watched?: number; total?: number; href?: string; }
/** 16:9 still with an optional badge, a progress bar along the bottom and a play button on hover. Browser Continue Watching. */
export declare function LandscapeCard(props: LandscapeCardProps): React.ReactElement;
export interface EpisodeRowProps { number: number; title: string; date?: string; runtime?: string; synopsis?: string; image?: string; watched?: boolean; onToggle?: (watched: boolean) => void; }
/** Browser episode list row: 200px still, title and meta, synopsis, and a labelled "Mark watched" pill. */
export declare function EpisodeRow(props: EpisodeRowProps): React.ReactElement;

export interface SettingsRowProps { label: string; sub?: string; kind?: 'link' | 'switch' | 'button' | 'danger'; value?: string; checked?: boolean; onChange?: (on: boolean) => void; onClick?: () => void; href?: string; badge?: string | number; disabled?: boolean; }
/** One row in a settings-style card: label and sub on the left; a chevron (with optional value), a Switch, or a small pill button on the right. Danger rows turn the label and button red. Stack rows inside a bg-card; hairlines are drawn between them. */
export declare function SettingsRow(props: SettingsRowProps): React.ReactElement;
export interface SegmentedControlProps { options: string[]; value?: string; onChange?: (value: string) => void; label?: string; }
/** A small segmented control for one in-place choice that applies at once (Settings' theme). Not for filters: those go in BrowseHeader. */
export declare function SegmentedControl(props: SegmentedControlProps): React.ReactElement;
export interface StatusPillProps { label: string; tone?: 'success' | 'danger' | 'warning' | 'neutral'; }
/** A small status label (Active, Suspended, Recovering, Watching, Dropped). */
export declare function StatusPill(props: StatusPillProps): React.ReactElement;
export interface OptionCardProps { label: string; description?: string; selected?: boolean; onClick?: () => void; }
/** A radio choice with a description line, stacked in a role="radiogroup" (Admin's sign-up mode). */
export declare function OptionCard(props: OptionCardProps): React.ReactElement;

declare global { interface Window { TVTracker: { Icon: typeof Icon; Button: typeof Button; SearchField: typeof SearchField; SectionHeader: typeof SectionHeader; BackButton: typeof BackButton; PosterArt: typeof PosterArt; PosterCard: typeof PosterCard; MediaRow: typeof MediaRow; AiringRow: typeof AiringRow; CastCard: typeof CastCard; Chip: typeof Chip; Switch: typeof Switch; TextField: typeof TextField; BrowseHeader: typeof BrowseHeader; ProgressBar: typeof ProgressBar; SeasonRow: typeof SeasonRow; EpisodeCard: typeof EpisodeCard; StatTile: typeof StatTile; BottomNav: typeof BottomNav; SideNav: typeof SideNav; TopNav: typeof TopNav; SiteFooter: typeof SiteFooter; LandscapeCard: typeof LandscapeCard; EpisodeRow: typeof EpisodeRow; SettingsRow: typeof SettingsRow; SegmentedControl: typeof SegmentedControl; StatusPill: typeof StatusPill; OptionCard: typeof OptionCard } } }
