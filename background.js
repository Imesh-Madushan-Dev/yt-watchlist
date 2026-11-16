/*
 * Service worker — the single writer for the watchlist.
 *
 * Every mutation (from the YouTube page, the side panel, the context menu or a
 * keyboard shortcut) is funnelled through `mutate`, which serialises writes so
 * two tabs saving at the same moment can never clobber each other.
 */
importScripts('shared/core.js');

const { NS, STORAGE_KEY, WATCHED_AT, parseVideoId, isShortUrl, cleanTabTitle, reorderWithin } = YTWL;

const BRAND = '#5840ba';
const YT_MATCH = 'https://www.youtube.com/*';

/* ----------------------------------------------------------------------------
 * Side panel: clicking the toolbar icon opens (and closes) the panel — no popup.
 * -------------------------------------------------------------------------- */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[Watchlist] side panel behaviour', err));

/* ----------------------------------------------------------------------------
 * Storage
 * -------------------------------------------------------------------------- */
let writeChain = Promise.resolve();

/**
 * Run `fn(videos)` against the latest stored list, one caller at a time.
 * `fn` returns `{ videos, value }`; omit `videos` to leave storage untouched.
 */
function mutate(fn) {
  const run = writeChain.then(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const videos = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    const result = (await fn(videos)) || {};
    if (result.videos) await chrome.storage.local.set({ [STORAGE_KEY]: result.videos });
    return result.value;
  });
  writeChain = run.catch(() => {});
  return run;
}

const clip = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
const seconds = (value) => (Number.isFinite(+value) && +value > 0 ? Math.round(+value) : 0);

function safeChannelUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value || ''), 'https://www.youtube.com');
    return /(^|\.)youtube\.com$/.test(url.hostname) && url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function makeEntry(input, id) {
  return {
    id,
    title: clip(input.title, 300),
    channel: clip(input.channel, 120),
    channelUrl: safeChannelUrl(input.channelUrl),
    duration: seconds(input.duration),
    progress: 0,
    kind: input.kind === 'short' ? 'short' : 'video',
    addedAt: Date.now(),
    watched: false,
    watchedAt: 0,
  };
}

/* ----------------------------------------------------------------------------
 * Operations
 * -------------------------------------------------------------------------- */
async function addVideo(input) {
  const id = parseVideoId(input && (input.id || input.url));
  if (!id) throw new Error('That does not look like a YouTube video.');

  const value = await mutate((videos) => {
    const existing = videos.find((v) => v.id === id);
    if (existing) return { value: { added: false, video: existing } };
    const entry = makeEntry(input || {}, id);
    return { videos: [entry, ...videos], value: { added: true, video: entry } };
  });

  // YouTube's oEmbed endpoint is the authoritative source for title + channel.
  // What the page scraped shows instantly; this quietly corrects it.
  if (value.added) enrich(id);
  return value;
}

function removeVideo(id) {
  return mutate((videos) => {
    const index = videos.findIndex((v) => v.id === id);
    if (index < 0) return { value: { removed: null } };
    const next = videos.slice();
    const [removed] = next.splice(index, 1);
    return { videos: next, value: { removed: { video: removed, index } } };
  });
}

async function toggleVideo(input) {
  const id = parseVideoId(input && (input.id || input.url));
  if (!id) throw new Error('That does not look like a YouTube video.');
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const exists = (stored[STORAGE_KEY] || []).some((v) => v.id === id);
  if (exists) {
    const { removed } = await removeVideo(id);
    return { saved: false, removed };
  }
  const { video } = await addVideo({ ...input, id });
  return { saved: true, video };
}

/** Undo support: put removed entries back where they were. */
function restoreVideos(items) {
  return mutate((videos) => {
    const next = videos.slice();
    const sorted = (Array.isArray(items) ? items : [])
      .filter((item) => item && item.video && parseVideoId(item.video.id))
      .sort((a, b) => (a.index || 0) - (b.index || 0));
    let restored = 0;
    for (const item of sorted) {
      if (next.some((v) => v.id === item.video.id)) continue;
      const at = Math.min(Math.max(0, item.index | 0), next.length);
      next.splice(at, 0, item.video);
      restored++;
    }
    return restored ? { videos: next, value: { restored } } : { value: { restored: 0 } };
  });
}

