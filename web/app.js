// Instagram Sortner - dashboard front end.
// No build step: this is the shipped source. Keep it dependency-free.

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
};

const TOKEN_KEY = 'sortner.token';
const PAGE_SIZE = 60;

const state = {
  search: '',
  status: 'following',
  filters: { nonFollowers: false, verified: false, private: false },
  sort: 'username',
  direction: 'asc',
  offset: 0,
  total: 0,
  loading: false,
  exhausted: false,
  /** Bumped on every query change; stale responses are dropped. */
  generation: 0,
  capabilities: null,
  queue: null,
};

// --- transport -------------------------------------------------------------

function token() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const t = token();
  if (t) headers['x-app-token'] = t;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  }

  const res = await fetch(`/api${path}`, { ...options, headers });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message = payload?.error ?? `Request failed (${res.status})`;
    const error = new Error(message);
    error.code = payload?.code ?? String(res.status);
    error.status = res.status;
    throw error;
  }
  return payload;
}

// --- formatting ------------------------------------------------------------

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat();

function formatCount(value) {
  if (value === null || value === undefined) return '—';
  return value >= 10_000 ? compact.format(value) : plain.format(value);
}

function formatDate(epochSeconds) {
  if (!epochSeconds) return '—';
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function relative(epochSeconds) {
  if (!epochSeconds) return 'never';
  const diff = Math.round(epochSeconds - Date.now() / 1000);
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  return rtf.format(diff, 'second');
}

// --- toasts ----------------------------------------------------------------

function toast(message, kind = '') {
  const node = el('div', { className: `toast ${kind ? `toast--${kind}` : ''}`, textContent: message });
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 6500 : 3200);
}

// --- rendering -------------------------------------------------------------

function avatarNode(account) {
  const initial = (account.username || '?').slice(0, 1).toUpperCase();
  const wrap = el('div', { className: 'avatar', textContent: initial });
  if (!account.profilePicUrl) return wrap;

  const t = token();
  const img = el('img', {
    loading: 'lazy',
    decoding: 'async',
    alt: '',
    src: `/api/avatar/${encodeURIComponent(account.pk)}${t ? `?token=${encodeURIComponent(t)}` : ''}`,
  });
  // Signed CDN URLs expire; when the proxy cannot fetch one, keep the initial.
  img.addEventListener('error', () => img.remove(), { once: true });
  img.addEventListener('load', () => { wrap.textContent = ''; wrap.append(img); }, { once: true });
  return wrap;
}

function statusTag(account) {
  const pending = account.pendingAction;
  if (pending) {
    return el('span', {
      className: 'tag tag--pending',
      textContent: pending.status === 'running' ? 'Unfollowing…' : 'Queued',
    });
  }
  if (account.status === 'unfollowed') return el('span', { className: 'tag tag--done', textContent: 'Unfollowed' });
  if (account.status === 'gone') return el('span', { className: 'tag', textContent: 'Not following' });
  return null;
}

function rowNode(account) {
  const handle = el('div', { className: 'handle' }, [
    el('a', {
      href: `https://www.instagram.com/${account.username}/`,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
      textContent: `@${account.username}`,
    }),
    account.isVerified ? el('span', { className: 'badge', title: 'Verified', textContent: '☑️' }) : null,
    account.isPrivate ? el('span', { className: 'badge', title: 'Private', textContent: '🔒' }) : null,
  ]);

  const who = el('div', { className: 'who-cell' }, [
    handle,
    account.fullName ? el('div', { className: 'fullname', textContent: account.fullName }) : null,
  ]);

  // Every cell always renders, including the unknown ones: a column that appears
  // and disappears per row makes the list impossible to scan.
  const followsBack = account.followsBack === null ? '—' : account.followsBack ? '✓' : '✗';
  const meta = el('div', { className: 'meta' }, [
    el('div', {}, [el('b', { textContent: formatCount(account.followerCount) }), 'followers']),
    el('div', {}, [el('b', { textContent: formatCount(account.followingCount) }), 'following']),
    el('div', {}, [el('b', { textContent: formatDate(account.followedAt) }), 'followed']),
    el('div', { title: 'Do they follow you back?' }, [el('b', { textContent: followsBack }), 'mutual']),
  ]);

  const action = el('div', { className: 'action' });
  const tag = statusTag(account);
  if (tag) {
    action.append(tag);
  } else if (state.capabilities?.unfollow) {
    action.append(
      el('button', {
        className: 'btn btn--sm btn--danger',
        type: 'button',
        textContent: 'Unfollow',
        onclick: () => askUnfollow(account),
      }),
    );
  }

  const row = el('div', { className: 'row' }, [avatarNode(account), who, meta, action]);
  row.dataset.status = account.status;
  row.dataset.pk = account.pk;
  return row;
}

