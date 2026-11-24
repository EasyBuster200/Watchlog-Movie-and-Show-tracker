// The app's side of online accounts (public/scripts/serverApi.js), against a fake Watchlog server.
// The real server's behaviour is tested in server/test/accounts.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const KEY = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345';

function signInReply(overrides = {}) {
  return {
    status: 201,
    body: {
      account: { id: 'acc-1', displayName: 'Ana', createdAt: '2026-11-24T10:00:00.000Z', keyChangedAt: '2026-11-24T10:00:00.000Z' },
      session: { id: 'sess-1', deviceName: 'Test', current: true },
      token: 'token-1',
      ...overrides,
    },
  };
}

// A small fake server: replies by "METHOD /path".
function fakeServer(routes) {
  return (method, path, req) => {
    const handler = routes[`${method} ${path}`];
    if (!handler) return { status: 404, body: { error: 'not_found', message: 'Not found.' } };
    return typeof handler === 'function' ? handler(req) : handler;
  };
}

const activeAccount = app => JSON.parse(JSON.stringify(app.run('getActiveProfile().account')));

test('online accounts stay hidden unless switched on for testing', () => {
  const app = createApp();
  assert.equal(app.run('onlineAccountsEnabled()'), false);
  app.context.localStorage.setItem('watchlog_preview_online_accounts', '1');
  assert.equal(app.run('onlineAccountsEnabled()'), true);
});

test('the web app uses its own address; the Android app the production server; an override wins', () => {
  assert.equal(createApp().run('serverBaseUrl()'), 'http://localhost');
  const native = createApp({ native: true });
  assert.equal(native.run('serverBaseUrl()'), 'https://watchlog.duartecruzcoelho.workers.dev');
  native.context.localStorage.setItem('watchlog_server_url', 'https://pr-9-watchlog.example.dev/');
  assert.equal(native.run('serverBaseUrl()'), 'https://pr-9-watchlog.example.dev');
});

test('creating an account links it to the profile, with the key this device was given', async () => {
  const app = createApp({ server: fakeServer({ 'POST /v1/accounts': signInReply({ accountKey: KEY.toLowerCase() }) }) });
  await app.run("createOnlineAccount('Ana').then(r => linkProfileToAccount(getActiveProfileId(), r, { accountKey: r.accountKey }))");

  const [request] = app.serverRequests;
  assert.equal(request.url, 'http://localhost/v1/accounts');
  assert.equal(request.body.displayName, 'Ana');
  assert.ok(request.body.deviceName, 'the device names itself');

  const account = activeAccount(app);
  assert.equal(account.id, 'acc-1');
  assert.equal(account.sessionToken, 'token-1');
  assert.equal(account.accountKey, KEY, 'kept in its grouped, upper-case form');
  assert.equal(account.keySavedAt, null, 'not saved until the person confirms it');
  assert.equal(app.run("profileForAccount('acc-1').id"), app.run('getActiveProfileId()'));
});

test('signing in again on the same profile keeps what was already known about the key', async () => {
  const app = createApp({ server: fakeServer({ 'POST /v1/sessions': signInReply({ token: 'token-2' }) }) });
  const id = app.run('getActiveProfileId()');
  app.run(`linkProfileToAccount('${id}', ${JSON.stringify(signInReply().body)}, { accountKey: '${KEY}' })`);
  app.run(`markAccountKeySaved('${id}')`);
  const before = activeAccount(app);

  await app.run(`signInWithAccountKey('${KEY}').then(r => linkProfileToAccount('${id}', r))`);
  const after = activeAccount(app);
  assert.equal(after.sessionToken, 'token-2');
  assert.equal(after.accountKey, KEY);
  assert.equal(after.keySavedAt, before.keySavedAt);
  assert.equal(after.linkedAt, before.linkedAt);
});

test('signed-in requests send the session token; a signed-out reply clears it but keeps the account', async () => {
  let signedIn = true;
  const app = createApp({
    server: fakeServer({
      'GET /v1/account': () => (signedIn
        ? { body: { account: { id: 'acc-1', displayName: 'Ana B.' }, session: { id: 'sess-1' } } }
        : { status: 401, body: { error: 'signed_out', message: 'This device is signed out. Sign in again.' } }),
    }),
  });
  const id = app.run('getActiveProfileId()');
  app.run(`linkProfileToAccount('${id}', ${JSON.stringify(signInReply().body)})`);

  await app.run('refreshOnlineAccount(getActiveProfile())');
  assert.equal(app.serverRequests[0].headers.Authorization, 'Bearer token-1');
  assert.equal(activeAccount(app).displayName, 'Ana B.', 'a rename on another device shows up');

  signedIn = false;
  await assert.rejects(app.run('refreshOnlineAccount(getActiveProfile())'), error => error.code === 'signed_out');
  const account = activeAccount(app);
  assert.equal(account.sessionToken, null);
  assert.equal(account.id, 'acc-1');
  assert.equal(app.run('isSignedIn(getActiveProfile())'), false);
  await assert.rejects(app.run('createPairingCode(getActiveProfile())'), error => error.code === 'signed_out', 'nothing is sent once signed out');
  assert.equal(app.serverRequests.length, 2);
});

