// Kept as getCurrentUser/requireLogin/logout so the existing call sites across the app
// (bookmarks.js, detail.js, lists.js, media.js, profile.js, media-list.js) don't need to change —
// only what backs them did: a local profile (profiles.js) instead of a server session.

// An online account still waiting for the owner's approval can't do anything yet: every page
// sends it to the picker's waiting screen (this runs as each page loads; some pages never call
// requireLogin).
function pendingAccountRedirect(profile = getActiveProfile()) {
  if (typeof isPendingAccount !== 'function' || !isPendingAccount(profile) || !profile.account.sessionToken) return false;
  window.location.replace(`profile-picker.html?screen=waiting&profile=${encodeURIComponent(profile.id)}`);
  return true;
}
pendingAccountRedirect();

async function getCurrentUser() {
  return getActiveProfile();
}

async function requireLogin() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = 'profile-picker.html';
    return null;
  }
  if (pendingAccountRedirect(user)) return null;
  return user;
}

async function logout() {
  clearActiveProfile();
  window.location.href = 'profile-picker.html';
}
