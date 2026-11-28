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
//     status,                     'active', or 'pending' while waiting for the owner's approval
//     isAdmin,                    the owner (the server's ADMIN_ACCOUNT_IDS): sees the admin page
//     pendingRequests,            for the owner: sign-up requests waiting (from each sync)
//     linkedAt }
// The profile's library stays in its own IndexedDB database, exactly like an offline profile's;
// sync.js keeps it the same on the account's other devices.
//
// Who can make an account is up to the owner (the admin page's sign-up mode: closed, invite-only,
// approval or open). In approval mode a new account waits as 'pending' until the owner lets it
// in; the picker's "waiting" screen checks on it.
//
// Load after profiles.js.

const PRODUCTION_SERVER_URL = 'https://watchlogtracker.com';
// Points the app at another server (e.g. a pull request's preview) when set in localStorage.
const SERVER_URL_OVERRIDE_KEY = 'watchlog_server_url';

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
    status: signIn.account.status || 'active',
    email: signIn.account.email || (sameAccount ? existing.email || null : null),
    recovery: sameAccount ? existing.recovery || null : null,
    isAdmin: sameAccount ? Boolean(existing.isAdmin) : false,
    pendingRequests: sameAccount ? existing.pendingRequests || 0 : 0,
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

// Waiting for the owner to approve it: it can't sync or use TMDB yet.
function isPendingAccount(profile) {
  return Boolean(profile && profile.account && profile.account.status === 'pending');
}

function updateAccountFields(profileId, fields) {
  const current = getProfiles().find(p => p.id === profileId);
  if (!current || !current.account) return null;
  return updateProfile(profileId, { account: { ...current.account, ...fields } });
}

// ---------- Signing in ----------

// What the sign-up screen should ask for: { mode: 'closed' | 'invite' | 'approval' | 'open', firstAccount }.
function getSignupMode() {
  return serverRequest('GET', '/v1/signup');
}

// Sign-up step 1: a 6-digit code to the email (roadmap Phase 3c). If the address already has an
// account, the inbox gets a note saying so instead; the answer is the same either way.
function requestSignupCode(email, turnstileToken = null) {
  return serverRequest('POST', '/v1/email-codes', { body: { email, ...(turnstileToken ? { turnstileToken } : {}) } });
}

// ---------- The bot check (Cloudflare Turnstile, server/src/turnstile.js) ----------
// Before an email code is sent, the server may ask for a Turnstile token. The widget runs on
// the server's own page (turnstile.html) in a frame, since Turnstile needs a real domain and the
// Android app's pages come from https://localhost; the frame posts the token back.

let botCheckKeyPromise = null;

// The site key, or null when the server doesn't check (or can't be reached: the request then
// says what's wrong).
function botCheckSiteKey() {
  if (!botCheckKeyPromise) {
    botCheckKeyPromise = serverRequest('GET', '/v1/turnstile')
      .then(reply => (reply && reply.siteKey) || null)
      .catch(() => { botCheckKeyPromise = null; return null; });
  }
  return botCheckKeyPromise;
}

const BOT_CHECK_TIMEOUT_MS = 3 * 60 * 1000;

// Shows the check in `slot` and resolves its token (null when it's off). Usually it passes by
// itself in a second or two; sometimes it asks for a tap. Each token works once, so the frame
// is removed afterwards and the next send runs a fresh check.
async function passBotCheck(slot) {
  const siteKey = await botCheckSiteKey();
  if (!siteKey) return null;
  const base = serverBaseUrl();
  const origin = new URL(base).origin;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const frame = document.createElement('iframe');
  frame.className = 'bot-check__frame';
  frame.title = "Check that you're not a robot";
  frame.src = `${base}/turnstile.html#sitekey=${encodeURIComponent(siteKey)}&theme=${theme}`;
  const note = document.createElement('p');
  note.className = 'bot-check__note';
  note.textContent = "Checking that you're not a robot…";
  slot.replaceChildren(note, frame);
  slot.hidden = false;
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      slot.replaceChildren();
      slot.hidden = true;
      settle(value);
    };
    const fail = () => finish(reject, new ServerError(0, 'bot_check_failed', "The check that you're not a robot didn't work. Check your connection and try again."));
    function onMessage(event) {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      const data = event.data || {};
      if (data.source !== 'watchlog-turnstile') return;
      if (data.height) frame.style.height = `${Math.max(65, data.height)}px`;
      if (data.token) finish(resolve, data.token);
      else if (data.error) fail();
    }
    const timer = setTimeout(fail, BOT_CHECK_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
  });
}

