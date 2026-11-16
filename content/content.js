/*
 * Runs on youtube.com.
 *
 *  - Adds a "Watch later" button to every video thumbnail (home, search, sidebar, channel pages…)
 *  - Adds a "Watch later" pill next to the channel row on the watch page
 *  - Remembers how far you got in saved videos, and checks them off when you finish
 *
 * YouTube is a single-page app that recycles its DOM nodes, so nothing here caches
 * a video id on a button: the id is always read back from the live link at click time.
 */
(() => {
  'use strict';

  const { NS, STORAGE_KEY, parseVideoId, parseDuration, isShortUrl, cleanTabTitle } = YTWL;

  // The extension was reloaded or updated: retire the previous copy of this script.
  if (window.__ytwl && typeof window.__ytwl.destroy === 'function') {
    try {
      window.__ytwl.destroy();
    } catch (_) {
      /* the old copy is already gone */
    }
  }

  /* --------------------------------------------------------------------------
   * Icons — Lucide (rounded caps and joins), drawn as inline SVG
   * ------------------------------------------------------------------------ */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BOOKMARK = 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z';
  const ICONS = {
    'bookmark-plus': [
      ['path', { d: BOOKMARK }],
      ['line', { x1: 12, x2: 12, y1: 7, y2: 13 }],
      ['line', { x1: 15, x2: 9, y1: 10, y2: 10 }],
    ],
    'bookmark-check': [
      ['path', { d: BOOKMARK }],
      ['path', { d: 'm9 10 2 2 4-4' }],
    ],
    'bookmark-minus': [
      ['path', { d: BOOKMARK }],
      ['line', { x1: 15, x2: 9, y1: 10, y2: 10 }],
    ],
    info: [
      ['circle', { cx: 12, cy: 12, r: 10 }],
      ['path', { d: 'M12 16v-4' }],
      ['path', { d: 'M12 8h.01' }],
    ],
  };

  function icon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    };
    for (const key in attrs) svg.setAttribute(key, attrs[key]);
    if (className) svg.setAttribute('class', className);
    for (const [tag, props] of ICONS[name]) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const key in props) node.setAttribute(key, props[key]);
      svg.appendChild(node);
    }
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** The add/saved icon pair that cross-fades inside every button. */
  function iconPair() {
    const wrap = el('span', 'ytwl-ico');
    wrap.append(icon('bookmark-plus', 'ytwl-i-add'), icon('bookmark-check', 'ytwl-i-done'));
    return wrap;
  }

  /* --------------------------------------------------------------------------
   * State + messaging
   * ------------------------------------------------------------------------ */
  /** id -> { watched } for everything in the list. */
  let saved = new Map();
  let destroyed = false;
  const cleanups = [];

  function contextOk() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  function send(message) {
    return new Promise((resolve) => {
      if (!contextOk()) {
        resolve({ ok: false, error: 'stale' });
        return;
      }
      try {
        chrome.runtime.sendMessage({ ns: NS, ...message }, (response) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { ok: false, error: err.message } : response || { ok: false });
        });
      } catch (_) {
        resolve({ ok: false, error: 'stale' });
      }
    });
  }

  function readSaved(list) {
    const next = new Map();
    for (const video of Array.isArray(list) ? list : []) {
      if (video && video.id) next.set(video.id, { watched: !!video.watched });
    }
    saved = next;
  }

  /* --------------------------------------------------------------------------
   * Toast
   * ------------------------------------------------------------------------ */
  let toastEl = null;
  let toastTimer = 0;

  function hideToast() {
    clearTimeout(toastTimer);
    const node = toastEl;
    if (!node) return;
    toastEl = null;
    node.removeAttribute('data-show');
    const drop = () => (node.parentElement || node).remove();
    node.addEventListener('transitionend', drop, { once: true });
    setTimeout(drop, 600);
  }

  /**
   * @param {{ text: string, icon?: string, tone?: 'saved'|'muted', action?: { label: string, run: () => void } }} opts
   */
  function toast(opts) {
    if (destroyed) return;
    clearTimeout(toastTimer);

    // A toast already on screen is updated in place rather than queued behind itself.
    let root = toastEl && toastEl.parentElement;
    if (!toastEl) {
      root = el('div', 'ytwl-toast-root');
      toastEl = el('div', 'ytwl-toast');
      toastEl.setAttribute('role', 'status');
      root.appendChild(toastEl);
      document.body.appendChild(root);
    }
    const node = toastEl;
    node.textContent = '';
    node.dataset.tone = opts.tone || 'saved';

    const badge = el('span', 'ytwl-toast-ico');
    badge.appendChild(icon(opts.icon || 'bookmark-check'));
    node.append(badge, el('span', 'ytwl-toast-text', opts.text));

    if (opts.action) {
      const button = el('button', 'ytwl-toast-action', opts.action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        opts.action.run();
        hideToast();
      });
      node.appendChild(button);
    }
    node.toggleAttribute('data-plain', !opts.action);

    // Next frame, so the entrance transition has a starting point to animate from.
    requestAnimationFrame(() => {
      if (toastEl === node) node.setAttribute('data-show', '');
    });
    toastTimer = setTimeout(hideToast, opts.action ? 4200 : 2600);
  }

  const openPanelAction = {
    label: 'View list',
    run: () => {
      send({ type: 'openPanel' });
    },
  };

  /* --------------------------------------------------------------------------
   * Saving / removing
   * ------------------------------------------------------------------------ */
  function pop(button, saving) {
    button.removeAttribute('data-pop');
    void button.offsetWidth; // restart the animation if it is already running
    button.setAttribute('data-pop', saving ? 'save' : 'remove');
    setTimeout(() => button.removeAttribute('data-pop'), 700);
  }

  async function toggle(id, meta, button) {
    const saving = !saved.has(id);

    // Optimistic: the button answers on the same frame as the click.
    if (saving) saved.set(id, { watched: false });
    else saved.delete(id);
    if (button) pop(button, saving);
    syncAll();

    const res = saving
      ? await send({ type: 'add', video: { id, ...meta } })
      : await send({ type: 'remove', id });

    if (!res.ok) {
      if (saving) saved.delete(id);
      else saved.set(id, { watched: false });
      syncAll();
      toast({
        text: res.error === 'stale' ? 'Watchlist was updated — reload this page' : 'Could not update your Watchlist',
        icon: 'info',
        tone: 'muted',
      });
      return;
    }

    if (saving) {
      toast({ text: 'Saved to Watchlist', action: openPanelAction });
    } else if (res.removed) {
      toast({
        text: 'Removed from Watchlist',
        icon: 'bookmark-minus',
        tone: 'muted',
        action: { label: 'Undo', run: () => send({ type: 'restore', items: [res.removed] }) },
      });
    }
  }

  /* --------------------------------------------------------------------------
   * Thumbnail buttons
   * ------------------------------------------------------------------------ */
  const ANCHOR_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';

  // Places a thumbnail link can live where a save button would be noise.
  const EXCLUDE_SEL = [
    '.html5-video-player',
    'ytd-miniplayer',
    'ytd-notification-renderer',
    'ytd-playlist-renderer',
    'ytd-radio-renderer',
    'ytd-compact-radio-renderer',
    'ytd-compact-playlist-renderer',
    'ytd-grid-playlist-renderer',
    'ytd-video-preview',
    '.ytwl-toast-root',
  ].join(',');

  const THUMB_SEL = 'yt-thumbnail-view-model, ytd-thumbnail, yt-image, yt-img-shadow, img';
  const COLLECTION_SEL = 'yt-collection-thumbnail-view-model, yt-collections-stack, ytd-playlist-thumbnail';

  const CARD_SEL = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-rich-grid-media',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
  ].join(',');

  const TITLE_SEL = [
    '#video-title',
    '#video-title-link',
    '.yt-lockup-metadata-view-model__title',
    '.yt-lockup-metadata-view-model-wiz__title',
    '.shortsLockupViewModelHostMetadataTitle',
    'h3 a',
    'h3',
  ].join(',');

  const CHANNEL_SEL = [
    'ytd-channel-name a',
    'ytd-channel-name #text',
    '.yt-content-metadata-view-model__metadata-row a[href^="/@"]',
    '.yt-content-metadata-view-model-wiz__metadata-row a[href^="/@"]',
    'a[href^="/@"]',
    'a[href^="/channel/"]',
  ].join(',');

  function isThumbAnchor(anchor) {
    if (anchor.querySelector('a[href]')) return false; // a wrapper link: its inner thumbnail link gets the button
    if (anchor.closest(EXCLUDE_SEL)) return false;
    if (anchor.querySelector(COLLECTION_SEL)) return false; // playlists and mixes, not single videos
    if (anchor.id === 'thumbnail') return true;
    return !!anchor.querySelector(THUMB_SEL);
  }

  /** Where the button is positioned: the thumbnail itself, even when the link wraps a whole row. */
  function pickHost(anchor) {
    if (anchor.id !== 'thumbnail') {
      const inner = anchor.querySelector('ytd-thumbnail, yt-thumbnail-view-model');
      if (inner) {
        const outerWidth = anchor.offsetWidth;
        const innerWidth = inner.offsetWidth;
        if (innerWidth > 0 && outerWidth > innerWidth * 1.25) return inner;
      }
    }
    return anchor;
  }

  function scrapeCard(anchor) {
    const card = anchor.closest(CARD_SEL) || anchor.parentElement || anchor;
    const text = (node) => (node ? (node.getAttribute('title') || node.textContent || '').trim() : '');

    let title = text(card.querySelector(TITLE_SEL));
    if (!title) title = (anchor.getAttribute('title') || '').trim();

    const channelEl = card.querySelector(CHANNEL_SEL);
    const channelLink = channelEl && (channelEl.closest('a[href]') || channelEl.querySelector('a[href]'));

    return {
      title,
      channel: channelEl ? (channelEl.textContent || '').trim() : '',
      channelUrl: channelLink ? channelLink.href : '',
      // The duration badge sits inside the thumbnail link in every layout.
      duration: parseDuration(anchor.textContent),
      kind: isShortUrl(anchor.getAttribute('href')) ? 'short' : 'video',
    };
  }

  function swallow(event) {
    event.stopPropagation();
  }

  /** The thumbnail link on the page for a given video (used when the click came from the hover preview). */
  function cardAnchorFor(id) {
    for (const anchor of document.querySelectorAll('a.ytwl-anchor')) {
      if (parseVideoId(anchor.href) === id) return anchor;
    }
    return null;
  }

  function onThumbClick(event) {
    // Never let the click fall through to the thumbnail link underneath.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const button = event.currentTarget;
    const anchor = button.__ytwlAnchor;
    const id = anchor && parseVideoId(anchor.href);
    if (!id) return;
    const source = button.classList.contains('ytwl-btn-preview') ? cardAnchorFor(id) : anchor;
    toggle(id, source ? scrapeCard(source) : { kind: isShortUrl(anchor.getAttribute('href')) ? 'short' : 'video' }, button);
  }

  function makeThumbButton(anchor) {
    const button = el('button', 'ytwl-btn');
    button.type = 'button';
    button.draggable = false;
    button.__ytwlAnchor = anchor;
    button.append(iconPair(), el('span', 'ytwl-label'));
    button.lastChild.appendChild(el('span', 'ytwl-label-in'));
    button.addEventListener('click', onThumbClick);
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick']) {
      button.addEventListener(type, swallow);
    }
    return button;
  }

  function setSaved(button, isSaved) {
    if (button.hasAttribute('data-saved') === isSaved) return;
    button.toggleAttribute('data-saved', isSaved);
    button.setAttribute('aria-pressed', String(isSaved));
    button.setAttribute('aria-label', isSaved ? 'Remove from Watchlist' : 'Save to Watchlist');
  }

  function processAnchor(anchor) {
    let button = anchor.__ytwlBtn;
    if (button && !button.isConnected) button = anchor.__ytwlBtn = null;

    const id = parseVideoId(anchor.href);
    if (!id) {
      if (button) {
        button.remove();
        anchor.__ytwlBtn = null;
      }
      return;
    }

    if (!button) {
      if (!isThumbAnchor(anchor)) return;
      const host = pickHost(anchor);
      button = makeThumbButton(anchor);
      button.setAttribute('aria-label', 'Save to Watchlist');
      button.setAttribute('aria-pressed', 'false');
      if (getComputedStyle(host).position === 'static') host.classList.add('ytwl-rel');
      anchor.classList.add('ytwl-anchor');
      const card = anchor.closest(CARD_SEL);
      if (card) card.classList.add('ytwl-card');
      host.appendChild(button);
      anchor.__ytwlBtn = button;
    }
    setSaved(button, saved.has(id));
  }

  /* --------------------------------------------------------------------------
   * Inline hover preview
   *
   * A moment after you hover a thumbnail, YouTube lays a playing preview over it,
   * which hides the thumbnail's own button. The preview gets a twin in the same spot,
   * so the control never disappears from under the pointer.
   * ------------------------------------------------------------------------ */
  function syncPreview() {
    const preview = document.querySelector('ytd-video-preview');
    if (!preview) return;

    let button = preview.__ytwlBtn;
    if (button && !button.isConnected) button = preview.__ytwlBtn = null;

    const link = preview.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    const id = link && parseVideoId(link.href);
    if (!id) {
      if (button) button.hidden = true;
      return;
    }

    if (!button) {
      button = makeThumbButton(link);
      button.classList.add('ytwl-btn-preview');
      button.setAttribute('aria-label', 'Save to Watchlist');
      button.setAttribute('aria-pressed', 'false');
      if (getComputedStyle(preview).position === 'static') preview.classList.add('ytwl-rel');
      preview.appendChild(button);
      preview.__ytwlBtn = button;
    }
    button.hidden = false;
    button.__ytwlAnchor = link;
    setSaved(button, saved.has(id));
  }

  /* --------------------------------------------------------------------------
   * Watch page: pill next to the channel, floating pill as the fallback
   * ------------------------------------------------------------------------ */
  let inlinePill = null;
  let floatingPill = null;
  let navAt = performance.now();
  let lastHref = location.href;

  const SPRING = 'linear(0, .0576, .1806, .3213, .4558, .5736, .6717, .7507, .8127, .8606, .897, .9243, .9447, .9598, .9709, .979, .9849, .9892, .9923, .9945, .9961, .9972, .998, .9986, 1)';

  function scrapePage() {
    const heading = document.querySelector('ytd-watch-metadata h1');
    const channel = document.querySelector('ytd-watch-metadata #owner ytd-channel-name a');
    const player = document.getElementById('movie_player');
    const video = document.querySelector('#movie_player video');
    const inAd = !!(player && player.classList.contains('ad-showing'));
    return {
      title: (heading && heading.textContent.trim()) || cleanTabTitle(document.title),
      channel: channel ? channel.textContent.trim() : '',
      channelUrl: channel ? channel.href : '',
      duration: video && !inAd && Number.isFinite(video.duration) ? video.duration : 0,
      kind: isShortUrl(location.pathname) ? 'short' : 'video',
    };
  }

  function makePill(floating) {
    const button = el('button', floating ? 'ytwl-pill ytwl-pill-floating' : 'ytwl-pill');
    button.type = 'button';
    button.append(iconPair(), el('span', 'ytwl-pill-text', 'Watch later'));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = parseVideoId(location.href);
      if (id) toggle(id, scrapePage(), button);
    });
    return button;
  }

  function setPillSaved(button, isSaved) {
    const known = button.hasAttribute('data-ready');
    if (known && button.hasAttribute('data-saved') === isSaved) return;
    const label = button.querySelector('.ytwl-pill-text');
    const from = label.offsetWidth;

    button.toggleAttribute('data-saved', isSaved);
    button.setAttribute('data-ready', '');
    button.setAttribute('aria-pressed', String(isSaved));
    button.setAttribute('aria-label', isSaved ? 'Remove from Watchlist' : 'Save to Watchlist');
    label.textContent = isSaved ? 'Saved' : 'Watch later';

    // Glide between the two label widths instead of snapping.
    const to = label.offsetWidth;
    if (known && from && to && from !== to && label.animate) {
      label.animate(
        [
          { width: from + 'px', opacity: 0.4 },
          { width: to + 'px', opacity: 1 },
        ],
        { duration: 500, easing: SPRING }
      );
    }
  }

  function syncWatchUI() {
    const id = parseVideoId(location.href);
    if (!id) {
      if (inlinePill) inlinePill.remove();
      if (floatingPill) floatingPill.remove();
      inlinePill = floatingPill = null;
      return;
    }

    let owner = null;
    if (location.pathname === '/watch') {
      for (const candidate of document.querySelectorAll('ytd-watch-metadata #owner')) {
        if (candidate.offsetParent !== null) {
          owner = candidate;
          break;
        }
      }
    }

    if (owner) {
      if (!inlinePill || inlinePill.parentElement !== owner) {
        if (inlinePill) inlinePill.remove();
        inlinePill = makePill(false);
        owner.appendChild(inlinePill);
      }
      if (floatingPill) {
        floatingPill.remove();
        floatingPill = null;
      }
    } else {
      if (inlinePill) {
        inlinePill.remove();
        inlinePill = null;
      }
      // Give the watch page a moment to render before falling back to the floating pill.
      const settled = location.pathname !== '/watch' || performance.now() - navAt > 2500;
      if (!floatingPill && settled) {
        floatingPill = makePill(true);
        document.body.appendChild(floatingPill);
      } else if (floatingPill && !floatingPill.isConnected) {
        document.body.appendChild(floatingPill);
      }
    }

    if (inlinePill) setPillSaved(inlinePill, saved.has(id));
    if (floatingPill) setPillSaved(floatingPill, saved.has(id));
  }

  /* --------------------------------------------------------------------------
   * Playback progress for saved videos
   * ------------------------------------------------------------------------ */
  let lastReport = 0;

  function reportProgress(video, force) {
    const id = parseVideoId(location.href);
    const entry = id && saved.get(id);
    if (!entry || entry.watched) return;
    if (performance.now() - navAt < 2500) return; // the player may still hold the previous video
    if (!Number.isFinite(video.duration) || video.duration < 1) return;

    const player = document.getElementById('movie_player');
    if (player && player.classList.contains('ad-showing')) return;
    const flexy = document.querySelector('ytd-watch-flexy[video-id]');
    if (flexy && location.pathname === '/watch' && flexy.getAttribute('video-id') !== id) return;

    const now = performance.now();
    if (!force && now - lastReport < 5000) return;
    lastReport = now;
    send({ type: 'progress', id, time: video.currentTime, duration: video.duration });
  }

  function trackVideo() {
    const video = document.querySelector('#movie_player video');
    if (!video || video.__ytwlTracked) return;
    video.__ytwlTracked = true;
    const onTime = () => reportProgress(video, false);
    const onEdge = () => reportProgress(video, true);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('pause', onEdge);
    video.addEventListener('ended', onEdge);
    cleanups.push(() => {
      video.__ytwlTracked = false;
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('pause', onEdge);
      video.removeEventListener('ended', onEdge);
    });
  }

  /* --------------------------------------------------------------------------
   * Scanning
   * ------------------------------------------------------------------------ */
  let scanTimer = 0;
  let lastScan = 0;

  function scan() {
    scanTimer = 0;
    if (destroyed) return;
    if (!contextOk()) {
      destroy();
      return;
    }
    lastScan = performance.now();

    if (location.href !== lastHref) {
      lastHref = location.href;
      navAt = performance.now();
      setTimeout(queueScan, 2700);
    }

    const anchors = document.querySelectorAll(ANCHOR_SEL);
    for (let i = 0; i < anchors.length; i++) processAnchor(anchors[i]);
    syncPreview();
    syncWatchUI();
    trackVideo();
  }

  function queueScan() {
    if (scanTimer || destroyed) return;
    const wait = Math.max(0, 220 - (performance.now() - lastScan));
    scanTimer = setTimeout(scan, wait);
  }

  /** Re-sync every button right now (after a click or a storage change). */
  function syncAll() {
    clearTimeout(scanTimer);
    scan();
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      // The hover preview is re-pointed at another video by swapping its link: follow it at once.
      if (record.type === 'attributes' && target.nodeType === 1 && target.closest('ytd-video-preview')) syncPreview();
      // The player rewrites its own DOM several times a second while playing; ignore it.
      if (target.nodeType === 1 && target.closest('.html5-video-player, .ytwl-btn, .ytwl-pill, .ytwl-toast-root')) continue;
      queueScan();
      return;
    }
  });

  /* --------------------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------------------ */
  function onStorage(changes, area) {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    readSaved(changes[STORAGE_KEY].newValue);
    syncAll();
  }

  function onMessage(message) {
    if (!message || message.ns !== NS || message.type !== 'toast') return;
    toast({
      text: message.text,
      tone: message.tone,
      icon: message.tone === 'muted' ? 'info' : 'bookmark-check',
      action: message.action === 'open' ? openPanelAction : undefined,
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(toastTimer);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (_) {
        /* keep tearing down */
      }
    }
    try {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {
      /* the extension context is already gone */
    }
    document.querySelectorAll('.ytwl-btn, .ytwl-pill, .ytwl-toast-root').forEach((node) => node.remove());
    document.querySelectorAll('.ytwl-anchor, .ytwl-card, .ytwl-rel, ytd-video-preview').forEach((node) => {
      node.classList.remove('ytwl-anchor', 'ytwl-card', 'ytwl-rel');
      node.__ytwlBtn = null;
    });
  }

  window.__ytwl = { destroy };

  function start() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    const onNavigate = () => {
      navAt = performance.now();
      lastHref = location.href;
      queueScan();
      setTimeout(queueScan, 2700);
    };
    on(document, 'yt-navigate-finish', onNavigate);
    on(document, 'yt-page-data-updated', queueScan);
    chrome.storage.onChanged.addListener(onStorage);
    chrome.runtime.onMessage.addListener(onMessage);
    scan();
    setTimeout(queueScan, 2700);
  }

  chrome.storage.local.get(STORAGE_KEY, (stored) => {
    if (destroyed) return;
    readSaved(stored && stored[STORAGE_KEY]);
    start();
  });
})();