function setWatched(id, watched) {
  return mutate((videos) => {
    const index = videos.findIndex((v) => v.id === id);
    if (index < 0 || videos[index].watched === !!watched) return { value: { changed: false } };
    const next = videos.slice();
    const video = { ...next[index], watched: !!watched, watchedAt: watched ? Date.now() : 0 };
    // Back in the queue: start over instead of resuming at the credits.
    if (!watched && video.duration && video.progress / video.duration >= WATCHED_AT) video.progress = 0;
    next[index] = video;
    return { videos: next, value: { changed: true } };
  });
}

/** Reorder the given ids among the slots they already occupy; everything else stays put. */
function reorderVideos(ids) {
  return mutate((videos) => {
    const next = reorderWithin(videos, ids);
    return next !== videos ? { videos: next, value: { changed: true } } : { value: { changed: false } };
  });
}

function clearWatched() {
  return mutate((videos) => {
    const removed = [];
    const next = videos.filter((video, index) => {
      if (!video.watched) return true;
      removed.push({ video, index });
      return false;
    });
    return removed.length ? { videos: next, value: { removed } } : { value: { removed } };
  });
}

/** Playback position reported by the watch page; finishing a video checks it off. */
function recordProgress(id, time, duration) {
  return mutate((videos) => {
    const index = videos.findIndex((v) => v.id === id);
    if (index < 0) return { value: { tracked: false } };
    const current = videos[index];
    const length = seconds(duration) || current.duration;
    const position = Math.max(0, Math.min(seconds(time), length || Infinity));
    const finished = length > 0 && position / length >= WATCHED_AT;

    const video = { ...current, duration: length, progress: position };
    if (finished && !current.watched) {
      video.watched = true;
      video.watchedAt = Date.now();
    }
    const same =
      video.duration === current.duration &&
      video.watched === current.watched &&
      Math.abs(video.progress - current.progress) < 1;
    if (same) return { value: { tracked: true, watched: current.watched } };

    const next = videos.slice();
    next[index] = video;
    return { videos: next, value: { tracked: true, watched: video.watched } };
  });
}

/* ----------------------------------------------------------------------------
 * Metadata
 * -------------------------------------------------------------------------- */
async function fetchMeta(id) {
  const target = encodeURIComponent('https://www.youtube.com/watch?v=' + id);
  const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + target, {
    credentials: 'omit',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    title: clip(data.title, 300),
    channel: clip(data.author_name, 120),
    channelUrl: safeChannelUrl(data.author_url),
  };
}

async function enrich(id) {
  try {
    const meta = await fetchMeta(id);
    if (!meta) return;
    await mutate((videos) => {
      const index = videos.findIndex((v) => v.id === id);
      if (index < 0) return {};
      const current = videos[index];
      const video = {
        ...current,
        title: meta.title || current.title,
        channel: meta.channel || current.channel,
        channelUrl: meta.channelUrl || current.channelUrl,
      };
      if (
        video.title === current.title &&
        video.channel === current.channel &&
        video.channelUrl === current.channelUrl
      ) {
        return {};
      }
      const next = videos.slice();
      next[index] = video;
      return { videos: next };
    });
  } catch (_) {
    // Offline or the video is private — the scraped details stay as they are.
  }
}

/* ----------------------------------------------------------------------------
 * Toolbar badge: how many videos are waiting
 * -------------------------------------------------------------------------- */
let badgeFlash = 0;

async function refreshBadge() {
  if (badgeFlash) return;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const waiting = (stored[STORAGE_KEY] || []).filter((v) => !v.watched).length;
  await chrome.action.setBadgeBackgroundColor({ color: BRAND });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: waiting ? (waiting > 99 ? '99+' : String(waiting)) : '' });
}

