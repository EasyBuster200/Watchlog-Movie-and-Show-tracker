import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlEncode, base64UrlDecode, vapidAuthorization, encryptPayload, sendWebPush, generateVapidKeys,
  MAX_PAYLOAD_BYTES,
} from '../src/webpush.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// RFC 8291 section 5 and Appendix A, copied from the RFC text (line breaks joined). The RFC's
// "application server" keys are what encryptPayload calls senderKeys; the "user agent" keys are
// the browser's subscription (p256dh = ua_public, with ua_private only needed to decrypt).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign(
    'HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data,
  ));
  return (await hmac(await hmac(salt, ikm), concat(info, new Uint8Array([1])))).slice(0, length);
}

// The browser's side of RFC 8291, written independently of webpush.js so the round trip checks
// the sender against the standard rather than against itself.
async function decryptPayload(body, uaPublic, uaPrivateKey, authSecret) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
  // Strip padding: trailing zeros, then the delimiter, which must be 0x02 for the last record.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  assert.equal(record[end], 2);
  return record.slice(0, end);
}

async function browserSubscription() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    uaPublic,
    auth,
    keys: { p256dh: base64UrlEncode(uaPublic), auth: base64UrlEncode(auth) },
  };
}

function decodeJwtPart(part) {
  return JSON.parse(decoder.decode(base64UrlDecode(part)));
}

async function verifyJwt(jwt, publicKey) {
  const [header, claims, signature] = jwt.split('.');
  const key = await crypto.subtle.importKey('raw', base64UrlDecode(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64UrlDecode(signature), encoder.encode(`${header}.${claims}`));
}

function parseAuthorization(value) {
  const match = /^vapid t=([^,\s]+), k=([A-Za-z0-9_-]+)$/.exec(value);
  assert.ok(match, `unexpected Authorization header: ${value}`);
  return { jwt: match[1], k: match[2] };
}

test('base64url round-trips bytes and ignores whitespace', () => {
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1, 2]);
  const encoded = base64UrlEncode(bytes);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(base64UrlDecode(encoded), bytes);
  assert.deepEqual(base64UrlDecode(` ${encoded.slice(0, 3)}\n ${encoded.slice(3)} `), bytes);
});

test('encryptPayload reproduces the RFC 8291 test vector exactly', async () => {
  const body = await encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.authSecret }, {
    salt: base64UrlDecode(RFC.salt),
    senderKeys: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
  });
  assert.ok(body instanceof Uint8Array);
  assert.equal(body.length, 144);
  assert.equal(base64UrlEncode(body), RFC.body);
});

test('the RFC vector also decrypts with the receiver side used in these tests', async () => {
  const uaPublic = base64UrlDecode(RFC.uaPublic);
  const uaPrivateKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: RFC.uaPrivate,
    x: base64UrlEncode(uaPublic.slice(1, 33)), y: base64UrlEncode(uaPublic.slice(33)),
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const plaintext = await decryptPayload(base64UrlDecode(RFC.body), uaPublic, uaPrivateKey, base64UrlDecode(RFC.authSecret));
  assert.equal(decoder.decode(plaintext), RFC.plaintext);
});

test('a message encrypted with random salt and keys decrypts back for the browser', async () => {
  const browser = await browserSubscription();
  const message = JSON.stringify({ title: 'New episode', body: 'S02E05 is out', url: '/detail.html?type=tv&id=1' });
  const first = await encryptPayload(message, browser.keys);
  const second = await encryptPayload(message, browser.keys);
  assert.notEqual(base64UrlEncode(first), base64UrlEncode(second), 'salt and sender key are fresh each time');
  const plaintext = await decryptPayload(first, browser.uaPublic, browser.privateKey, browser.auth);
  assert.equal(decoder.decode(plaintext), message);

  const bytes = crypto.getRandomValues(new Uint8Array(100));
  assert.deepEqual(await decryptPayload(await encryptPayload(bytes, browser.keys), browser.uaPublic, browser.privateKey, browser.auth), bytes);
});

