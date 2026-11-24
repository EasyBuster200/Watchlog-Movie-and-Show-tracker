// Web app (PWA) setup: registers the service worker (sw.js) so the app opens offline, and asks
// the browser to keep this site's storage, so IndexedDB (the whole library) isn't cleared when
// the phone runs low on space. Does nothing in the Android app: Capacitor serves the files from
// the APK, and a service worker there would only get in the way.
(function () {
  const isNative = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (isNative) return;

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(error => console.warn('Service worker registration failed:', error));
    });
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
      .then(persisted => persisted || navigator.storage.persist())
      .catch(() => {});
  }
})();