/** Brief confirmation on the toolbar icon, for pages where no toast can be shown. */
function flashBadge(text) {
  clearTimeout(badgeFlash);
  chrome.action.setBadgeBackgroundColor({ color: BRAND });
  chrome.action.setBadgeText({ text });
  badgeFlash = setTimeout(() => {
    badgeFlash = 0;
    refreshBadge();
  }, 1600);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) refreshBadge();
});

/** Show a toast on the page when it is a YouTube tab; otherwise flash the badge. */
async function confirmOnPage(tab, payload, badge) {
  try {
    if (!tab || tab.id == null) throw new Error('no tab');
    await chrome.tabs.sendMessage(tab.id, { ns: NS, type: 'toast', ...payload });
  } catch (_) {
    flashBadge(badge);
  }
}

async function saveFromUrl(url, title, tab) {
  const id = parseVideoId(url);
  if (!id) {
    await confirmOnPage(tab, { text: 'No video here to save', tone: 'muted' }, '?');
    return;
  }
  const { added } = await addVideo({ id, title, kind: isShortUrl(url) ? 'short' : 'video' });
  await confirmOnPage(
    tab,
    { text: added ? 'Saved to Watchlist' : 'Already in your Watchlist', tone: 'saved', action: 'open' },
    added ? '+1' : '✓'
  );
}

/* ----------------------------------------------------------------------------
 * Install: context menus + wake up YouTube tabs that are already open
 * -------------------------------------------------------------------------- */
const LINK_PATTERNS = [
  '*://*.youtube.com/watch*',
  '*://*.youtube.com/shorts/*',
  '*://*.youtube.com/live/*',
  '*://*.youtube.com/embed/*',
  '*://youtu.be/*',
];

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ytwl-save-link',
      title: 'Save to Watchlist',
      contexts: ['link'],
      targetUrlPatterns: LINK_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'ytwl-save-page',
      title: 'Save this video to Watchlist',
      contexts: ['page', 'video'],
      documentUrlPatterns: ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*', '*://*.youtube.com/live/*'],
    });
  });

  refreshBadge();

  // Tabs opened before the extension was installed have no content script yet.
  try {
    const tabs = await chrome.tabs.query({ url: YT_MATCH });
    for (const tab of tabs) {
      if (tab.id == null || tab.discarded) continue;
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] }).catch(() => {});
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['shared/core.js', 'content/content.js'] })
        .catch(() => {});
    }
  } catch (_) {
    /* nothing open — nothing to do */
  }
});

chrome.runtime.onStartup.addListener(refreshBadge);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ytwl-save-link') {
    saveFromUrl(info.linkUrl, '', tab);
  } else if (info.menuItemId === 'ytwl-save-page') {
    saveFromUrl(info.pageUrl, cleanTabTitle(tab && tab.title), tab);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'save-current-video') {
    saveFromUrl(tab && tab.url, cleanTabTitle(tab && tab.title), tab);
  }
});

/* ----------------------------------------------------------------------------
 * Messages from the YouTube page and the side panel
 * -------------------------------------------------------------------------- */
const handlers = {
  add: (msg) => addVideo(msg.video),
  toggle: (msg) => toggleVideo(msg.video),
  remove: (msg) => removeVideo(msg.id),
  restore: (msg) => restoreVideos(msg.items),
  setWatched: (msg) => setWatched(msg.id, msg.watched),
  reorder: (msg) => reorderVideos(msg.ids),
  clearWatched: () => clearWatched(),
  progress: (msg) => recordProgress(msg.id, msg.time, msg.duration),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.ns !== NS || sender.id !== chrome.runtime.id) return undefined;

  // Opening the panel has to happen synchronously inside the user gesture.
  if (msg.type === 'openPanel') {
    const windowId = sender.tab && sender.tab.windowId;
    if (windowId == null) {
      sendResponse({ ok: false, error: 'No window to open the panel in.' });
      return undefined;
    }
    chrome.sidePanel.open({ windowId }).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }

  const handler = handlers[msg.type];
  if (!handler) return undefined;

  Promise.resolve()
    .then(() => handler(msg))
    .then(
      (value) => sendResponse({ ok: true, ...(value || {}) }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
  return true;
});

refreshBadge();
