/* @ds-bundle: {"format":4,"namespace":"TVTracker","components":[{"name":"Icon"},{"name":"Button"},{"name":"SearchField"},{"name":"SectionHeader"},{"name":"BackButton"},{"name":"PosterArt"},{"name":"PosterCard"},{"name":"MediaRow"},{"name":"AiringRow"},{"name":"CastCard"},{"name":"Chip"},{"name":"Switch"},{"name":"TextField"},{"name":"BrowseHeader"},{"name":"ProgressBar"},{"name":"SeasonRow"},{"name":"EpisodeCard"},{"name":"StatTile"},{"name":"BottomNav"},{"name":"SideNav"},{"name":"TopNav"},{"name":"SiteFooter"},{"name":"LandscapeCard"},{"name":"EpisodeRow"},{"name":"SettingsRow"},{"name":"SegmentedControl"},{"name":"StatusPill"},{"name":"OptionCard"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;

  var PATHS = {
    home: ['M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z'],
    bookmark: ['M6 3.5h12v17l-6-4.5-6 4.5z'],
    folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
    film: ['M4.5 3.5h15v17h-15z', 'M8.5 3.5v17', 'M15.5 3.5v17', 'M4.5 8h4', 'M4.5 16h4', 'M15.5 8h4', 'M15.5 16h4'],
    tv: ['M3 7.5h18v12H3z', 'M8 3l4 4.5L16 3'],
    user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20.5a7.5 7.5 0 0 1 15 0'],
    eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    heart: ['M12 20s-7.5-4.6-9.2-9.4A4.6 4.6 0 0 1 12 7.2a4.6 4.6 0 0 1 9.2 3.4C19.5 15.4 12 20 12 20z'],
    search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20.5 20.5l-4.5-4.5'],
    back: ['M19 12H5', 'M11 6l-6 6 6 6'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z'],
    chevron: ['M9 6l6 6-6 6'],
    play: ['M7 4.5v15l12-7.5z'],
    sort: ['M7 4v16', 'M3.5 7.5L7 4l3.5 3.5', 'M17 20V4', 'M13.5 16.5L17 20l3.5-3.5'],
    sliders: ['M4 7h10', 'M18 7h2', 'M16 5v4', 'M4 17h4', 'M12 17h8', 'M10 15v4'],
    down: ['M6 9l6 6 6-6'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    eyeoff: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M4 4l16 16'],
    mail: ['M3.5 6h17v12h-17z', 'M3.5 7l8.5 6.5L20.5 7'],
    lock: ['M5.5 11h13v9.5h-13z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
    plus: ['M12 5v14', 'M5 12h14'],
    more: ['M10.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z', 'M3.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z', 'M17.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z'],
    cloud: ['M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z', 'M9.5 13.5l2 2 3.5-3.5']
  };

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(' ');
  }

  function initials(title) {
    return String(title || '')
      .split(/\s+/)
      .filter(function (w) { return /[A-Za-z0-9]/.test(w.charAt(0)); })
      .slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); })
      .join('');
  }

  function Icon(props) {
    var size = props.size || 24;
    var d = PATHS[props.name] || [];
    return h('svg', {
      className: 'tt-icon',
      width: size, height: size, viewBox: '0 0 24 24',
      fill: props.filled ? 'currentColor' : 'none',
      stroke: 'currentColor', strokeWidth: props.strokeWidth || 1.8,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true'
    }, d.map(function (p, i) {
      // A filled eye keeps a visible pupil: the inner circle is cut out in the page colour.
      var cut = props.filled && props.name === 'eye' && i === 1;
      return h('path', { key: i, d: p, fill: cut ? 'var(--bg-page)' : undefined, stroke: cut ? 'var(--bg-page)' : undefined });
    }));
  }

  function Button(props) {
    var variant = props.variant || 'primary';
    var iconOnly = !!props.iconOnly;
    return h('button', {
      type: 'button',
      className: cx('tt-btn', 'tt-btn--' + variant, iconOnly && 'tt-btn--icon'),
      onClick: props.onClick,
      'aria-label': iconOnly ? props.label : undefined
    },
      props.icon ? h(Icon, { name: props.icon, size: 20 }) : null,
      iconOnly ? null : props.children
    );
  }

  function SearchField(props) {
    var _s = React.useState(props.value || '');
    var value = props.value != null ? props.value : _s[0];
    return h('label', { className: 'tt-search' },
      h(Icon, { name: 'search', size: 20 }),
      h('span', { className: 'tt-sr' }, props.label || 'Search'),
      h('input', {
        type: 'search', value: value,
        placeholder: props.placeholder || 'Search movies and shows…',
        onChange: function (e) { _s[1](e.target.value); if (props.onChange) props.onChange(e.target.value); }
      })
    );
  }

  function SectionHeader(props) {
    return h('div', { className: 'tt-section' },
      h('h2', null, props.title),
      props.action
        ? (props.actionHref
          ? h('a', { className: 'tt-link', href: props.actionHref, style: { textDecoration: 'none' } }, props.action)
          : h('button', { type: 'button', className: 'tt-link', onClick: props.onAction }, props.action))
        : null
    );
  }

  function BackButton(props) {
    var label = props.label || 'Back';
    var icon = h(Icon, { name: 'back', size: 20, strokeWidth: 2 });
    return props.href
      ? h('a', { className: 'tt-back', href: props.href, 'aria-label': label }, icon)
      : h('button', { type: 'button', className: 'tt-back', 'aria-label': label, onClick: props.onClick }, icon);
  }

  function PosterArt(props) {
    var w = props.width || 132;
    var title = props.title || '';
    return h('div', { className: 'tt-poster__art', style: { width: w } },
      props.image
        ? h('img', { src: props.image, alt: title + ' poster' })
        : h('div', { className: 'tt-poster__ph', style: { fontSize: Math.max(14, Math.round(w * 0.2)) }, 'aria-hidden': 'true' }, initials(title)),
      props.children
    );
  }

  function MediaRow(props) {
    var tag = props.href ? 'a' : 'button';
    var hasProgress = props.total > 0;
    return h(tag, {
      className: 'tt-media', href: props.href, type: props.href ? undefined : 'button', onClick: props.onClick
    },
      h(PosterArt, { title: props.title, image: props.image, width: 56 }),
      h('span', { className: 'tt-media__body' },
        h('span', { className: 'tt-media__title' }, props.title),
        props.meta ? h('span', { className: 'tt-media__meta' }, props.meta) : null,
        hasProgress ? h(ProgressBar, { value: props.watched || 0, max: props.total, label: props.title + ' progress' }) : null,
        hasProgress ? h('span', { className: 'tt-media__meta' }, (props.watched || 0) + '/' + props.total + ' episodes watched') : null
      )
    );
  }

  function AiringRow(props) {
    var tag = props.href ? 'a' : 'div';
    return h(tag, { className: 'tt-airing', href: props.href },
      h('span', { className: 'tt-airing__date', 'aria-hidden': 'true' },
        h('span', { className: 'tt-airing__dow' }, props.day),
        h('span', { className: 'tt-airing__num' }, props.date)
      ),
      h('span', { className: 'tt-airing__body' },
        h('span', { className: 'tt-airing__title' }, props.title),
        props.episode ? h('span', { className: 'tt-airing__ep' }, props.episode) : null
      ),
      props.when ? h('span', { className: cx('tt-airing__when', props.soon && 'tt-airing__when--soon') },
        h('span', { className: 'tt-sr' }, props.day + ' ' + props.date + ', '), props.when) : null
    );
  }

  function CastCard(props) {
    var name = props.name || '';
    return h('div', { className: 'tt-cast' },
      h('div', { className: 'tt-cast__photo' },
        props.image ? h('img', { src: props.image, alt: name }) : h('span', { 'aria-hidden': 'true' }, initials(name))
      ),
      h('span', { className: 'tt-cast__name' }, name),
      props.role ? h('span', { className: 'tt-cast__role' }, props.role) : null
    );
  }

  function Chip(props) {
    var on = !!props.selected;
    return h('button', {
      type: 'button', className: cx('tt-chip', on && 'tt-chip--on'), 'aria-pressed': on, onClick: props.onClick
    },
      props.check && on ? h(Icon, { name: 'check', size: 12, strokeWidth: 2.6 }) : null,
      props.label,
      props.count != null ? h('span', { className: 'tt-chip__count' }, props.count) : null);
  }

  function Switch(props) {
    var _s = React.useState(!!props.checked);
    var on = props.checked != null && props.onChange ? !!props.checked : _s[0];
    return h('button', {
      type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': props.label,
      className: cx('tt-switch', on && 'tt-switch--on'),
      onClick: function () { _s[1](!on); if (props.onChange) props.onChange(!on); }
    }, h('span', { className: 'tt-switch__knob', 'aria-hidden': 'true' }));
  }

  var _tfId = 0;
  function TextField(props) {
    var _id = React.useState(function () { _tfId += 1; return 'tt-field-' + _tfId; })[0];
    var id = props.id || _id;
    var isPw = props.type === 'password';
    var _show = React.useState(false);
    var _v = React.useState(props.defaultValue || '');
    var value = props.value != null ? props.value : _v[0];
    var hint = props.error || props.helper;
    return h('div', { className: cx('tt-field', props.error && 'tt-field--error') },
      h('div', { className: 'tt-field__top' },
        h('label', { className: 'tt-field__label', htmlFor: id }, props.label),
        props.aside || null),
      h('div', { className: 'tt-field__box' },
        props.icon ? h(Icon, { name: props.icon, size: 18 }) : null,
        h('input', {
          id: id, type: isPw && _show[0] ? 'text' : (props.type || 'text'), value: value,
          placeholder: props.placeholder, autoComplete: props.autoComplete, name: props.name,
          'aria-invalid': props.error ? 'true' : undefined, 'aria-describedby': hint ? id + '-hint' : undefined,
          onChange: function (e) { _v[1](e.target.value); if (props.onChange) props.onChange(e.target.value); }
        }),
        isPw ? h('button', {
          type: 'button', className: 'tt-field__reveal', 'aria-label': _show[0] ? 'Hide password' : 'Show password',
          'aria-pressed': _show[0], onClick: function () { _show[1](!_show[0]); }
        }, h(Icon, { name: _show[0] ? 'eyeoff' : 'eye', size: 18 })) : null),
      hint ? h('span', { className: 'tt-field__hint', id: id + '-hint' }, props.error || props.helper) : null
    );
  }

  function sectionDefault(sec) { return sec.kind === 'multi' ? [] : sec.options[0]; }
  function sectionActive(sec, v) { return sec.kind === 'multi' ? (v || []).length > 0 : v != null && v !== sec.options[0]; }

  function BrowseHeader(props) {
    var sorts = props.sortOptions || [];
    var sections = props.sections || [];
    var init = {};
    sections.forEach(function (sec) { init[sec.id] = sec.value != null ? sec.value : sectionDefault(sec); });
    var _sort = React.useState(props.sort || sorts[0]);
    var _vals = React.useState(init);
    var _draft = React.useState(init);
    var _open = React.useState(null);
    var sort = _sort[0], vals = _vals[0], draft = _draft[0], open = _open[0];
    var emit = function (nextSort, nextVals) { if (props.onChange) props.onChange({ sort: nextSort, values: nextVals }); };
    var activeCount = sections.reduce(function (n, sec) {
      var v = vals[sec.id];
      return n + (sec.kind === 'multi' ? (v || []).length : (sectionActive(sec, v) ? 1 : 0));
    }, 0);
    var parts = [sort];
    sections.forEach(function (sec) {
      var v = vals[sec.id];
      if (sec.kind === 'multi') { if ((v || []).length) parts.push(v.join(', ')); }
      else if (sectionActive(sec, v)) parts.push(v);
    });
    var summary = props.summary || parts.join(' · ');
    var check = function () { return h('span', { className: 'tt-menu__check' }, h(Icon, { name: 'check', size: 16, strokeWidth: 2.4 })); };

    var sortMenu = open === 'sort' ? h('div', { className: 'tt-menu', role: 'menu' },
      sorts.map(function (o) {
        var on = o === sort;
        return h('button', {
          key: o, type: 'button', role: 'menuitemradio', 'aria-checked': on,
          className: cx('tt-menu__item', on && 'tt-menu__item--on'),
          onClick: function () { _sort[1](o); _open[1](null); emit(o, vals); }
        }, o, check());
      })) : null;

    var setDraft = function (id, v) { var n = Object.assign({}, draft); n[id] = v; _draft[1](n); };
    var sheetBody = open === 'sheet' ? h('div', { className: cx('tt-sheet', props.placement === 'anchored' ? 'tt-sheet--anchored' : 'tt-sheet--bottom'), role: 'dialog', 'aria-label': 'Filters' },
      h('span', { className: 'tt-sheet__handle', 'aria-hidden': 'true' }),
      h('div', { className: 'tt-sheet__head' },
        h('span', { className: 'tt-sheet__title' }, 'Filters'),
        h('button', { type: 'button', className: 'tt-link', onClick: function () { var n = {}; sections.forEach(function (sec) { n[sec.id] = sectionDefault(sec); }); _draft[1](n); } }, 'Clear all')
      ),
      sections.map(function (sec) {
        var v = draft[sec.id];
        return h('div', { key: sec.id, className: 'tt-sheet__section' },
          h('span', { className: 'tt-filter-label' }, sec.label),
          sec.kind === 'multi'
            ? h('div', { className: 'tt-sheet__checks', role: 'group', 'aria-label': sec.label }, sec.options.map(function (o) {
              var on = (v || []).indexOf(o) >= 0;
              return h('button', {
                key: o, type: 'button', role: 'checkbox', 'aria-checked': on,
                className: cx('tt-menu__item', on && 'tt-menu__item--on'),
                onClick: function () { setDraft(sec.id, on ? v.filter(function (x) { return x !== o; }) : (v || []).concat([o])); }
              }, o, check());
            }))
            : h('div', { className: 'tt-seg tt-seg--inline', role: 'group', 'aria-label': sec.label }, sec.options.map(function (o) {
              var on = v === o;
              return h('button', { key: o, type: 'button', 'aria-pressed': on, className: cx('tt-seg__item', on && 'tt-seg__item--on'), onClick: function () { setDraft(sec.id, o); } }, o);
            }))
        );
      }),
      h(Button, { variant: 'primary', onClick: function () { _vals[1](draft); _open[1](null); emit(sort, draft); } }, 'Show results')
    ) : null;
    var scrim = open === 'sheet' ? h('div', { className: cx('tt-scrim', props.placement === 'anchored' && 'tt-scrim--anchored'), onClick: function () { _open[1](null); } }) : null;

    var Heading = props.level === 1 ? 'h1' : 'h2';
    return h('div', { className: 'tt-bh' },
      h('div', { className: 'tt-bh__row' },
        h('div', { className: 'tt-bh__text' },
          props.title ? h(Heading, { className: 'tt-bh__title' }, props.title) : null,
          h('span', { className: 'tt-bh__summary' }, summary)
        ),
        h('div', { className: 'tt-bh__actions' },
          sorts.length ? h('button', {
            type: 'button', className: cx('tt-iconbtn', open === 'sort' && 'tt-iconbtn--open'), 'aria-label': 'Sort: ' + sort,
            'aria-haspopup': 'menu', 'aria-expanded': open === 'sort', onClick: function () { _open[1](open === 'sort' ? null : 'sort'); }
          }, h(Icon, { name: 'sort', size: 18 })) : null,
          sections.length ? h('button', {
            type: 'button', className: 'tt-iconbtn', 'aria-label': activeCount ? 'Filters, ' + activeCount + ' active' : 'Filters',
            'aria-haspopup': 'dialog', 'aria-expanded': open === 'sheet',
            onClick: function () { _draft[1](vals); _open[1]('sheet'); }
          }, h(Icon, { name: 'sliders', size: 18 }), activeCount ? h('span', { className: 'tt-iconbtn__dot', 'aria-hidden': 'true' }) : null) : null,
          sortMenu
        )
      ),
      scrim, sheetBody
    );
  }

  function PosterCard(props) {
    var _w = React.useState(!!props.watched);
    var _f = React.useState(!!props.favorite);
    var _b = React.useState(!!props.bookmarked);
    var watched = _w[0], fav = _f[0], saved = _b[0];
    var title = props.title || '';
    return h('div', { className: 'tt-poster', style: { width: props.width || 132 } },
      h(PosterArt, { title: title, image: props.image, width: props.width || 132 },
        h('button', {
          type: 'button', className: cx('tt-toggle', 'tt-toggle--watch', watched && 'tt-toggle--on'),
          style: { top: 8, right: 8 }, 'aria-pressed': watched,
          'aria-label': (watched ? 'Unmark ' : 'Mark ') + title + ' as watched',
          onClick: function () { _w[1](!watched); if (props.onToggleWatched) props.onToggleWatched(!watched); }
        }, h(Icon, { name: 'eye', size: 18, filled: watched })),
        h('button', {
          type: 'button', className: cx('tt-toggle', 'tt-toggle--fav', fav && 'tt-toggle--on'),
          style: { bottom: 8, left: 8 }, 'aria-pressed': fav,
          'aria-label': (fav ? 'Remove ' : 'Add ') + title + (fav ? ' from' : ' to') + ' favourites',
          onClick: function () { _f[1](!fav); if (props.onToggleFavorite) props.onToggleFavorite(!fav); }
        }, h(Icon, { name: 'heart', size: 18, filled: fav })),
        props.removable
          ? h('button', {
            type: 'button', className: 'tt-toggle', style: { top: 8, left: 8 },
            'aria-label': 'Remove ' + title + ' from ' + (props.removeFrom || 'this list'),
            onClick: props.onRemove
          }, h(Icon, { name: 'close', size: 18 }))
          : h('button', {
            type: 'button', className: cx('tt-toggle', 'tt-toggle--save', saved && 'tt-toggle--on'),
            style: { bottom: 8, right: 8 }, 'aria-pressed': saved,
            'aria-label': (saved ? 'Remove ' + title + ' from' : 'Add ' + title + ' to') + ' watchlist',
            onClick: function () { _b[1](!saved); if (props.onToggleBookmark) props.onToggleBookmark(!saved); }
          }, h(Icon, { name: 'bookmark', size: 18, filled: saved }))
      ),
      props.meta ? h('span', { className: 'tt-poster__meta' }, props.meta) : null,
      h('span', { className: 'tt-poster__title' }, title),
      props.detail ? h('span', { className: 'tt-poster__meta' }, props.detail) : null
    );
  }

  function ProgressBar(props) {
    var max = props.max || 1;
    var pct = Math.max(0, Math.min(100, ((props.value || 0) / max) * 100));
    return h('div', {
      className: 'tt-progress', role: 'progressbar',
      'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': props.value || 0,
      'aria-label': props.label || 'Progress'
    }, h('div', { className: 'tt-progress__fill', style: { width: pct + '%' } }));
  }

  function SeasonRow(props) {
    var done = props.total > 0 && props.watched >= props.total;
    return h('button', {
      type: 'button', className: cx('tt-row', done && 'tt-row--done'), onClick: props.onClick
    },
      h('span', { className: 'tt-row__label' }, props.label),
      h('span', { className: 'tt-row__count' },
        done ? h(Icon, { name: 'check', size: 16, strokeWidth: 2.2 }) : null,
        props.watched + '/' + props.total + ' watched',
        h(Icon, { name: 'chevron', size: 16 })
      )
    );
  }

  function EpisodeCard(props) {
    var _w = React.useState(!!props.watched);
    var watched = _w[0];
    var meta = [props.date, props.runtime].filter(Boolean).join(' • ');
    return h('article', { className: 'tt-episode' },
      h('div', { className: 'tt-episode__still' },
        props.image ? h('img', { src: props.image, alt: '' }) : null
      ),
      h('div', { className: 'tt-episode__head' },
        h('span', { className: 'tt-episode__num' }, props.number),
        h('span', { className: 'tt-episode__title' }, props.title),
        h('button', {
          type: 'button', className: cx('tt-toggle', 'tt-toggle--watch', 'tt-episode__check', watched && 'tt-toggle--on'),
          'aria-pressed': watched,
          'aria-label': (watched ? 'Unmark ' : 'Mark ') + 'episode ' + props.number + ' as watched',
          onClick: function () { _w[1](!watched); if (props.onToggle) props.onToggle(!watched); }
        }, h(Icon, { name: 'eye', size: 18, filled: watched }))
      ),
      meta ? h('span', { className: 'tt-episode__meta' }, meta) : null,
      props.synopsis ? h('p', { className: 'tt-episode__body' }, props.synopsis) : null,
      props.synopsis ? h('button', { type: 'button', className: 'tt-link', style: { alignSelf: 'flex-start' } }, 'Show more') : null
    );
  }

  function StatTile(props) {
    return h('div', { className: 'tt-stat' },
      h('span', { className: 'tt-stat__value' }, props.value),
      h('span', { className: 'tt-stat__label' }, props.label)
    );
  }

  var NAV = [
    { id: 'home', icon: 'home', label: 'Home' },
    { id: 'watchlist', icon: 'bookmark', label: 'Watchlist' },
    { id: 'lists', icon: 'folder', label: 'Lists' },
    { id: 'movies', icon: 'film', label: 'Movies' },
    { id: 'shows', icon: 'tv', label: 'Shows' },
    { id: 'profile', icon: 'user', label: 'Profile' }
  ];

  function BottomNav(props) {
    var _a = React.useState(props.active || 'home');
    var active = _a[0];
    return h('nav', { className: 'tt-nav', 'aria-label': 'Main' },
      NAV.map(function (it) {
        var on = it.id === active;
        return h('button', {
          key: it.id, type: 'button', className: cx('tt-nav__item', on && 'tt-nav__item--on'),
          'aria-label': it.label, 'aria-current': on ? 'page' : undefined,
          onClick: function () { _a[1](it.id); if (props.onChange) props.onChange(it.id); }
        }, h(Icon, { name: it.icon, size: 24, strokeWidth: on ? 2 : 1.8 }));
      })
    );
  }

  function SideNav(props) {
    var active = props.active || 'home';
    var hrefs = props.hrefs || {};
    var item = function (it) {
      var on = it.id === active;
      return h(hrefs[it.id] ? 'a' : 'span', {
        key: it.id, href: hrefs[it.id], className: cx('tt-sidenav__item', on && 'tt-sidenav__item--on'),
        'aria-current': on ? 'page' : undefined
      }, h(Icon, { name: it.icon, size: 20, strokeWidth: on ? 2 : 1.8 }), it.label);
    };
    return h('nav', { className: 'tt-sidenav', 'aria-label': 'Main' },
      h('span', { className: 'tt-sidenav__brand' },
        h('span', { className: 'tt-sidenav__mark', 'aria-hidden': 'true' }, h(Icon, { name: 'play', size: 14, filled: true })),
        props.brand || 'Watchlog'),
      h(SearchField, { placeholder: 'Search movies and shows…' }),
      h('div', { className: 'tt-sidenav__items' }, NAV.map(item)),
      h('div', { className: 'tt-sidenav__foot' },
        h(hrefs.profile ? 'a' : 'span', { className: 'tt-sidenav__me', href: hrefs.profile },
          h('span', { className: 'tt-sidenav__avatar', 'aria-hidden': 'true' }, (props.userName || 'D').charAt(0)),
          h('span', null, props.userName || 'Duarte')),
        hrefs.settings ? h('a', { className: 'tt-btn tt-btn--ghost tt-btn--icon', href: hrefs.settings, 'aria-label': 'Settings', style: { color: 'var(--text-secondary)' } }, h(Icon, { name: 'more', size: 20 })) : null
      )
    );
  }

  function TopNav(props) {
    var hrefs = props.hrefs || {};
    var links = NAV.filter(function (n) { return n.id !== 'profile'; });
    var name = props.userName || 'Duarte';
    return h('header', { className: 'tt-topnav' },
      h('div', { className: 'tt-topnav__in', style: props.maxWidth ? { maxWidth: props.maxWidth } : undefined },
        h(hrefs.home ? 'a' : 'span', { className: 'tt-topnav__brand', href: hrefs.home },
          h('span', { className: 'tt-sidenav__mark', 'aria-hidden': 'true' }, h(Icon, { name: 'play', size: 14, filled: true })),
          props.brand || 'Watchlog'),
        h('nav', { className: 'tt-topnav__links', 'aria-label': 'Main' }, links.map(function (it) {
          var on = props.active === it.id;
          return h(hrefs[it.id] ? 'a' : 'span', {
            key: it.id, href: hrefs[it.id], className: cx('tt-topnav__link', on && 'tt-topnav__link--on'),
            'aria-current': on ? 'page' : undefined
          }, it.label);
        })),
        h('div', { className: 'tt-topnav__end' },
          h('label', { className: 'tt-topnav__search' },
            h(Icon, { name: 'search', size: 18 }),
            h('input', { type: 'search', placeholder: props.searchPlaceholder || 'Search movies, shows, people', 'aria-label': 'Search' }),
            h('kbd', { 'aria-hidden': 'true' }, '/')),
          h(hrefs.profile ? 'a' : 'span', {
            className: cx('tt-topnav__me', props.active === 'profile' && 'tt-topnav__me--on'), href: hrefs.profile, 'aria-label': name + ', profile'
          }, h('span', { className: 'tt-sidenav__avatar', 'aria-hidden': 'true' }, name.charAt(0)))
        )
      )
    );
  }

  function SiteFooter(props) {
    var hrefs = props.hrefs || {};
    var col = function (title, items) {
      return h('div', { className: 'tt-footer__col' },
        h('span', { className: 'tt-footer__h' }, title),
        items.map(function (it) { return h('a', { key: it[0], href: it[1] || '#', className: 'tt-footer__a' }, it[0]); }));
    };
    return h('footer', { className: 'tt-footer' },
      h('div', { className: 'tt-footer__in', style: props.maxWidth ? { maxWidth: props.maxWidth } : undefined },
        h('div', { className: 'tt-footer__top' },
          h('div', { className: 'tt-footer__about' },
            h('span', { className: 'tt-topnav__brand' },
              h('span', { className: 'tt-sidenav__mark', 'aria-hidden': 'true' }, h(Icon, { name: 'play', size: 14, filled: true })), 'Watchlog'),
            h('p', null, 'Track every show and movie you watch, on your phone and in the browser.')),
          col('Browse', [['Movies', hrefs.movies], ['Shows', hrefs.shows], ['Watchlist', hrefs.watchlist], ['Lists', hrefs.lists]]),
          col('Account', [['Profile', hrefs.profile], ['Settings', hrefs.settings], ['Export data', hrefs.settings], ['Switch profile', hrefs.profiles]]),
          col('About', [['Privacy', '#'], ['Terms', '#'], ['Contact', '#']])),
        h('div', { className: 'tt-footer__tmdb' },
          h('span', { className: 'tt-footer__logo', role: 'img', 'aria-label': 'TMDB logo placeholder' }, 'TMDB logo'),
          h('p', null, 'This app uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB. Each profile uses its own TMDB API key. Get a free one at ',
            h('a', { href: 'https://www.themoviedb.org/settings/api' }, 'themoviedb.org'), '.'))
      )
    );
  }

  function LandscapeCard(props) {
    var tag = props.href ? 'a' : 'div';
    var hasProgress = props.total > 0;
    return h(tag, { className: 'tt-land', href: props.href },
      h('span', { className: 'tt-land__still' },
        props.image ? h('img', { src: props.image, alt: '' }) : h('span', { className: 'tt-poster__ph', 'aria-hidden': 'true' }, initials(props.title || '')),
        props.badge ? h('span', { className: 'tt-land__badge' }, props.badge) : null,
        h('span', { className: 'tt-land__play', 'aria-hidden': 'true' }, h(Icon, { name: 'play', size: 18, filled: true })),
        hasProgress ? h('span', { className: 'tt-land__bar' }, h('span', { style: { width: Math.round(100 * (props.watched || 0) / props.total) + '%' } })) : null),
      h('span', { className: 'tt-land__title' }, props.title),
      props.meta ? h('span', { className: 'tt-land__meta' }, props.meta) : null
    );
  }

  function EpisodeRow(props) {
    var _w = React.useState(!!props.watched);
    var watched = _w[0];
    var meta = [props.date, props.runtime].filter(Boolean).join(' • ');
    return h('article', { className: cx('tt-eprow', watched && 'tt-eprow--watched') },
      h('div', { className: 'tt-eprow__still' }, props.image ? h('img', { src: props.image, alt: '' }) : null,
        h('span', { className: 'tt-eprow__num' }, 'E' + props.number)),
      h('div', { className: 'tt-eprow__body' },
        h('div', { className: 'tt-eprow__head' },
          h('span', { className: 'tt-eprow__title' }, props.title),
          meta ? h('span', { className: 'tt-eprow__meta' }, meta) : null),
        props.synopsis ? h('p', { className: 'tt-eprow__text' }, props.synopsis) : null),
      h('button', {
        type: 'button', className: cx('tt-eprow__check', watched && 'tt-eprow__check--on'), 'aria-pressed': watched,
        'aria-label': (watched ? 'Unmark ' : 'Mark ') + 'episode ' + props.number + ' as watched',
        onClick: function () { _w[1](!watched); if (props.onToggle) props.onToggle(!watched); }
      }, h(Icon, { name: 'eye', size: 18, filled: watched }), watched ? 'Watched' : 'Mark watched')
    );
  }

  // One row in a settings-style card: label + sub on the left, one control on the right.
  function SettingsRow(props) {
    var kind = props.kind || 'link';
    var tag = props.href ? 'a' : 'div';
    var control = null;
    if (kind === 'switch') control = h(Switch, { label: props.label, checked: props.checked, onChange: props.onChange });
    else if (kind === 'button' || kind === 'danger') control = h('button', { type: 'button', className: 'tt-setrow__btn', onClick: props.onClick }, props.value);
    else if (kind === 'link') control = h('span', { className: 'tt-setrow__value' }, props.value || null, h(Icon, { name: 'chevron', size: 18 }));
    return h(tag, {
      className: cx('tt-setrow', kind === 'danger' && 'tt-setrow--danger', props.disabled && 'tt-setrow--disabled'),
      href: props.href, onClick: kind === 'link' && !props.href ? props.onClick : undefined
    },
      h('span', { className: 'tt-setrow__text' },
        h('span', { className: 'tt-setrow__label' }, props.label),
        props.sub ? h('span', { className: 'tt-setrow__sub' }, props.sub) : null),
      props.badge ? h('span', { className: 'tt-badge' }, props.badge) : null,
      control);
  }

  function SegmentedControl(props) {
    var opts = props.options || [];
    var _v = React.useState(props.value != null ? props.value : opts[0]);
    var value = props.value != null && props.onChange ? props.value : _v[0];
    return h('div', { className: 'tt-seg tt-seg--inline', role: 'group', 'aria-label': props.label },
      opts.map(function (o) {
        var on = o === value;
        return h('button', { key: o, type: 'button', className: cx('tt-seg__item', on && 'tt-seg__item--on'), 'aria-pressed': on,
          onClick: function () { _v[1](o); if (props.onChange) props.onChange(o); } }, o);
      }));
  }

  function StatusPill(props) {
    return h('span', { className: cx('tt-pill', 'tt-pill--' + (props.tone || 'success')) }, props.label);
  }

  function OptionCard(props) {
    return h('button', { type: 'button', role: 'radio', 'aria-checked': !!props.selected,
      className: cx('tt-option', props.selected && 'tt-option--on'), onClick: props.onClick },
      h('span', { className: 'tt-option__dot', 'aria-hidden': 'true' }),
      h('span', { className: 'tt-option__text' },
        h('span', { className: 'tt-option__label' }, props.label),
        props.description ? h('span', { className: 'tt-option__desc' }, props.description) : null));
  }

  window.TVTracker = {
    Icon: Icon, Button: Button, SearchField: SearchField, SectionHeader: SectionHeader,
    BackButton: BackButton, PosterArt: PosterArt, PosterCard: PosterCard, MediaRow: MediaRow, AiringRow: AiringRow, CastCard: CastCard, Chip: Chip, Switch: Switch, TextField: TextField, BrowseHeader: BrowseHeader, ProgressBar: ProgressBar, SeasonRow: SeasonRow,
    EpisodeCard: EpisodeCard, StatTile: StatTile, BottomNav: BottomNav, SideNav: SideNav, TopNav: TopNav, SiteFooter: SiteFooter, LandscapeCard: LandscapeCard, EpisodeRow: EpisodeRow, SettingsRow: SettingsRow, SegmentedControl: SegmentedControl, StatusPill: StatusPill, OptionCard: OptionCard
  };
})();
