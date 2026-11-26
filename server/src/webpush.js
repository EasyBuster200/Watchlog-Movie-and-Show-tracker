// Web Push, sent straight from the Worker with nothing but Web Crypto and fetch (no library, so
// no dependencies and nothing Node-only). Two standards are involved:
//
// - RFC 8292 (VAPID): every request carries a short-lived JWT signed with our own P-256 key, so
//   the push service (Google's, Mozilla's, Apple's) knows the messages come from the same server
//   the browser subscribed with. The public half is VAPID_PUBLIC_KEY (also given to the browser
//   when it subscribes), the private half the Worker secret VAPID_PRIVATE_KEY.
//   tools/make-vapid-keys.mjs makes a pair.
// - RFC 8291 (message encryption): the push service must not be able to read the message, so it's
//   encrypted for the browser's own key (the subscription's p256dh and auth values), using the
//   "aes128gcm" content coding from RFC 8188.
//
// Key formats used throughout (the same ones browsers use): a public key is the base64url
// uncompressed P-256 point (65 bytes, starting 0x04), a private key the base64url 32-byte scalar.

const encoder = new TextEncoder();

// Push services only promise to carry 4096 bytes of body, and the body is the 86-byte header plus
// the record (plaintext, one padding delimiter byte, 16-byte AES-GCM tag). RFC 8291 section 4
// gives the same figure: 3993 bytes of plaintext at most.
export const RECORD_SIZE = 4096;
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 86 - 1 - 16;

// JWTs live 12 hours: RFC 8292 allows up to 24, and some push services refuse anything close to it.
export const VAPID_EXPIRY_SECONDS = 12 * 60 * 60;

export function base64UrlEncode(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < array.length; i++) binary += String.fromCharCode(array[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(string) {
  // Whitespace is dropped so keys copied with line breaks (as in the RFCs) still work, and plain
  // base64 ('+', '/', padding) is accepted too, since some tools print keys that way.
  const clean = String(string).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function publicKeyBytes(publicKey) {
  const bytes = base64UrlDecode(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('A P-256 public key must be a 65-byte uncompressed point starting with 0x04');
  }
  return bytes;
}

// Web Crypto can't import a bare private scalar, only a JWK, which needs the public point's x and
// y alongside d. Those are the two 32-byte halves of the uncompressed public key.
function privateJwk(publicKey, privateKey) {
  const point = publicKeyBytes(publicKey);
  const d = base64UrlDecode(privateKey);
  if (d.length !== 32) throw new Error('A P-256 private key must be 32 bytes');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(point.slice(1, 33)),
    y: base64UrlEncode(point.slice(33, 65)),
    d: base64UrlEncode(d),
    ext: true,
  };
}

async function hmac(key, data) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

// HKDF with a single output block (we never need more than 32 bytes), written out so each step
// lines up with RFC 8291's description and its test vector.
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

export async function vapidAuthorization(endpoint, vapid, now = Date.now()) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_EXPIRY_SECONDS,
    sub: vapid.subject,
  };
  const unsigned = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    'jwk', privateJwk(vapid.publicKey, vapid.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  // Web Crypto's ECDSA signature is already the raw r||s form that JWS's ES256 wants (not DER).
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

export async function encryptPayload(payload, subscriptionKeys, options = {}) {
  const plaintext = typeof payload === 'string' ? encoder.encode(payload) : new Uint8Array(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload is ${plaintext.length} bytes; the most is ${MAX_PAYLOAD_BYTES}`);
  }
  const uaPublic = publicKeyBytes(subscriptionKeys.p256dh);
  const authSecret = base64UrlDecode(subscriptionKeys.auth);
  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));

  // A fresh ECDH key pair per message (the "application server" keys in RFC 8291), unless a test
  // hands in the RFC's fixed ones.
  let asPublic;
  let asPrivateKey;
  if (options.senderKeys) {
    asPublic = publicKeyBytes(options.senderKeys.publicKey);
    asPrivateKey = await crypto.subtle.importKey(
      'jwk', privateJwk(options.senderKeys.publicKey, options.senderKeys.privateKey),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
    );
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivateKey = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256));

  // RFC 8291 section 3.4: mix the browser's auth secret into the shared secret, then RFC 8188's
  // key and nonce derivation from that, with the salt.
  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // One record, so it is also the last: padding delimiter 0x02 and no further padding.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  // Header: salt, record size (big-endian uint32), key id length, key id = our ephemeral public key.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

export async function sendWebPush(subscription, payload, vapid, { fetchImpl = fetch, ttl = 86400, urgency = 'normal', topic } = {}) {
  const body = await encryptPayload(payload, subscription.keys);
  const headers = {
    TTL: String(ttl),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Urgency: urgency,
    Authorization: await vapidAuthorization(subscription.endpoint, vapid),
  };
  // A topic lets the push service replace an undelivered message with a newer one of the same topic.
  if (topic) headers.Topic = topic;
  const response = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
  // 404 and 410 mean the browser unsubscribed or the subscription expired: it will never work
  // again, so the caller should forget it. Anything else (429, 5xx) may be temporary.
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey, privateKey: d };
}
