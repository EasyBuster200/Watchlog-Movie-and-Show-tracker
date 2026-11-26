// Settings the owner changes on the admin page, without a deploy (table app_settings, migration
// 0004). Read on many requests (every TMDB proxy call), so they're kept in memory for a short
// while per database; a change made on this Worker instance is seen at once, other instances
// see it within SETTINGS_CACHE_MS.
//
// - signup_mode: who can make an online account (SIGNUP_MODES):
//     'closed'   nobody new
//     'invite'   only with an invite code from the admin page
//     'approval' anyone can ask; the account waits as 'pending' until the owner approves it.
//                An invite code skips the wait. (The default, decided with the user.)
//     'open'     anyone (still rate limited)
//   While no account exists at all, the first sign-up is let in whatever the mode, so the owner
//   can make theirs.
// - tmdb_proxy: 'on' or 'off' (the kill switch). The TMDB_PROXY var "off" also pauses it.
// - tmdb_daily_cap: TMDB proxy requests per day for everyone together.

export const SIGNUP_MODES = ['closed', 'invite', 'approval', 'open'];
export const DEFAULT_TMDB_DAILY_CAP = 40000;
export const MAX_TMDB_DAILY_CAP = 90000; // below the Worker's free 100,000 requests a day

export const SETTING_DEFAULTS = {
  signupMode: 'approval',
  tmdbProxy: 'on',
  tmdbDailyCap: DEFAULT_TMDB_DAILY_CAP,
};

const COLUMNS = { signupMode: 'signup_mode', tmdbProxy: 'tmdb_proxy', tmdbDailyCap: 'tmdb_daily_cap' };
const SETTINGS_CACHE_MS = 30 * 1000;
const cache = new WeakMap(); // database binding -> { at, settings }

function parse(rows) {
  const settings = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.key === 'signup_mode' && SIGNUP_MODES.includes(row.value)) settings.signupMode = row.value;
    if (row.key === 'tmdb_proxy' && ['on', 'off'].includes(row.value)) settings.tmdbProxy = row.value;
    if (row.key === 'tmdb_daily_cap' && Number(row.value) > 0) settings.tmdbDailyCap = Number(row.value);
  }
  return settings;
}

export async function getSettings(env, { fresh = false } = {}) {
  const cached = cache.get(env.DB);
  if (!fresh && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.settings;
  const { results } = await env.DB.prepare('SELECT key, value FROM app_settings').all();
  const settings = parse(results);
  cache.set(env.DB, { at: Date.now(), settings });
  return settings;
}

// Checks and stores changes ({ signupMode, tmdbProxy, tmdbDailyCap }, any subset). Returns the
// new settings, or throws a message (string) for a value that isn't allowed.
export async function updateSettings(env, updates, now = new Date()) {
  const clean = {};
  if (updates.signupMode !== undefined) {
    if (!SIGNUP_MODES.includes(updates.signupMode)) throw 'Unknown sign-up mode.';
    clean.signupMode = updates.signupMode;
  }
  if (updates.tmdbProxy !== undefined) {
    if (!['on', 'off'].includes(updates.tmdbProxy)) throw 'The TMDB switch is "on" or "off".';
    clean.tmdbProxy = updates.tmdbProxy;
  }
  if (updates.tmdbDailyCap !== undefined) {
    const cap = Number(updates.tmdbDailyCap);
    if (!Number.isInteger(cap) || cap < 100 || cap > MAX_TMDB_DAILY_CAP) throw `The daily cap must be between 100 and ${MAX_TMDB_DAILY_CAP}.`;
    clean.tmdbDailyCap = cap;
  }
  const keys = Object.keys(clean);
  if (keys.length) {
    await env.DB.batch(keys.map(key => env.DB.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind(COLUMNS[key], String(clean[key]), now.toISOString())));
  }
  return { settings: await getSettings(env, { fresh: true }), changed: clean };
}