test('errors come back as messages a person can read', async () => {
  const offline = createApp(); // no server: every request fails like a dropped connection
  await assert.rejects(offline.run("signInWithAccountKey('x')"), error => error.code === 'offline' && /connection/.test(error.message));

  const limited = createApp({ server: () => ({ status: 429, headers: { 'Retry-After': '90' }, body: { error: 'too_many_requests', message: 'Too many attempts. Wait a little and try again.' } }) });
  await assert.rejects(limited.run("signInWithAccountKey('x')"), error => error.status === 429 && /about 2 minutes/.test(error.message));

  const wrong = createApp({ server: () => ({ status: 401, body: { error: 'wrong_key', message: 'No account has that key.' } }) });
  await assert.rejects(wrong.run("signInWithAccountKey('x')"), error => error.code === 'wrong_key' && error.message === 'No account has that key.');

  const notWatchlog = createApp({ server: () => ({ status: 404, text: '<html>Not found</html>' }) });
  await assert.rejects(notWatchlog.run("signInWithAccountKey('x')"), error => error.code === 'unavailable');
});

test('a new key replaces the stored one and has to be saved again', async () => {
  const app = createApp({ server: fakeServer({ 'POST /v1/account/key': { body: { accountKey: 'ZZZZ-YYYY-XXXX-WWWW-VVVV-TTTT-SSSS', account: {} } } }) });
  const id = app.run('getActiveProfileId()');
  app.run(`linkProfileToAccount('${id}', ${JSON.stringify(signInReply().body)}, { accountKey: '${KEY}', keySaved: true })`);
  await app.run('makeNewAccountKey(getActiveProfile())');
  const account = activeAccount(app);
  assert.equal(account.accountKey, 'ZZZZ-YYYY-XXXX-WWWW-VVVV-TTTT-SSSS');
  assert.equal(account.keySavedAt, null);
});

test('signing out turns the profile back into an offline one, even if the server already forgot it', async () => {
  for (const reply of [{ status: 204 }, { status: 401, body: { error: 'signed_out', message: 'x' } }]) {
    const app = createApp({ server: fakeServer({ 'DELETE /v1/session': reply }) });
    const id = app.run('getActiveProfileId()');
    app.run(`linkProfileToAccount('${id}', ${JSON.stringify(signInReply().body)})`);
    await app.run('signOutOnlineAccount(getActiveProfile())');
    assert.equal(app.run('getActiveProfile().account'), null);
    assert.equal(app.run('getActiveProfile().tmdbApiKey'), 'test-key', 'the profile itself is untouched');
  }

  const offline = createApp();
  const id = offline.run('getActiveProfileId()');
  offline.run(`linkProfileToAccount('${id}', ${JSON.stringify(signInReply().body)})`);
  await offline.run('signOutOnlineAccount(getActiveProfile())');
  assert.equal(offline.run('getActiveProfile().account'), null, 'signing out works offline too');
});

test('deleting the online account keeps the profile and its library on this device', async () => {
  const app = createApp({ server: fakeServer({ 'DELETE /v1/account': { status: 204 } }) });
  await app.api('POST', '/api/watched/movies/1', { title: 'Kept' });
  const id = app.run('getActiveProfileId()');
  app.run(`linkProfileToAccount('${id}', ${JSON.stringify(signInReply().body)})`);
  await app.run('deleteOnlineAccount(getActiveProfile())');
  assert.equal(app.serverRequests[0].method, 'DELETE');
  assert.equal(app.run('getActiveProfile().account'), null);
  assert.equal((await app.getAll('watched_movies')).length, 1);
});

test('an abandoned sign-in is ended on the server', async () => {
  const app = createApp({ server: fakeServer({ 'DELETE /v1/session': { status: 204 } }) });
  await app.run(`discardSignIn(${JSON.stringify(signInReply().body)})`);
  assert.equal(app.serverRequests[0].headers.Authorization, 'Bearer token-1');
});

test('the save-your-key check: the last 4 characters, as a person might type them', () => {
  const app = createApp();
  const key = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2O45'.replace('O', '0');
  assert.equal(app.run(`accountKeyConfirmMatches('${key}', '2045')`), true);
  assert.equal(app.run(`accountKeyConfirmMatches('${key}', '2o45')`), true, 'O for 0');
  assert.equal(app.run(`accountKeyConfirmMatches('${key}', '2-04 5')`), true);
  assert.equal(app.run(`accountKeyConfirmMatches('${key}', '2046')`), false);
  assert.equal(app.run(`accountKeyConfirmMatches('${key}', '45')`), false, 'exactly 4');
  assert.equal(app.run("formatAccountKey('abcdefghjk')"), 'ABCD-EFGH-JK');
});