function renderStats(stats) {
  const cards = [
    ['Following', stats.following],
    ["Doesn't follow back", stats.nonFollowers],
    ['Unfollowed', stats.unfollowed],
    ['In queue', state.queue?.queued ?? 0],
  ];
  $('#stats').replaceChildren(
    ...cards.map(([label, value]) =>
      el('div', { className: 'stat' }, [
        el('div', { className: 'stat__value', textContent: plain.format(value ?? 0) }),
        el('div', { className: 'stat__label', textContent: label }),
      ]),
    ),
  );
}

function banner(kind, message, actionLabel, onAction) {
  return el('div', { className: `banner banner--${kind}` }, [
    el('p', { textContent: message }),
    actionLabel ? el('button', { className: 'btn btn--sm', type: 'button', textContent: actionLabel, onclick: onAction }) : null,
  ]);
}

function renderBanners(status) {
  const nodes = [];
  const { queue, sync, capabilities, stats } = status;

  if (queue?.paused) {
    nodes.push(
      banner('error', `Unfollow queue paused: ${queue.pausedReason}`, 'Resume', async () => {
        await api('/queue/resume', { method: 'POST' });
        refreshStatus();
      }),
    );
  }
  if (sync?.progress?.phase === 'error' && sync.progress.error) {
    nodes.push(banner('error', `Last sync failed: ${sync.progress.error}`));
  }
  if (!capabilities?.unfollow) {
    nodes.push(
      banner(
        'warn',
        'Read-only mode: this is archive data, so unfollowing is disabled. Connect a session in Settings to act on the list.',
        'Settings',
        () => $('#settings').showModal(),
      ),
    );
  }
  if (stats?.archivePlaceholders > 0 && capabilities?.liveSync) {
    nodes.push(
      banner(
        'warn',
        `${stats.archivePlaceholders} account(s) came from the export and have no account id yet. Run a sync to resolve them.`,
      ),
    );
  }
  if (queue && !queue.paused && queue.limits?.lastDay >= (queue.limits?.maxPerDay ?? Infinity)) {
    nodes.push(banner('warn', 'Daily unfollow cap reached. The queue will resume automatically tomorrow.'));
  }

  $('#banners').replaceChildren(...nodes);
}

// --- data loading ----------------------------------------------------------