// Step 2: the account, with the code from the email. `inviteCode` lets the person straight in;
// `note` tells the owner who's asking (approval mode).
function createOnlineAccount(displayName, { email, emailCode, inviteCode = null, note = null } = {}) {
  const body = { displayName, deviceName: guessDeviceName(), email, emailCode };
  if (inviteCode) body.inviteCode = inviteCode;
  if (note) body.note = note;
  return serverRequest('POST', '/v1/accounts', { body });
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
    if (error.code === 'signed_out') updateAccountFields(profile.id, { sessionToken: null });
    if (error.code === 'account_pending') updateAccountFields(profile.id, { status: 'pending' });
    throw error;
  }
}

// Fetches the account (name, status, admin), e.g. to see whether a request was approved.
async function refreshOnlineAccount(profile) {
  const data = await accountRequest(profile, 'GET', '/v1/account');
  updateAccountFields(profile.id, {
    displayName: data.account.displayName, status: data.account.status || 'active', isAdmin: Boolean(data.isAdmin),
    email: data.account.email || null, recovery: data.recovery || null,
  });
  return data;
}

// ---------- The account's email (roadmap Phase 3c) ----------

// Changing it: a code goes to the new address, then confirmEmailChange with it. The old address
// is told.
function requestEmailChangeCode(profile, email) {
  return accountRequest(profile, 'POST', '/v1/account/email-code', { email });
}

async function confirmEmailChange(profile, email, code) {
  const data = await accountRequest(profile, 'PUT', '/v1/account/email', { email, code });
  updateAccountFields(profile.id, { email: data.account.email });
  return data;
}

// ---------- Friends (roadmap Phase 7; server/src/routes/friends.js) ----------
// Found by friend code only (decided with the user). What friends see is the account's share
// level: 'everything' (the default), 'lists' (lists and favourites) or 'nothing'.

const SHARE_LEVELS = [
  { value: 'everything', label: 'Everything', sub: 'Your watched movies and shows, favourites, lists and Watchlist' },
  { value: 'lists', label: 'Lists and favourites', sub: 'Not what you watch' },
  { value: 'nothing', label: 'Nothing', sub: 'Friends only see your name' },
];

// { code, shareLevel, friends, incoming, outgoing, blocked }
function getFriends(profile) {
  return accountRequest(profile, 'GET', '/v1/friends');
}

function makeNewFriendCode(profile) {
  return accountRequest(profile, 'POST', '/v1/friends/code');
}

function setShareLevel(profile, shareLevel) {
  return accountRequest(profile, 'PUT', '/v1/friends/settings', { shareLevel });
}

// Resolves { status: 'sent' | 'friends', friend: { id, displayName } }.
function sendFriendRequest(profile, code) {
  return accountRequest(profile, 'POST', '/v1/friends/requests', { code });
}

function acceptFriendRequest(profile, accountId) {
  return accountRequest(profile, 'POST', `/v1/friends/requests/${encodeURIComponent(accountId)}/accept`);
}

// Declines a request from them, or cancels one to them.
function dropFriendRequest(profile, accountId) {
  return accountRequest(profile, 'DELETE', `/v1/friends/requests/${encodeURIComponent(accountId)}`);
}

function removeFriend(profile, accountId) {
  return accountRequest(profile, 'DELETE', `/v1/friends/${encodeURIComponent(accountId)}`);
}

