// The app's side of the Watchlog server (server/, roadmap Phase 3): online accounts.
//
// Unlike localApi.js's /api/... routes, which are answered on the device, these are real network
// requests to the Worker's /v1/ API (docs/DEVELOPMENT.md, "Accounts API").
//
// An online profile is an ordinary profile (profiles.js) with an `account` on its registry entry:
//   { id, displayName,            the server's account
//     sessionId, sessionToken,    this device's sign-in (sessionToken null once signed out)
//     accountKey,                 the key, only on a device that created or typed it
//     keySavedAt,                 when the person confirmed saving the key (null = not yet)
//     linkedAt }
// The profile's library stays in its own IndexedDB database, exactly like an offline profile's;
// sync.js keeps it the same on the account's other devices.
//
// Online accounts are hidden (onlineAccountsEnabled) until sign-up is invite-only, decided with
// the user.
// For trying them, set localStorage 'watchlog_preview_online_accounts' to '1'.
//
// Load after profiles.js.

const PRODUCTION_SERVER_URL = 'https://watchlog.duartecruzcoelho.workers.dev';
// Points the app at another server (e.g. a pull request's preview) when set in localStorage.
const SERVER_URL_OVERRIDE_KEY = 'watchlog_server_url';
const ONLINE_ACCOUNTS_PREVIEW_KEY = 'watchlog_preview_online_accounts';

