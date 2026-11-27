// Friends' activity (activity.html, "See all" on Home's Friends section): everything friends
// watched, favourited and saved in the last 30 days (friendActivity.js).

document.addEventListener('DOMContentLoaded', async () => {
  await requireLogin();
  const list = document.getElementById('activity-list');
  const count = document.getElementById('activity-count');
  const shown = await renderFriendActivity(list);
  if (shown === null) {
    const profile = getActiveProfile();
    const note = el('p', 'empty-note', profile.account
      ? 'Add friends on the Friends page to see what they watch.'
      : 'Friends need an online account.');
    list.appendChild(note);
    const link = el('a', 'tt-btn tt-btn--secondary', 'Open Friends');
    link.href = 'friends.html';
    list.appendChild(link);
    return;
  }
  count.textContent = shown ? 'Last 30 days' : ' ';
});
