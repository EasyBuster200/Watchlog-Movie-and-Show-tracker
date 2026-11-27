// Friends (roadmap Phase 7, first step; opened from Profile and Settings): your friend code,
// adding a friend by their code, requests both ways, your friends (each opens friend.html),
// what friends can see of your library, and the accounts you blocked. Everything goes through
// serverApi.js to /v1/friends (server/src/routes/friends.js), which enforces every rule.
// Friends need an online account: an offline profile is offered "Make this an online account".

let me = null;

function section(title, { aside = null } = {}) {
  const wrap = el('section', 'stack');
  const head = el('div', 'tt-section');
  head.appendChild(el('h2', null, title));
  if (aside) head.appendChild(aside);
  wrap.appendChild(head);
  const card = el('div', 'settings-card');
  wrap.appendChild(card);
  document.getElementById('friends').appendChild(wrap);
  return card;
}

function smallButton(label, variant, onClick) {
  const b = el('button', `tt-btn tt-btn--${variant} friend-btn`, label);
  b.type = 'button';
  b.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    b.disabled = true;
    try { await onClick(); } finally { b.disabled = false; }
  });
  return b;
}

function initialsOf(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function personRow(person, sub, actions = [], { href = null } = {}) {
  const row = el(href ? 'a' : 'div', 'settings-row friend-row');
  if (href) row.href = href;
  row.appendChild(el('span', 'friend-row__avatar', initialsOf(person.displayName)));
  const text = el('span', 'settings-row__text');
  text.appendChild(el('span', 'settings-row__label', person.displayName));
  if (sub) text.appendChild(el('span', 'settings-row__sub', sub));
  row.appendChild(text);
  if (actions.length) {
    const box = el('span', 'friend-row__actions');
    actions.forEach(a => box.appendChild(a));
    row.appendChild(box);
  } else if (href) {
    const chevron = el('span', 'settings-row__value');
    chevron.innerHTML = ttIcon('chevron', { size: 18 });
    row.appendChild(chevron);
  }
  return row;
}

function shortDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

async function act(action, title) {
  try {
    await action();
    await render();
  } catch (err) {
    await confirmDialog({ title, message: err.message || 'Try again.', confirmLabel: 'OK', cancelLabel: 'Close' });
    await render();
  }
}

function renderMessage(title, text, button) {
  const box = el('div', 'admin-message settings-card');
  box.appendChild(el('h2', null, title));
  box.appendChild(el('p', null, text));
  if (button) box.appendChild(button);
  document.getElementById('friends').appendChild(box);
}

function renderCode(data) {
  const card = section('Your friend code');
  const block = el('div', 'settings-block');
  block.appendChild(el('p', 'friend-code', data.code));
  block.appendChild(el('p', 'settings-row__sub', 'Send it to someone you know so they can add you. Nobody can find you any other way.'));
  const actions = el('div', 'friend-code__actions');
  const status = el('span', 'settings-row__sub');
  actions.appendChild(smallButton('Copy', 'secondary', async () => {
    try {
      await navigator.clipboard.writeText(data.code);
      status.textContent = 'Copied.';
    } catch (err) {
      status.textContent = "Couldn't copy. Select the code instead.";
    }
  }));
  if (navigator.share) {
    actions.appendChild(smallButton('Share', 'secondary', async () => {
      try {
        await navigator.share({ text: `Add me on Watchlog: my friend code is ${data.code}. https://watchlogtracker.com` });
      } catch (err) { /* cancelled */ }
    }));
  }
  actions.appendChild(smallButton('New code', 'ghost', async () => {
    const ok = await confirmDialog({
      title: 'Make a new friend code?',
      message: 'Your current code stops working, so nobody can send you a request with it. Your friends stay your friends.',
      confirmLabel: 'Make a new code',
    });
    if (ok) await act(() => makeNewFriendCode(me), "Couldn't make a new code");
  }));
  actions.appendChild(status);
  block.appendChild(actions);
  card.appendChild(block);
}

function renderAdd() {
  const card = section('Add a friend');
  const form = el('form', 'settings-block');
  form.noValidate = true;
  const field = buildTextField({ label: 'Their friend code', icon: 'user', placeholder: 'XXXX-XXXX', autocomplete: 'off', maxLength: 12 });
  field.input.spellcheck = false;
  field.input.autocapitalize = 'characters';
  form.appendChild(field);
  const submit = el('button', 'tt-btn tt-btn--primary', 'Send request');
  submit.type = 'submit';
  form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const code = field.input.value.trim();
    if (!code) { field.setError('Enter their friend code.'); return; }
    field.setError(null);
    submit.disabled = true;
    try {
      const result = await sendFriendRequest(me, code);
      await confirmDialog({
        title: result.status === 'friends' ? `You and ${result.friend.displayName} are friends` : 'Request sent',
        message: result.status === 'friends'
          ? 'They had already asked you, so you are friends now.'
          : `${result.friend.displayName} will see your request next time they open Watchlog.`,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      await render();
    } catch (err) {
      field.setError(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  card.appendChild(form);
}

function renderRequests(data) {
  if (data.incoming.length) {
    const card = section(`Requests (${data.incoming.length})`);
    data.incoming.forEach(person => card.appendChild(personRow(person, `Asked ${shortDate(person.at)}`, [
      smallButton('Accept', 'primary', () => act(() => acceptFriendRequest(me, person.id), "Couldn't accept")),
      smallButton('Decline', 'secondary', () => act(() => dropFriendRequest(me, person.id), "Couldn't decline")),
    ])));
  }
  if (data.outgoing.length) {
    const card = section('Sent');
    data.outgoing.forEach(person => card.appendChild(personRow(person, `Waiting since ${shortDate(person.at)}`, [
      smallButton('Cancel', 'secondary', () => act(() => dropFriendRequest(me, person.id), "Couldn't cancel")),
    ])));
  }
}

function renderFriendList(data) {
  const card = section(data.friends.length ? `Friends (${data.friends.length})` : 'Friends');
  if (!data.friends.length) {
    const empty = el('div', 'settings-block');
    empty.appendChild(el('p', 'settings-row__sub', 'No friends yet. Share your code, or add a friend with theirs.'));
    card.appendChild(empty);
    return;
  }
  data.friends.forEach(friend => card.appendChild(personRow(friend, `Friends since ${shortDate(friend.since)}`, [], { href: `friend.html?id=${encodeURIComponent(friend.id)}` })));
}

function renderSharing(data) {
  const card = section('What your friends see');
  SHARE_LEVELS.forEach(level => {
    const row = el('button', 'settings-row share-option');
    row.type = 'button';
    row.setAttribute('aria-pressed', String(level.value === data.shareLevel));
    const text = el('span', 'settings-row__text');
    text.appendChild(el('span', 'settings-row__label', level.label));
    text.appendChild(el('span', 'settings-row__sub', level.sub));
    row.appendChild(text);
    const mark = el('span', 'share-option__mark');
    if (level.value === data.shareLevel) mark.innerHTML = ttIcon('check', { size: 18 });
    row.appendChild(mark);
    row.addEventListener('click', () => {
      if (level.value !== data.shareLevel) act(() => setShareLevel(me, level.value), "Couldn't change it");
    });
    card.appendChild(row);
  });
}

function renderBlocked(data) {
  if (!data.blocked.length) return;
  const card = section('Blocked');
  data.blocked.forEach(person => card.appendChild(personRow(person, "Can't send you requests", [
    smallButton('Unblock', 'secondary', () => act(() => unblockAccount(me, person.id), "Couldn't unblock")),
  ])));
}

async function render() {
  me = getActiveProfile();
  const root = document.getElementById('friends');
  if (!me.account) {
    root.innerHTML = '';
    const button = el('a', 'tt-btn tt-btn--primary', 'Make this an online account');
    button.href = `profile-picker.html?screen=create&upgrade=${encodeURIComponent(me.id)}`;
    renderMessage('Friends need an online account', 'Friends find each other with a friend code, and see each other\'s libraries through the account. Your offline profile stays on this device.', button);
    return;
  }
  if (!isSignedIn(me)) {
    root.innerHTML = '';
    const button = el('a', 'tt-btn tt-btn--primary', 'Sign in');
    button.href = 'profile-picker.html?screen=signin';
    renderMessage('Signed out', 'Sign in to your online account again to see your friends.', button);
    return;
  }
  let data;
  try {
    data = await getFriends(me);
  } catch (err) {
    root.innerHTML = '';
    renderMessage("Couldn't load your friends", err.message || 'Try again in a moment.');
    return;
  }
  updateAccountFields(me.id, { friendRequests: data.incoming.length, friendCount: data.friends.length });
  root.innerHTML = '';
  renderRequests(data);
  renderFriendList(data);
  renderCode(data);
  renderAdd();
  renderSharing(data);
  renderBlocked(data);
}

document.addEventListener('DOMContentLoaded', async () => {
  await requireLogin();
  try { sessionStorage.setItem('watchlog_friend_banner_seen', String((getActiveProfile().account || {}).friendRequests || 0)); } catch (error) { /* fine */ }
  render();
});
