/*
 * Shared helpers. Loaded as a plain script in all three contexts:
 * the service worker (importScripts), the YouTube content script, and the side panel.
 */
(function (root) {
  'use strict';

  const ID_RE = /^[\w-]{11}$/;

  /** Extract an 11-character YouTube video id from any YouTube URL (or a bare id). */
  function parseVideoId(input) {
    if (!input) return null;
    let raw = String(input).trim();
    if (ID_RE.test(raw)) return raw;
    // A pasted link often arrives without its scheme ("youtu.be/…").
    if (/^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(raw)) {
      raw = 'https://' + raw;
    }
    let url;
    try {
      url = new URL(raw, 'https://www.youtube.com');
    } catch (_) {
      return null;
    }
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return ID_RE.test(id) ? id : null;
    }
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && ID_RE.test(id) ? id : null;
    }
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?]|$)/);
    return m ? m[1] : null;
  }

  function isShortUrl(input) {
    return /\/shorts\/[\w-]{11}/.test(String(input || ''));
  }

  /** Watch URL, resuming from `startAt` seconds when given. */
  function watchUrl(id, startAt) {
    const t = Math.floor(startAt || 0);
    return 'https://www.youtube.com/watch?v=' + id + (t > 0 ? '&t=' + t + 's' : '');
  }

  function thumbUrl(id) {
    return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
  }

  const TIME_RE = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?!\d)/;

  /** "1:02:03" or "12:34" (anywhere in a string) -> seconds. Returns 0 when absent. */
  function parseDuration(text) {
    const m = String(text || '').match(TIME_RE);
    if (!m) return 0;
    return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
  }

  /** seconds -> "1:02:03" / "12:34" */
  function formatClock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }

  /** seconds -> "2h 14m" / "38m" / "45s" */
  function formatLength(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (h === 0) return m + 'm';
    return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
  }

  function timeAgo(ts, now) {
    const diff = Math.max(0, (now || Date.now()) - (ts || 0));
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'Just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + 'd ago';
    if (day < 35) return Math.floor(day / 7) + 'w ago';
    if (day < 365) return Math.floor(day / 30) + 'mo ago';
    return Math.floor(day / 365) + 'y ago';
  }

  /** Browser tab title -> video title ("(3) Some video - YouTube" -> "Some video"). */
  function cleanTabTitle(title) {
    return String(title || '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*-\s*YouTube$/, '')
      .trim();
  }

  /**
   * Reorder `ids` among the slots they already occupy, leaving every other entry where it is.
   * Returns the same array when nothing moved.
   */
  function reorderWithin(videos, ids) {
    const byId = new Map(videos.map((v) => [v.id, v]));
    const queue = (Array.isArray(ids) ? ids : []).filter((id) => byId.has(id));
    const moving = new Set(queue);
    if (moving.size !== queue.length) return videos;
    let cursor = 0;
    const next = videos.map((v) => (moving.has(v.id) ? byId.get(queue[cursor++]) : v));
    return next.some((v, i) => v !== videos[i]) ? next : videos;
  }

  /** A video counts as finished once this share of it has played. */
  const WATCHED_AT = 0.95;

  root.YTWL = {
    NS: 'ytwl',
    STORAGE_KEY: 'videos',
    PREFS_KEY: 'prefs',
    WATCHED_AT,
    parseVideoId,
    isShortUrl,
    watchUrl,
    thumbUrl,
    parseDuration,
    formatClock,
    formatLength,
    timeAgo,
    cleanTabTitle,
    reorderWithin,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