function blockAccount(profile, accountId) {
  return accountRequest(profile, 'POST', `/v1/friends/${encodeURIComponent(accountId)}/block`);
}

function unblockAccount(profile, accountId) {
  return accountRequest(profile, 'DELETE', `/v1/friends/blocks/${encodeURIComponent(accountId)}`);
}

// What a friend shares: { friend, shareLevel, favorites?, lists?, watchlist?, movies?, shows?, tasteMatch? }.
function getFriendLibrary(profile, accountId) {
  return accountRequest(profile, 'GET', `/v1/friends/${encodeURIComponent(accountId)}/library`);
}

// Friends step 2. Whether a page should ask the server about friends at all: a signed-in
// online profile that has friends (the count comes with every sync; unknown counts as maybe).
function canAskAboutFriends(profile) {
  return isSignedIn(profile) && !isPendingAccount(profile) && profile.account.friendCount !== 0;
}

// Which friends watched, favourited or saved a title:
// { friends: [{ id, displayName, watchedAt?, episodes?, latest?: { season, episode }, favorite?, watchlist? }] }.
function getTitleFriends(profile, mediaType, tmdbId) {
  return accountRequest(profile, 'GET', `/v1/friends/title/${encodeURIComponent(mediaType)}/${encodeURIComponent(tmdbId)}`);
}

// What friends did in the last 30 days, newest first: { items, days }. Each item has type
// 'episodes' | 'watched' | 'favorite' | 'watchlist' | 'list', friend, at, mediaType, tmdbId, and
// the title's display fields when the record carries them.
function getFriendActivity(profile) {
  return accountRequest(profile, 'GET', '/v1/friends/activity');
}

// ---------- Recovering an account with its email ----------
// "Lost your key?": a code to the email, then a 24-hour hold (any signed-in device can cancel),
// then this device finishes it and gets a new key. The waiting recoveries are kept on this
// device (localStorage RECOVERIES_KEY: [{ token, email, displayName, completesAt }]) so the
// person can close the app and come back.

const RECOVERIES_KEY = 'watchlog_recoveries';

function pendingRecoveries() {
  try {
    const list = JSON.parse(localStorage.getItem(RECOVERIES_KEY));
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

function saveRecoveries(list) {
  if (list.length) localStorage.setItem(RECOVERIES_KEY, JSON.stringify(list));
  else localStorage.removeItem(RECOVERIES_KEY);
}

function forgetRecovery(token) {
  saveRecoveries(pendingRecoveries().filter(r => r.token !== token));
}

function requestRecoveryCode(email, turnstileToken = null) {
  return serverRequest('POST', '/v1/recovery/code', { body: { email, ...(turnstileToken ? { turnstileToken } : {}) } });
}

async function startRecovery(email, code) {
  const data = await serverRequest('POST', '/v1/recovery', { body: { email, code, deviceName: guessDeviceName() } });
  const entry = { token: data.recoveryToken, email: String(email).trim().toLowerCase(), displayName: data.displayName, completesAt: data.completesAt };
  // A newer recovery of the same account replaces the earlier one on the server too.
  saveRecoveries([...pendingRecoveries().filter(r => r.email !== entry.email), entry]);
  return entry;
}

// Resolves the sign-in (with the new accountKey) once the hold is over. Throws recovery_waiting
// before then; a cancelled or replaced recovery (recovery_cancelled) is forgotten here.
async function completeRecovery(entry) {
  try {
    const signIn = await serverRequest('POST', '/v1/recovery/complete', { body: { recoveryToken: entry.token, deviceName: guessDeviceName() } });
    forgetRecovery(entry.token);
    return signIn;
  } catch (error) {
    if (error.code === 'recovery_cancelled') forgetRecovery(entry.token);
    throw error;
  }
}

// A signed-in device stops someone else's recovery of its account.
async function cancelAccountRecovery(profile) {
  await accountRequest(profile, 'DELETE', '/v1/account/recovery');
  updateAccountFields(profile.id, { recovery: null });
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
  forgetDevicePush(profile);
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
  forgetDevicePush(profile);
  return unlinkProfileAccount(profile.id);
}

// ---------- Notifications on this device (Web Push, roadmap Phase 6) ----------
// The web app gets its notifications from the server (server/src/notifications.js): this
// browser subscribes to Web Push for one signed-in online profile and tells the server which
// kinds it wants (sign-up requests for the owner, new episodes, release reminders, the weekly
// recap), its time zone (for 18:00 local time) and the profile's region (for release dates).
// The switches are per device, like the Android app's (decided with the user), and are
// remembered here in localStorage (PUSH_DEVICE_KEY). A browser has one push subscription, so
// it notifies one account: turning notifications on for another profile moves it there.
// The Android app keeps its own local notifications (notifications.js) and never subscribes.

const PUSH_DEVICE_KEY = 'watchlog_push_device';
const PUSH_KIND_NAMES = ['requests', 'episodes', 'releases', 'recap', 'friends'];

function webPushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' &&
    'PushManager' in window && 'Notification' in window && !isNativeAppPlatform();
}

// iPhone only lets an app added to the Home Screen receive notifications.
function onIphoneBrowserTab() {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  return ios && !standalone;
}

function readPushDevice() {
  try {
    return JSON.parse(localStorage.getItem(PUSH_DEVICE_KEY)) || null;
  } catch (error) {
    return null;
  }
}

// What this device has switched on for this profile (all off for any other profile).
function devicePushKinds(profile) {
  const record = readPushDevice();
  const kinds = {};
  PUSH_KIND_NAMES.forEach(kind => {
    kinds[kind] = Boolean(record && profile && record.profileId === profile.id && record.kinds && record.kinds[kind]);
  });
  return kinds;
}

function forgetDevicePush(profile) {
  const record = readPushDevice();
  if (record && profile && record.profileId === profile.id) localStorage.removeItem(PUSH_DEVICE_KEY);
}

function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (error) {
    return null;
  }
}