function buildQuery(offset) {
  const params = new URLSearchParams({
    status: state.status,
    sort: state.sort,
    direction: state.direction,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (state.search) params.set('search', state.search);
  for (const [key, on] of Object.entries(state.filters)) {
    if (on) params.set(key, 'true');
  }
  return params.toString();
}

async function loadPage({ reset = false } = {}) {
  if (state.loading) return;
  if (reset) {
    state.offset = 0;
    state.exhausted = false;
    state.generation += 1;
  }
  if (state.exhausted) return;

  const generation = state.generation;
  state.loading = true;
  if (reset) $('#list-status').replaceChildren(el('div', { className: 'loading', textContent: 'Loading…' }));

  try {
    const data = await api(`/accounts?${buildQuery(state.offset)}`);
    if (generation !== state.generation) return; // A newer query already fired.

    const rows = data.items.map(rowNode);
    if (reset) $('#list').replaceChildren(...rows);
    else $('#list').append(...rows);

    state.total = data.total;
    state.offset += data.items.length;
    state.exhausted = state.offset >= data.total || data.items.length === 0;

    $('#count').textContent = `${plain.format(data.total)} account${data.total === 1 ? '' : 's'}`;
    renderListStatus();
  } catch (err) {
    if (err.status === 401) promptForToken();
    else toast(err.message, 'error');
    $('#list-status').replaceChildren();
  } finally {
    state.loading = false;
  }
}

function renderListStatus() {
  if (state.total === 0) {
    $('#list-status').replaceChildren(
      el('div', { className: 'empty' }, [
        el('h2', { textContent: 'Nothing here yet' }),
        el('p', {
          textContent: state.search
            ? 'No account matches that search.'
            : 'Import your data export or run a sync to populate the list.',
        }),
      ]),
    );
    return;
  }
  $('#list-status').replaceChildren(
    state.exhausted
      ? el('div', { className: 'loading', textContent: `End of list — ${plain.format(state.total)} shown` })
      : el('div', { className: 'loading', textContent: 'Loading more…' }),
  );
}

// --- status polling --------------------------------------------------------

let pollTimer = null;
/** undefined until the first poll establishes a baseline. */
let lastSyncFinishedAt;

async function refreshStatus() {
  try {
    const status = await api('/status');
    state.capabilities = status.capabilities;
    state.queue = status.queue;
    renderStats(status.stats);
    renderBanners(status);
    renderQueueInfo(status.queue);

    const progress = status.sync?.progress ?? {};
    const syncing = Boolean(progress.running);
    $('#btn-sync').disabled = syncing || !status.capabilities?.liveSync;
    $('#btn-sync').textContent = syncing ? `Syncing… ${progress.fetched ?? 0}` : 'Sync';

    // A finished sync rewrites the whole table, so pull the list again rather
    // than leaving the user looking at pre-sync rows. Comparing finish
    // timestamps (rather than watching for a running->idle edge) also catches a
    // sync that started and completed between two polls.
    const finished = progress.finishedAt ?? null;
    if (lastSyncFinishedAt === undefined) {
      lastSyncFinishedAt = finished;
    } else if (!syncing && finished !== lastSyncFinishedAt) {
      lastSyncFinishedAt = finished;
      if (progress.phase === 'done') {
        toast(`Synced: ${progress.added} new, ${progress.removed} no longer followed`, 'ok');
      }
      loadPage({ reset: true });
    }

    const busy = syncing || status.queue?.running || (status.queue?.queued ?? 0) > 0;
    schedulePoll(busy ? 2500 : 20_000);
    return status;
  } catch (err) {
    if (err.status === 401) promptForToken();
    schedulePoll(30_000);
    return null;
  }
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshStatus, delay);
}

let lastQueueSignature = '';

function renderQueueInfo(queue) {
  if (!queue) return;
  const limits = queue.limits ?? {};
  $('#queue-info').replaceChildren(
    ...[
      ['Status', queue.paused ? `paused — ${queue.pausedReason}` : queue.running ? 'working' : 'idle'],
      ['Now', queue.current ? `@${queue.current.username}` : '—'],
      ['Queued', String(queue.queued ?? 0)],
      ['Used this hour', `${limits.lastHour ?? 0} / ${limits.maxPerHour ?? '∞'}`],
      ['Used today', `${limits.lastDay ?? 0} / ${limits.maxPerDay ?? '∞'}`],
      ['Next slot', queue.nextEligibleInMs > 0 ? `${Math.ceil(queue.nextEligibleInMs / 1000)}s` : 'now'],
    ].map(([k, v]) => el('div', { className: 'kv' }, [el('span', { textContent: k }), el('b', { textContent: v })])),
  );

  // Refresh the visible rows only when the queue actually changed, so scrolling
  // is never interrupted by a poll that found nothing new.
  const signature = `${queue.queued}|${queue.current?.id ?? ''}|${queue.paused}`;
  if (signature !== lastQueueSignature) {
    lastQueueSignature = signature;
    if (state.offset > 0) refreshVisibleRows();
  }
}

async function refreshVisibleRows() {
  const generation = state.generation;
  const limit = Math.min(state.offset, 500);
  try {
    const data = await api(`/accounts?${buildQuery(0).replace(/limit=\d+/, `limit=${limit}`)}`);
    if (generation !== state.generation) return;
    $('#list').replaceChildren(...data.items.map(rowNode));
    state.total = data.total;
    state.offset = data.items.length;
    state.exhausted = state.offset >= data.total;
  } catch {
    // A failed background refresh is not worth interrupting the user for.
  }
}

// --- actions ---------------------------------------------------------------

let pendingTarget = null;

function askUnfollow(account) {
  pendingTarget = account;
  $('#confirm-text').textContent =
    `Unfollow @${account.username}${account.fullName ? ` (${account.fullName})` : ''} on Instagram?`;
  $('#confirm').showModal();
}

async function doUnfollow() {
  const account = pendingTarget;
  $('#confirm').close();
  if (!account) return;
  try {
    await api(`/unfollow/${encodeURIComponent(account.pk)}`, {
      method: 'POST',
      json: { confirmUsername: account.username },
    });
    toast(`Queued unfollow for @${account.username}`, 'ok');
    refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pendingTarget = null;
  }
}

async function startSync() {
  try {
    await api('/sync', { method: 'POST', json: { enrich: true, enrichLimit: 25 } });
    toast('Sync started');
    refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function uploadArchive(file) {
  toast(`Importing ${file.name}…`);
  try {
    const result = await api(`/import?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
    });
    toast(`Imported ${result.counts.following} accounts`, 'ok');
    await refreshStatus();
    loadPage({ reset: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshSession() {
  try {
    const session = await api('/session');
    $('#who').textContent = session.selfUsername ? `@${session.selfUsername}` : '';
    $('#conn-info').replaceChildren(
      ...[
        ['Provider', session.provider],
        ['Session', session.connected ? `connected (ds_user_id ${session.dsUserId})` : 'not connected'],
        ['Last sync', session.lastSyncAt ? relative(session.lastSyncAt) : 'never'],
        ['Can unfollow', session.capabilities.unfollow ? 'yes' : 'no'],
        ['Login', session.login.running ? session.login.message : session.login.error || 'idle'],
      ].map(([k, v]) => el('div', { className: 'kv' }, [el('span', { textContent: k }), el('b', { textContent: v })])),
    );
  } catch (err) {
    if (err.status === 401) promptForToken();
  }
}

function promptForToken() {
  const existing = token();
  if (existing) toast('App token rejected. Update it in Settings.', 'error');
  else toast('This server requires an app token. Add it in Settings.', 'error');
}

// --- wiring ----------------------------------------------------------------

function debounce(fn, ms) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

function init() {
  $('#search').addEventListener(
    'input',
    debounce((event) => {
      state.search = event.target.value.trim();
      loadPage({ reset: true });
    }, 220),
  );

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      const key = chip.dataset.filter;
      state.filters[key] = !state.filters[key];
      chip.setAttribute('aria-pressed', String(state.filters[key]));
      loadPage({ reset: true });
    });
  }

  $('#status').addEventListener('change', (event) => {
    state.status = event.target.value;
    loadPage({ reset: true });
  });

  $('#sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    // Dates and counts are almost always wanted largest/newest first.
    state.direction = ['follower_count', 'following_count', 'followed_at', 'first_seen_at'].includes(state.sort)
      ? 'desc'
      : 'asc';
    updateDirectionLabel();
    loadPage({ reset: true });
  });

  $('#direction').addEventListener('click', () => {
    state.direction = state.direction === 'asc' ? 'desc' : 'asc';
    updateDirectionLabel();
    loadPage({ reset: true });
  });

  $('#btn-sync').addEventListener('click', startSync);
  $('#btn-settings').addEventListener('click', () => {
    refreshSession();
    $('#settings').showModal();
  });
  $('#confirm-go').addEventListener('click', doUnfollow);

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', (event) => event.target.closest('dialog').close());
  }

  $('#file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) uploadArchive(file);
    event.target.value = '';
  });

  $('#btn-login').addEventListener('click', async () => {
    try {
      await api('/session/login', { method: 'POST' });
      toast('A browser window is opening — log in there.');
      const poll = setInterval(async () => {
        await refreshSession();
        const session = await api('/session').catch(() => null);
        if (session && !session.login.running) clearInterval(poll);
      }, 2000);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-verify').addEventListener('click', async () => {
    try {
      const who = await api('/session/verify');
      toast(`Session valid${who.username ? ` for @${who.username}` : ''}`, 'ok');
      refreshSession();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-disconnect').addEventListener('click', async () => {
    await api('/session', { method: 'DELETE' }).catch(() => undefined);
    toast('Session cleared');
    refreshSession();
  });

  $('#btn-save-cookies').addEventListener('click', async () => {
    try {
      await api('/session', {
        method: 'POST',
        json: {
          sessionid: $('#c-sessionid').value.trim(),
          dsUserId: $('#c-dsuser').value.trim(),
          csrftoken: $('#c-csrf').value.trim(),
        },
      });
      $('#c-sessionid').value = '';
      toast('Cookies saved', 'ok');
      refreshSession();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-save-token').addEventListener('click', () => {
    try {
      localStorage.setItem(TOKEN_KEY, $('#c-token').value.trim());
    } catch {
      /* private mode: the token simply will not persist */
    }
    toast('Token saved', 'ok');
    refreshStatus();
    loadPage({ reset: true });
  });

  for (const [id, path] of [
    ['#btn-queue-pause', '/queue/pause'],
    ['#btn-queue-resume', '/queue/resume'],
  ]) {
    $(id).addEventListener('click', async () => {
      await api(path, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
      refreshStatus();
    });
  }

  $('#btn-queue-clear').addEventListener('click', async () => {
    const result = await api('/queue', { method: 'DELETE' }).catch((err) => {
      toast(err.message, 'error');
      return null;
    });
    if (result) toast(`Cleared ${result.canceled} queued unfollow(s)`, 'ok');
    refreshStatus();
  });

  new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadPage();
    },
    { rootMargin: '400px' },
  ).observe($('#sentinel'));

  try {
    $('#c-token').value = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    /* ignore */
  }

  updateDirectionLabel();
  refreshStatus();
  refreshSession();
  loadPage({ reset: true });
}

function updateDirectionLabel() {
  const alphabetical = state.sort === 'username' || state.sort === 'full_name';
  const asc = state.direction === 'asc';
  $('#direction').textContent = alphabetical ? (asc ? 'A→Z' : 'Z→A') : asc ? 'Low→High' : 'High→Low';
}

init();
