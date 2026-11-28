// The bot check's frame (turnstile.html; server/src/turnstile.js has the why). The screen that
// frames it passes the site key and theme in the address's #fragment; this renders Cloudflare
// Turnstile and posts { source: 'watchlog-turnstile', token | error | height } back to it.
//
// Only two parents are told anything: this site itself (the web app) and the Android app
// (https://localhost). postMessage drops a message whose target origin doesn't match the parent,
// so sending to both is safe.

(function () {
  const PARENT_ORIGINS = [window.location.origin, 'https://localhost'];
  const params = new URLSearchParams(window.location.hash.slice(1));
  const siteKey = params.get('sitekey');
  const theme = ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : 'auto';

  function tell(message) {
    if (window.parent === window) return;
    PARENT_ORIGINS.forEach(origin => {
      try { window.parent.postMessage({ source: 'watchlog-turnstile', ...message }, origin); } catch (error) { /* not that parent */ }
    });
  }

  function reportHeight() {
    tell({ height: Math.ceil(document.getElementById('check').getBoundingClientRect().height) });
  }

  window.watchlogTurnstileLoaded = function () {
    if (!siteKey) { tell({ error: 'no_site_key' }); return; }
    window.turnstile.render('#check', {
      sitekey: siteKey,
      theme,
      size: 'flexible',
      callback: token => tell({ token }),
      'error-callback': () => { tell({ error: 'failed' }); return true; },
      'expired-callback': () => tell({ expired: true }),
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(reportHeight).observe(document.getElementById('check'));
    reportHeight();
  };

  // Turnstile's script couldn't load (offline, blocked): say so instead of waiting forever.
  window.addEventListener('load', () => {
    setTimeout(() => { if (!window.turnstile) tell({ error: 'not_loaded' }); }, 8000);
  });
}());