function pushKeyBytes(base64Url) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64Url.length % 4)) % 4);
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// Turns kinds on or off for this device ({ episodes: true }, ...); asks for permission when
// something is on. With everything off the subscription is removed. Resolves the kinds now on;
// throws (with a message to show) if it couldn't.
async function setDevicePush(profile, changes) {
  const kinds = { ...devicePushKinds(profile), ...changes };
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!PUSH_KIND_NAMES.some(kind => kinds[kind])) {
    if (subscription) {
      await accountRequest(profile, 'DELETE', '/v1/push/subscription', { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
    localStorage.removeItem(PUSH_DEVICE_KEY);
    return kinds;
  }
  const { publicKey } = await serverRequest('GET', '/v1/push/key');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser or phone settings.');
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(publicKey) });
  }
  const details = { timeZone: deviceTimeZone(), region: typeof profileRegion === 'function' ? profileRegion(profile) : null };
  await accountRequest(profile, 'PUT', '/v1/push/subscription', { ...subscription.toJSON(), kinds, ...details });
  localStorage.setItem(PUSH_DEVICE_KEY, JSON.stringify({ profileId: profile.id, kinds, ...details }));
  return kinds;
}

// Keeps the server's time zone and region for this device current (travel, a new Region in
// Settings). Cheap when nothing changed: no request at all.
async function refreshDevicePush(profile = typeof getActiveProfile === 'function' ? getActiveProfile() : null) {
  const record = readPushDevice();
  if (!record || !profile || record.profileId !== profile.id || !isSignedIn(profile) || !webPushSupported()) return;
  if (Notification.permission !== 'granted') return;
  const region = typeof profileRegion === 'function' ? profileRegion(profile) : null;
  if (record.timeZone === deviceTimeZone() && record.region === region) return;
  await setDevicePush(profile, {});
}

if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.serviceWorker && window.addEventListener) {
  window.addEventListener('load', () => {
    setTimeout(() => refreshDevicePush().catch(error => console.warn('Updating notifications failed:', error)), 3000);
  });
}
