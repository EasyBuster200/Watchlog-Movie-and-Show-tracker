// Makes a new VAPID key pair for Web Push and prints it; nothing is written to disk.
// Run: node tools/make-vapid-keys.mjs   (Node 20+)
// Replacing the keys later breaks every existing push subscription (browsers subscribed with the
// old public key), so make them once and keep both backed up (a password manager).
import { generateVapidKeys } from '../server/src/webpush.js';

const { publicKey, privateKey } = await generateVapidKeys();

console.log('Add both to the watchlog Worker as secrets (Cloudflare dashboard > Workers & Pages >');
console.log('watchlog > Settings > Variables and Secrets > Add, type Secret, Production tab):');
console.log('');
console.log('VAPID_PUBLIC_KEY');
console.log(publicKey);
console.log('');
console.log('VAPID_PRIVATE_KEY (never in the repo or a chat)');
console.log(privateKey);