test('the largest payload fits in 4096 bytes, and a bigger one is refused', async () => {
  const browser = await browserSubscription();
  const body = await encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES), browser.keys);
  assert.equal(body.length, 4096);
  await assert.rejects(encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1), browser.keys), /Push payload/);
});

test('the VAPID header carries a signed JWT for the push service origin and our public key', async () => {
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const value = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def?x=1', vapid, now);
  const { jwt, k } = parseAuthorization(value);
  assert.equal(k, vapid.publicKey);
  const [header, claims] = jwt.split('.');
  assert.deepEqual(decodeJwtPart(header), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(decodeJwtPart(claims), {
    aud: 'https://fcm.googleapis.com',
    exp: now / 1000 + 12 * 60 * 60,
    sub: 'mailto:owner@example.com',
  });
  assert.equal(base64UrlDecode(jwt.split('.')[2]).length, 64, 'raw r||s, not DER');
  assert.equal(await verifyJwt(jwt, vapid.publicKey), true);

  const other = await generateVapidKeys();
  assert.equal(await verifyJwt(jwt, other.publicKey), false);
});

test('the VAPID expiry defaults to 12 hours from now', async () => {
  const vapid = { ...(await generateVapidKeys()), subject: 'https://example.com' };
  const before = Math.floor(Date.now() / 1000);
  const { jwt } = parseAuthorization(await vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/x', vapid));
  const { exp, aud } = decodeJwtPart(jwt.split('.')[1]);
  assert.equal(aud, 'https://updates.push.services.mozilla.com');
  assert.ok(exp >= before + 12 * 3600 && exp <= before + 12 * 3600 + 5);
});

test('sendWebPush posts the encrypted body with the push headers', async () => {
  const browser = await browserSubscription();
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  const subscription = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: browser.keys };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 201 });
  };

  const result = await sendWebPush(subscription, 'hello', vapid, { fetchImpl, ttl: 3600, urgency: 'high', topic: 'show-1399' });
  assert.deepEqual(result, { ok: true, status: 201, gone: false });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, subscription.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.TTL, '3600');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers.Topic, 'show-1399');
  assert.ok(init.headers.Authorization.startsWith('vapid t='));
  const { jwt } = parseAuthorization(init.headers.Authorization);
  assert.equal(decodeJwtPart(jwt.split('.')[1]).aud, 'https://web.push.apple.com');
  assert.ok(init.body instanceof Uint8Array || init.body instanceof ArrayBuffer);
  const plaintext = await decryptPayload(new Uint8Array(init.body), browser.uaPublic, browser.privateKey, browser.auth);
  assert.equal(decoder.decode(plaintext), 'hello');
});

test('sendWebPush uses the defaults, and reports dead subscriptions as gone', async () => {
  const browser = await browserSubscription();
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: browser.keys };
  for (const [status, expected] of [[201, { ok: true, gone: false }], [410, { ok: false, gone: true }],
    [404, { ok: false, gone: true }], [429, { ok: false, gone: false }], [500, { ok: false, gone: false }]]) {
    let seen;
    const fetchImpl = async (url, init) => { seen = init; return new Response(null, { status }); };
    const result = await sendWebPush(subscription, 'x', vapid, { fetchImpl });
    assert.deepEqual(result, { ...expected, status });
    assert.equal(seen.headers.TTL, '86400');
    assert.equal(seen.headers.Urgency, 'normal');
    assert.equal('Topic' in seen.headers, false);
  }
});

test('generateVapidKeys makes keys in the browser formats that sign verifiable JWTs', async () => {
  const keys = await generateVapidKeys();
  const publicKey = base64UrlDecode(keys.publicKey);
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 0x04);
  assert.equal(base64UrlDecode(keys.privateKey).length, 32);
  assert.notEqual((await generateVapidKeys()).privateKey, keys.privateKey);
  const { jwt } = parseAuthorization(await vapidAuthorization('https://push.example.net/x', { ...keys, subject: 'mailto:a@b.c' }));
  assert.equal(await verifyJwt(jwt, keys.publicKey), true);
});
