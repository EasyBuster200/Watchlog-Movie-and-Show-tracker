// Cloudflare Turnstile (admin page part 2): a bot check before the server sends an email code
// (sign-up and "Lost your key?"), since those are what a script could abuse: they send emails
// to any address. Creating the account itself needs that emailed code, so it isn't checked again.
//
// On only when both are set: the var TURNSTILE_SITE_KEY (public) and the secret
// TURNSTILE_SECRET_KEY. Without them (tests, local, previews) nothing is checked.
//
// The widget runs on this site's own page, public/turnstile.html, which the sign-in screens show
// in a frame: Turnstile needs a real domain name, and the Android app's pages come from
// https://localhost. The page's token reaches the screen by postMessage, and is sent here as
// `turnstileToken`.

import { ApiError } from './router.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled(env) {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

export function turnstileSiteKey(env) {
  return turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY : null;
}

export async function verifyTurnstile(env, request, token, { fetchImpl = fetch } = {}) {
  if (!turnstileEnabled(env)) return;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    throw new ApiError(400, 'bot_check_needed', "Complete the check that you're not a robot, then try again.");
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  let result;
  try {
    const response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body: form });
    result = await response.json();
  } catch (error) {
    console.error('Turnstile siteverify failed', error && error.message ? error.message : error);
    throw new ApiError(503, 'bot_check_unavailable', "The check that you're not a robot isn't working right now. Try again in a minute.");
  }
  if (!result || result.success !== true) {
    throw new ApiError(403, 'bot_check_failed', "The check that you're not a robot didn't pass. Try again.");
  }
}