function onlineAccountsEnabled() {
  try {
    return localStorage.getItem(ONLINE_ACCOUNTS_PREVIEW_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function isNativeAppPlatform() {
  return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// The web app talks to the server on its own address (a preview to its own preview). The Android
// app runs at https://localhost, so it needs the full production address.
function serverBaseUrl() {
  let override = null;
  try { override = localStorage.getItem(SERVER_URL_OVERRIDE_KEY); } catch (error) { /* no storage */ }
  if (override) return override.replace(/\/+$/, '');
  if (isNativeAppPlatform()) return PRODUCTION_SERVER_URL;
  return window.location.origin;
}

class ServerError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function waitText(seconds) {
  if (!seconds) return '';
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? ' Try again in a minute.' : ` Try again in about ${minutes} minutes.`;
}

// One request to the server. Resolves the parsed JSON (null for an empty 204), or throws a
// ServerError whose message can be shown to a person as it is.
async function serverRequest(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${serverBaseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ServerError(0, 'offline', "Couldn't reach Watchlog. Check your connection and try again.");
  }
  if (response.status === 204) return null;

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    // Not the Watchlog API at all (e.g. the app served from a plain local file server).
    throw new ServerError(response.status, 'unavailable', "Online accounts aren't available here.");
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After')) || null;
    const message = (data && data.message) || `Something went wrong (error ${response.status}). Try again.`;
    throw new ServerError(response.status, (data && data.error) || 'error', message + (response.status === 429 ? waitText(retryAfter) : ''), retryAfter);
  }
  return data;
}

// A name for this device in the account's device list: "iPhone (web app)", "Android app",
// "Chrome on Windows". The person never types it.
function guessDeviceName() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const device = /iPad/.test(ua) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  if (isNativeAppPlatform()) return `${device} app`;
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || (typeof navigator !== 'undefined' && navigator.standalone);
  if (standalone) return `${device} (web app)`;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : null;
  return browser ? `${browser} on ${device}` : device;
}

// ---------- The account key ----------

// Same reading rules as the server (server/src/auth.js): case, spaces and dashes don't matter,
// and O/0, I/L/1 are the same character.
function normalizeAccountCode(input) {
  return String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function formatAccountKey(key) {
  const clean = normalizeAccountCode(key);
  return clean ? clean.match(/.{1,4}/g).join('-') : '';
}

// The "did you save it?" check: the last 4 characters of the key, typed back.
const KEY_CONFIRM_LENGTH = 4;

function accountKeyConfirmMatches(key, typed) {
  const clean = normalizeAccountCode(key);
  const answer = normalizeAccountCode(typed);
  return answer.length === KEY_CONFIRM_LENGTH && clean.endsWith(answer);
}

// ---------- Linking profiles and accounts ----------

// The profile on this device linked to an account (signed in, or signed out by the server).
// A copy kept at sign-out isn't one: it's an ordinary offline profile from then on, and signing
// in again makes a new profile that starts from the account (decided with the user), so nothing
// done in the copy reaches the account.
function profileForAccount(accountId) {
  return getProfiles().find(p => p.account && p.account.id === accountId) || null;
}

// Puts a sign-in response (create, key, or pairing code) on a profile.
function linkProfileToAccount(profileId, signIn, { accountKey = null, keySaved = false } = {}) {
  const existing = (getProfiles().find(p => p.id === profileId) || {}).account || {};
  const sameAccount = existing.id === signIn.account.id;
  const account = {
    id: signIn.account.id,
    displayName: signIn.account.displayName,
    sessionId: signIn.session.id,
    sessionToken: signIn.token,
    accountKey: accountKey ? formatAccountKey(accountKey) : (sameAccount ? existing.accountKey || null : null),
    keySavedAt: keySaved ? new Date().toISOString() : (sameAccount ? existing.keySavedAt || null : null),
    linkedAt: sameAccount && existing.linkedAt ? existing.linkedAt : new Date().toISOString(),
  };
  return updateProfile(profileId, { account });
}

// Back to an offline profile: the library stays on the device as a separate copy.
function unlinkProfileAccount(profileId) {
  return updateProfile(profileId, { account: null });
}

function markAccountKeySaved(profileId) {
  const profile = getProfiles().find(p => p.id === profileId);
  if (!profile || !profile.account) return null;
  return updateProfile(profileId, { account: { ...profile.account, keySavedAt: new Date().toISOString() } });
}

function isSignedIn(profile) {
  return Boolean(profile && profile.account && profile.account.sessionToken);
}

// ---------- Signing in ----------

function createOnlineAccount(displayName) {
  return serverRequest('POST', '/v1/accounts', { body: { displayName, deviceName: guessDeviceName() } });
}

function signInWithAccountKey(accountKey) {
  return serverRequest('POST', '/v1/sessions', { body: { accountKey, deviceName: guessDeviceName() } });
}

function signInWithPairingCode(code) {
  return serverRequest('POST', '/v1/sessions/pair', { body: { code, deviceName: guessDeviceName() } });
}

// Ends a session that was never attached to a profile (a sign-in abandoned halfway).
function discardSignIn(signIn) {
  if (!signIn || !signIn.token) return Promise.resolve();
  return serverRequest('DELETE', '/v1/session', { token: signIn.token }).catch(() => {});
}

// ---------- Signed-in requests ----------

// A request as the profile's account. If the server says this device is signed out (session
// expired or removed from another device), the profile keeps its account but loses the token,
// so Settings can offer to sign in again.
async function accountRequest(profile, method, path, body) {
  if (!isSignedIn(profile)) throw new ServerError(401, 'signed_out', 'This device is signed out. Sign in again.');
  try {
    return await serverRequest(method, path, { body, token: profile.account.sessionToken });
  } catch (error) {
    if (error.code === 'signed_out') {
      const current = getProfiles().find(p => p.id === profile.id);
      if (current && current.account) updateProfile(profile.id, { account: { ...current.account, sessionToken: null } });
    }
    throw error;
  }
}

async function refreshOnlineAccount(profile) {
  const data = await accountRequest(profile, 'GET', '/v1/account');
  const current = getProfiles().find(p => p.id === profile.id);
  updateProfile(profile.id, { account: { ...current.account, displayName: data.account.displayName } });
  return data;
}

// A new key: the old one stops working. The new key is kept on this device until it's saved.
async function makeNewAccountKey(profile) {
  const data = await accountRequest(profile, 'POST', '/v1/account/key');
  const current = getProfiles().find(p => p.id === profile.id);
  updateProfile(profile.id, { account: { ...current.account, accountKey: formatAccountKey(data.accountKey), keySavedAt: null } });
  return data;
}

function createPairingCode(profile) {
  return accountRequest(profile, 'POST', '/v1/pairing-codes');
}

async function listAccountDevices(profile) {
  return (await accountRequest(profile, 'GET', '/v1/sessions')).sessions;
}

function signOutAccountDevice(profile, sessionId) {
  return accountRequest(profile, 'DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`);
}

// Signs this device out and turns the profile back into an offline one. The library stays.
// The profile is unlinked even if the server can't be reached or already signed it out.
async function signOutOnlineAccount(profile) {
  try {
    if (isSignedIn(profile)) await accountRequest(profile, 'DELETE', '/v1/session');
  } catch (error) {
    if (error.code !== 'signed_out' && error.code !== 'offline') throw error;
  }
  return unlinkProfileAccount(profile.id);
}

// Deletes the account on the server (every device is signed out); this profile stays as an
// offline profile with its library.
async function deleteOnlineAccount(profile) {
  await accountRequest(profile, 'DELETE', '/v1/account');
  return unlinkProfileAccount(profile.id);
}
