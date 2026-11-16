/*
 * Watchlist side panel.
 *
 * React + Framer Motion + lucide-react, loaded as plain scripts from vendor/ (no build step).
 * `htm` gives JSX-like templates without a compiler:  html`<${Component} prop=${value} />`
 *
 * Motion follows a few rules throughout:
 *   - springs everywhere, critically damped by default — bounce only where a gesture had momentum
 *   - feedback on pointer-down (whileTap), never on release
 *   - things leave the way they arrived, and popovers grow out of the control that opened them
 */
(() => {
  'use strict';

  const { useState, useEffect, useRef, useMemo, useCallback } = React;
  const { motion, AnimatePresence, Reorder, MotionConfig, useDragControls } = Motion;
  const Icon = LucideReact;
  const html = htm.bind(React.createElement);

  const {
    NS,
    STORAGE_KEY,
    PREFS_KEY,
    parseVideoId,
    isShortUrl,
    watchUrl,
    thumbUrl,
    formatClock,
    formatLength,
    timeAgo,
    cleanTabTitle,
    reorderWithin,
    WATCHED_AT,
  } = YTWL;

  /* --------------------------------------------------------------------------
   * Motion presets
   * ------------------------------------------------------------------------ */
  const SPRING = { type: 'spring', bounce: 0, duration: 0.42 }; // the house default: no overshoot
  const QUICK = { type: 'spring', bounce: 0, duration: 0.28 }; // presses and small controls
  const LIVELY = { type: 'spring', bounce: 0.24, duration: 0.5 }; // only after a drag or a tap that "throws"

  const DEFAULT_PREFS = { sort: 'manual', queueOpen: true, watchedOpen: false };

  const SORTS = [
    { id: 'manual', label: 'My order', hint: 'Drag to rearrange', icon: 'GripVertical' },
    { id: 'newest', label: 'Newest first', icon: 'CalendarArrowDown' },
    { id: 'oldest', label: 'Oldest first', icon: 'CalendarArrowUp' },
    { id: 'shortest', label: 'Shortest first', icon: 'Timer' },
    { id: 'longest', label: 'Longest first', icon: 'Hourglass' },
  ];

  const cx = (...parts) => parts.filter(Boolean).join(' ');
  const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

  function send(message) {
    return chrome.runtime
      .sendMessage({ ns: NS, ...message })
      .then((res) => res || { ok: false })
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  }

  function sortQueue(list, mode) {
    if (mode === 'manual') return list;
    const byLength = (direction) => (a, b) => {
      const da = a.duration || 0;
      const db = b.duration || 0;
      if (!da || !db) return (da ? 0 : 1) - (db ? 0 : 1); // unknown lengths sink to the bottom
      return direction * (da - db);
    };
    const copy = list.slice();
    if (mode === 'newest') return copy.sort((a, b) => b.addedAt - a.addedAt);
    if (mode === 'oldest') return copy.sort((a, b) => a.addedAt - b.addedAt);
    if (mode === 'shortest') return copy.sort(byLength(1));
    if (mode === 'longest') return copy.sort(byLength(-1));
    return list;
  }

  /** Resume where you stopped, unless you had barely started or were nearly done. */
  function resumeAt(video) {
    if (!video.duration || video.watched) return 0;
    const share = video.progress / video.duration;
    return video.progress > 10 && share < WATCHED_AT ? video.progress : 0;
  }

  async function openVideo(video, inNewTab) {
    const url = watchUrl(video.id, resumeAt(video));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // `tab.url` is only visible for youtube.com (the one host this extension can read).
      const onYouTube = !!(tab && tab.url && /^https:\/\/www\.youtube\.com\//.test(tab.url));
      if (!inNewTab && onYouTube) await chrome.tabs.update(tab.id, { url });
      else await chrome.tabs.create({ url });
    } catch (_) {
      window.open(url, '_blank', 'noopener');
    }
  }

  /* --------------------------------------------------------------------------
   * Hooks
   * ------------------------------------------------------------------------ */

  /** The stored list + preferences, kept live across tabs via storage events. */
  function useStore() {
    const [videos, setVideos] = useState(null);
    const [prefs, setPrefs] = useState(DEFAULT_PREFS);

    useEffect(() => {
      let alive = true;
      chrome.storage.local.get([STORAGE_KEY, PREFS_KEY]).then((stored) => {
        if (!alive) return;
        setVideos(Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : []);
        setPrefs({ ...DEFAULT_PREFS, ...(stored[PREFS_KEY] || {}) });
      });
      const onChange = (changes, area) => {
        if (area !== 'local') return;
        if (changes[STORAGE_KEY]) setVideos(changes[STORAGE_KEY].newValue || []);
        if (changes[PREFS_KEY]) setPrefs({ ...DEFAULT_PREFS, ...(changes[PREFS_KEY].newValue || {}) });
      };
      chrome.storage.onChanged.addListener(onChange);
      return () => {
        alive = false;
        chrome.storage.onChanged.removeListener(onChange);
      };
    }, []);

    const updatePrefs = useCallback((patch) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        chrome.storage.local.set({ [PREFS_KEY]: next });
        return next;
      });
    }, []);

    return { videos, setVideos, prefs, updatePrefs };
  }

  /** The video open in the active tab, if it is a YouTube video. */
  function useActiveVideo() {
    const [active, setActive] = useState(null);

    useEffect(() => {
      let alive = true;
      const read = async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const id = tab && parseVideoId(tab.url);
          if (!alive) return;
          setActive(id ? { id, title: cleanTabTitle(tab.title), kind: isShortUrl(tab.url) ? 'short' : 'video' } : null);
        } catch (_) {
          if (alive) setActive(null);
        }
      };
      const onUpdated = (_tabId, info, tab) => {
        if (tab && tab.active && (info.url || info.title || info.status === 'complete')) read();
      };
      read();
      chrome.tabs.onActivated.addListener(read);
      chrome.tabs.onUpdated.addListener(onUpdated);
      return () => {
        alive = false;
        chrome.tabs.onActivated.removeListener(read);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      };
    }, []);

    return active;
  }

  function useDismiss(open, close, refs) {
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (event) => {
        if (refs.some((ref) => ref.current && ref.current.contains(event.target))) return;
        close();
      };
      const onKey = (event) => {
        if (event.key === 'Escape') close();
      };
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('blur', close);
      return () => {
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('blur', close);
      };
    }, [open]);
  }

  /* --------------------------------------------------------------------------
   * Small pieces
   * ------------------------------------------------------------------------ */
  function IconButton({ icon, label, onClick, className, size = 15 }) {
    const Glyph = Icon[icon];
    return html`
      <${motion.button}
        type="button"
        aria-label=${label}
        title=${label}
        whileTap=${{ scale: 0.86 }}
        transition=${QUICK}
        onClick=${(event) => {
          event.stopPropagation();
          onClick(event);
        }}
        className=${cx(
          'grid h-[26px] w-[26px] place-items-center rounded-full text-ink-2 outline-none transition-colors duration-150',
          'hover:bg-fill-strong focus-visible:bg-fill-strong focus-visible:ring-2 focus-visible:ring-brand-500',
          className
        )}
      >
        <${Glyph} size=${size} strokeWidth=${2.2} />
      <//>
    `;
  }

  function Thumb({ video, percent, wide }) {
    const [failed, setFailed] = useState(false);
    return html`
      <div
        className=${cx(
          'relative aspect-video shrink-0 overflow-hidden bg-fill',
          wide ? 'w-[124px] rounded-[10px]' : 'w-[68px] rounded-lg'
        )}
      >
        ${failed
          ? html`<div className="grid h-full w-full place-items-center text-ink-3">
              <${Icon.Film} size=${wide ? 20 : 16} strokeWidth=${1.8} />
            </div>`
          : html`<img
              src=${thumbUrl(video.id)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable=${false}
              onError=${() => setFailed(true)}
              className=${cx(
                'h-full w-full object-cover transition-[opacity,filter] duration-300',
                video.watched && 'opacity-60 saturate-[0.6]'
              )}
            />`}
        ${wide &&
        html`<div
          className="pointer-events-none absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/25"
        >
          <div
            className="grid h-8 w-8 scale-75 place-items-center rounded-full bg-white/95 text-brand-700 opacity-0 shadow-lg transition-[transform,opacity] duration-[420ms] ease-spring group-hover:scale-100 group-hover:opacity-100"
          >
            <${Icon.Play} size=${14} strokeWidth=${2.4} fill="currentColor" className="translate-x-px" />
          </div>
        </div>`}
        ${wide &&
        video.duration > 0 &&
        html`<span
          className="absolute bottom-1 right-1 rounded-[5px] bg-black/75 px-1 text-[10.5px] font-semibold leading-[15px] tabular-nums tracking-[0.01em] text-white"
        >
          ${formatClock(video.duration)}
        </span>`}
        ${wide &&
        video.watched &&
        html`<span className="absolute left-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-brand-600 text-white shadow">
          <${Icon.Check} size=${11} strokeWidth=${3.2} />
        </span>`}
        ${percent > 0 &&
        html`<div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/35">
          <div className="h-full rounded-r-full bg-brand-400" style=${{ width: percent + '%' }} />
        </div>`}
      </div>
    `;
  }

  /* --------------------------------------------------------------------------
   * A row in the list
   * ------------------------------------------------------------------------ */
  function VideoRow({ video, canDrag, isNew, bounds, onOpen, onRemove, onToggleWatched, onDragStart, onDragEnd }) {
    const controls = useDragControls();
    const [dragging, setDragging] = useState(false);
    const justDragged = useRef(false);
    const fresh = useRef(isNew).current;

    const inProgress = !video.watched && video.duration > 0 && video.progress > 5;
    const percent = inProgress ? Math.min(100, (video.progress / video.duration) * 100) : 0;
    const meta = video.watched
      ? 'Watched ' + lowerFirst(timeAgo(video.watchedAt))
      : inProgress
        ? formatClock(video.duration - video.progress) + ' left'
        : 'Added ' + lowerFirst(timeAgo(video.addedAt));

    return html`
      <${Reorder.Item}
        as="div"
        value=${video.id}
        dragListener=${false}
        dragControls=${controls}
        dragConstraints=${bounds}
        dragElastic=${0.18}
        initial=${{ opacity: 0, height: 0, scale: 0.94 }}
        animate=${{ opacity: 1, height: 'auto', scale: 1 }}
        exit=${{ opacity: 0, height: 0, scale: 0.94 }}
        whileDrag=${{ scale: 1.03 }}
        transition=${dragging ? LIVELY : SPRING}
        onDragStart=${() => {
          justDragged.current = true;
          setDragging(true);
          onDragStart();
        }}
        onDragEnd=${() => {
          setDragging(false);
          onDragEnd();
          // The click that ends a drag must not also open the video.
          setTimeout(() => (justDragged.current = false), 0);
        }}
        onPointerDown=${(event) => {
          if (canDrag && event.button === 0 && !event.target.closest('button')) controls.start(event);
        }}
        onClick=${(event) => {
          if (!justDragged.current) onOpen(video, event.metaKey || event.ctrlKey);
        }}
        onAuxClick=${(event) => {
          if (event.button === 1) onOpen(video, true);
        }}
        onKeyDown=${(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter') onOpen(video, event.metaKey || event.ctrlKey);
          else if (event.key === 'Delete' || event.key === 'Backspace') onRemove(video);
        }}
        role="link"
        tabIndex=${0}
        aria-label=${(video.title || 'YouTube video') + (video.channel ? ', ' + video.channel : '')}
        className=${cx(
          'group relative select-none overflow-hidden rounded-2xl outline-none transition-[background-color,box-shadow] duration-200',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
          dragging ? 'z-10 cursor-grabbing bg-raised shadow-pop' : 'cursor-pointer hover:bg-hover focus-visible:bg-hover'
        )}
      >
        ${fresh &&
        html`<${motion.div}
          aria-hidden="true"
          initial=${{ opacity: 1 }}
          animate=${{ opacity: 0 }}
          transition=${{ duration: 1.5, delay: 0.5, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0 bg-brand-500/20"
        />`}

        <div className="flex items-stretch gap-3 p-2">
          <${Thumb} video=${video} percent=${percent} wide=${true} />
          <div className="flex min-w-0 flex-1 flex-col py-px">
            <div
              title=${video.title}
              className=${cx(
                'line-clamp-2 text-[13px] font-semibold leading-[17px] tracking-[-0.006em]',
                video.title ? 'text-ink' : 'text-ink-3'
              )}
            >
              ${video.title || 'Fetching details…'}
            </div>
            <div className="mt-0.5 truncate pr-[58px] text-[12px] leading-4 text-ink-2">${video.channel}</div>
            <div className="mt-auto truncate pr-[58px] text-[11px] leading-[15px] tabular-nums tracking-[0.01em] text-ink-3">
              ${meta}
            </div>
          </div>
        </div>

        <div
          className=${cx(
            'absolute bottom-1.5 right-1.5 flex gap-0.5 transition-opacity duration-150',
            dragging ? 'opacity-0' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          )}
        >
          ${video.watched
            ? html`<${IconButton}
                icon="Undo2"
                label="Move back to Up next"
                onClick=${() => onToggleWatched(video)}
                className="hover:text-accent"
              />`
            : html`<${IconButton}
                icon="Check"
                label="Mark as watched"
                onClick=${() => onToggleWatched(video)}
                className="hover:text-accent"
              />`}
          <${IconButton}
            icon="Trash2"
            label="Remove"
            onClick=${() => onRemove(video)}
            className="hover:text-red-500"
            size=${14}
          />
        </div>
      <//>
    `;
  }

  function VideoList({ items, canDrag, seen, onReorder, onDragStart, onDragEnd, actions }) {
    const bounds = useRef(null);
    const ids = useMemo(() => items.map((video) => video.id), [items]);
    return html`
      <${Reorder.Group} as="div" axis="y" ref=${bounds} values=${ids} onReorder=${onReorder} className="relative">
        <${AnimatePresence} initial=${false}>
          ${items.map(
            (video) => html`
              <${VideoRow}
                key=${video.id}
                video=${video}
                canDrag=${canDrag}
                isNew=${!!seen && !seen.has(video.id)}
                bounds=${bounds}
                onDragStart=${onDragStart}
                onDragEnd=${onDragEnd}
                ...${actions}
              />
            `
          )}
        <//>
      <//>
    `;
  }

  /* --------------------------------------------------------------------------
   * Collapsible section
   * ------------------------------------------------------------------------ */
  function Section({ title, count, open, onToggle, action, children }) {
    return html`
      <section>
        <div className="flex h-9 items-center justify-between pl-1 pr-1.5">
          <${motion.button}
            type="button"
            aria-expanded=${open}
            onClick=${onToggle}
            whileTap=${{ scale: 0.96 }}
            transition=${QUICK}
            className="flex h-7 items-center gap-1 rounded-lg pl-1 pr-2 text-ink-2 outline-none transition-colors duration-150 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <${motion.span} animate=${{ rotate: open ? 90 : 0 }} transition=${SPRING} className="grid place-items-center">
              <${Icon.ChevronRight} size=${14} strokeWidth=${2.8} />
            <//>
            <span className="text-[11.5px] font-bold uppercase leading-none tracking-[0.07em]">${title}</span>
            <span
              className="ml-1 rounded-full bg-fill px-1.5 text-[11px] font-semibold tabular-nums leading-[17px] text-ink-2"
            >
              ${count}
            </span>
          <//>
          ${action}
        </div>

        <${AnimatePresence} initial=${false}>
          ${open &&
          html`
            <${motion.div}
              key="body"
              initial=${{ height: 0, opacity: 0, overflow: 'hidden' }}
              animate=${{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
              exit=${{ height: 0, opacity: 0, overflow: 'hidden' }}
              transition=${SPRING}
            >
              ${children}
            <//>
          `}
        <//>
      </section>
    `;
  }

  function Note({ icon, children }) {
    const Glyph = Icon[icon];
    return html`
      <${motion.div}
        initial=${{ opacity: 0, y: 6 }}
        animate=${{ opacity: 1, y: 0 }}
        transition=${SPRING}
        className="flex items-center gap-2.5 px-3 py-4 text-[12.5px] leading-[17px] text-ink-2"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fill text-accent">
          <${Glyph} size=${16} strokeWidth=${2.1} />
        </span>
        <span>${children}</span>
      <//>
    `;
  }

  /* --------------------------------------------------------------------------
   * Sort menu — grows out of the button that opens it
   * ------------------------------------------------------------------------ */
  function SortMenu({ value, onChange }) {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState({ top: 0, right: 0 });
    const trigger = useRef(null);
    const menu = useRef(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, close, [trigger, menu]);

    const toggle = () => {
      if (!open && trigger.current) {
        const rect = trigger.current.getBoundingClientRect();
        setAnchor({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
      }
      setOpen(!open);
    };

    const sorted = value !== 'manual';

    return html`
      <${React.Fragment}>
        <${motion.button}
          ref=${trigger}
          type="button"
          aria-label="Sort"
          title="Sort"
          aria-haspopup="menu"
          aria-expanded=${open}
          onClick=${toggle}
          whileTap=${{ scale: 0.9 }}
          transition=${QUICK}
          className=${cx(
            'grid h-8 w-8 shrink-0 place-items-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand-500',
            sorted || open ? 'bg-brand-600/[0.14] text-accent' : 'bg-fill text-ink-2 hover:bg-fill-strong hover:text-ink'
          )}
        >
          <${Icon.ArrowUpDown} size=${15} strokeWidth=${2.3} />
        <//>

        ${ReactDOM.createPortal(
          html`
            <${AnimatePresence}>
              ${open &&
              html`
                <${motion.div}
                  key="menu"
                  ref=${menu}
                  role="menu"
                  aria-label="Sort Up next"
                  initial=${{ opacity: 0, scale: 0.86, filter: 'blur(8px)' }}
                  animate=${{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit=${{ opacity: 0, scale: 0.92, filter: 'blur(6px)', transition: { duration: 0.15, ease: 'easeIn' } }}
                  transition=${QUICK}
                  style=${{ top: anchor.top, right: anchor.right, transformOrigin: 'calc(100% - 16px) -8px' }}
                  className="material-pop fixed z-50 w-[216px] rounded-2xl p-1.5 shadow-pop"
                >
                  <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-[0.07em] text-ink-3">
                    Sort Up next
                  </div>
                  ${SORTS.map((option) => {
                    const Glyph = Icon[option.icon];
                    const selected = option.id === value;
                    return html`
                      <button
                        key=${option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked=${selected}
                        onClick=${() => {
                          onChange(option.id);
                          close();
                        }}
                        className=${cx(
                          'flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-left outline-none transition-colors duration-100',
                          'hover:bg-fill focus-visible:bg-fill active:bg-fill-strong',
                          selected ? 'text-accent' : 'text-ink'
                        )}
                      >
                        <${Glyph} size=${15} strokeWidth=${2.1} className=${selected ? '' : 'text-ink-2'} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium leading-[17px]">${option.label}</span>
                          ${option.hint &&
                          html`<span className="block text-[11px] leading-[14px] text-ink-3">${option.hint}</span>`}
                        </span>
                        ${selected && html`<${Icon.Check} size=${15} strokeWidth=${2.8} />`}
                      </button>
                    `;
                  })}
                <//>
              `}
            <//>
          `,
          document.body
        )}
      <//>
    `;
  }

  /* --------------------------------------------------------------------------
   * Header: translucent, content scrolls beneath it
   * ------------------------------------------------------------------------ */
  function Header({ scrolled, subtitle, query, onQuery, sort, onSort }) {
    const input = useRef(null);
    return html`
      <header
        className=${cx(
          'material-header sticky top-0 z-20 border-b px-3 pb-2.5 pt-3 transition-[border-color] duration-300',
          scrolled ? 'border-hairline' : 'border-transparent'
        )}
      >
        <div className="flex items-center gap-2.5">
          <img
            src="../icons/icon128.png"
            alt=""
            width="38"
            height="38"
            draggable=${false}
            className="h-[38px] w-[38px] shrink-0 drop-shadow-[0_4px_9px_rgba(88,64,186,0.38)]"
          />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[19px] font-bold leading-[22px] tracking-[-0.022em] text-ink">Watchlist</h1>
            <${motion.p}
              key=${subtitle}
              initial=${{ opacity: 0, y: 3 }}
              animate=${{ opacity: 1, y: 0 }}
              transition=${QUICK}
              className="truncate text-[12px] leading-4 text-ink-2"
            >
              ${subtitle}
            <//>
          </div>
          <${SortMenu} value=${sort} onChange=${onSort} />
        </div>

        <div className="relative mt-3">
          <${Icon.Search}
            size=${15}
            strokeWidth=${2.4}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            ref=${input}
            type="search"
            value=${query}
            onChange=${(event) => onQuery(event.target.value)}
            onKeyDown=${(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                onQuery('');
              }
            }}
            placeholder="Search, or paste a YouTube link"
            aria-label="Search your Watchlist, or paste a YouTube link to add it"
            spellCheck=${false}
            autoComplete="off"
            className="h-9 w-full rounded-xl bg-fill pl-8 pr-9 text-[13px] text-ink outline-none transition-shadow duration-200 placeholder:text-ink-3 focus:ring-2 focus:ring-brand-500/70"
          />
          <${AnimatePresence}>
            ${query &&
            html`
              <${motion.button}
                key="clear"
                type="button"
                aria-label="Clear search"
                initial=${{ opacity: 0, scale: 0.6 }}
                animate=${{ opacity: 1, scale: 1 }}
                exit=${{ opacity: 0, scale: 0.6 }}
                whileTap=${{ scale: 0.85 }}
                transition=${QUICK}
                onClick=${() => {
                  onQuery('');
                  if (input.current) input.current.focus();
                }}
                className="absolute right-2 top-1/2 -mt-[9px] grid h-[18px] w-[18px] place-items-center rounded-full bg-ink-3 text-canvas outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <${Icon.X} size=${11} strokeWidth=${3.2} />
              <//>
            `}
          <//>
        </div>
      </header>
    `;
  }

  /* --------------------------------------------------------------------------
   * Quick add: the video in this tab, or the link you just pasted
   * ------------------------------------------------------------------------ */
  function QuickAdd({ item, onAdd }) {
    return html`
      <${motion.div}
        initial=${{ opacity: 0, height: 0 }}
        animate=${{ opacity: 1, height: 'auto' }}
        exit=${{ opacity: 0, height: 0 }}
        transition=${SPRING}
        className="overflow-hidden"
      >
        <div className="mx-1 mb-1 mt-2 flex items-center gap-2.5 rounded-2xl bg-brand-600/[0.09] p-2 ring-1 ring-inset ring-brand-600/[0.14] dark:bg-brand-400/[0.13] dark:ring-brand-300/[0.16]">
          <${Thumb} video=${item} percent=${0} wide=${false} />
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-bold uppercase leading-[14px] tracking-[0.07em] text-accent">${item.caption}</div>
            <div className="truncate text-[13px] font-semibold leading-[17px] text-ink">${item.title || 'Add this video'}</div>
          </div>
          <${motion.button}
            type="button"
            onClick=${() => onAdd(item)}
            whileTap=${{ scale: 0.93 }}
            transition=${QUICK}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-brand-600 pl-2.5 pr-3 text-[12.5px] font-semibold text-white outline-none transition-colors duration-150 hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas dark:hover:bg-brand-500"
          >
            <${Icon.BookmarkPlus} size=${15} strokeWidth=${2.3} />
            Save
          <//>
        </div>
      <//>
    `;
  }

  /* --------------------------------------------------------------------------
   * Empty state
   * ------------------------------------------------------------------------ */
  function Key({ children }) {
    return html`<kbd
      className="mx-px inline-block rounded-[5px] bg-fill px-1 font-sans text-[11px] font-semibold leading-[17px] text-ink shadow-key"
    >
      ${children}
    </kbd>`;
  }

  function EmptyState() {
    const tips = [
      { icon: 'BookmarkPlus', body: 'Tap the bookmark on any YouTube thumbnail.' },
      { icon: 'MousePointerClick', body: html`Right-click a video link and choose${' '}<b className="font-semibold text-ink">Save to Watchlist</b>.` },
      { icon: 'Keyboard', body: html`<${Key}>Alt<//><${Key}>Shift<//><${Key}>S<//> saves what you’re watching.` },
    ];
    return html`
      <${motion.div}
        initial=${{ opacity: 0, y: 14 }}
        animate=${{ opacity: 1, y: 0 }}
        transition=${SPRING}
        className="flex flex-col items-center px-5 pb-10 pt-10 text-center"
      >
        <div className="relative mb-5 h-[92px] w-[92px]">
          <div className="absolute inset-3 rounded-[28px] bg-brand-500/40 blur-2xl" />
          <img src="../icons/icon128.png" alt="" draggable=${false} className="relative h-full w-full" />
        </div>
        <h2 className="font-display text-[21px] font-bold leading-[25px] tracking-[-0.024em] text-ink">Nothing saved yet</h2>
        <p className="mt-1.5 max-w-[252px] text-[13px] leading-[18px] text-ink-2">
          Save videos as you browse YouTube. They wait here until you’re ready to watch.
        </p>
        <${motion.button}
          type="button"
          onClick=${() => chrome.tabs.create({ url: 'https://www.youtube.com/' })}
          whileTap=${{ scale: 0.96 }}
          transition=${QUICK}
          className="mt-5 flex h-10 items-center gap-2 rounded-full bg-brand-600 pl-4 pr-5 text-[13.5px] font-semibold text-white shadow-tile outline-none transition-colors duration-150 hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas dark:hover:bg-brand-500"
        >
          <${Icon.Play} size=${14} strokeWidth=${2.4} fill="currentColor" />
          Open YouTube
        <//>

        <ul className="mt-9 w-full max-w-[300px] space-y-1 text-left">
          ${tips.map(
            (tip, index) => html`
              <${motion.li}
                key=${tip.icon}
                initial=${{ opacity: 0, y: 8 }}
                animate=${{ opacity: 1, y: 0 }}
                transition=${{ ...SPRING, delay: 0.08 + index * 0.05 }}
                className="flex items-center gap-3 rounded-2xl px-2 py-2"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-fill text-accent">
                  <${Icon[tip.icon]} size=${16} strokeWidth=${2.1} />
                </span>
                <span className="text-[12.5px] leading-[17px] text-ink-2">${tip.body}</span>
              <//>
            `
          )}
        </ul>
      <//>
    `;
  }

  /* --------------------------------------------------------------------------
   * Toast — every destructive action can be undone from here
   * ------------------------------------------------------------------------ */
  function Toast({ toast, onDismiss }) {
    return html`
      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3">
        <${AnimatePresence}>
          ${toast &&
          html`
            <${motion.div}
              key=${toast.key}
              role="status"
              initial=${{ opacity: 0, y: 26, scale: 0.92, filter: 'blur(8px)' }}
              animate=${{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit=${{ opacity: 0, y: 26, scale: 0.94, filter: 'blur(6px)', transition: { duration: 0.2, ease: 'easeIn' } }}
              transition=${SPRING}
              className="material-toast pointer-events-auto flex h-11 max-w-full items-center gap-2.5 rounded-full pl-2 pr-1.5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_0_0_1px_rgba(255,255,255,0.09),0_14px_36px_-6px_rgba(10,6,30,0.5)]"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]">
                <${Icon[toast.icon || 'Check']} size=${14} strokeWidth=${2.6} />
              </span>
              <span className=${cx('truncate text-[13px] font-medium', !toast.undo && 'pr-3')}>${toast.text}</span>
              ${toast.undo &&
              html`
                <${motion.button}
                  type="button"
                  whileTap=${{ scale: 0.93 }}
                  transition=${QUICK}
                  onClick=${() => {
                    toast.undo();
                    onDismiss();
                  }}
                  className="ml-1 h-8 shrink-0 rounded-full bg-white/[0.16] px-3.5 text-[12.5px] font-semibold outline-none transition-colors duration-150 hover:bg-white/[0.26] focus-visible:ring-2 focus-visible:ring-brand-300"
                >
                  Undo
                <//>
              `}
            <//>
          `}
        <//>
      </div>
    `;
  }

  /* --------------------------------------------------------------------------
   * App
   * ------------------------------------------------------------------------ */
  function App() {
    const { videos, setVideos, prefs, updatePrefs } = useStore();
    const active = useActiveVideo();
    const [query, setQuery] = useState('');
    const [scrolled, setScrolled] = useState(false);
    const [toast, setToast] = useState(null);
    const [dragOrder, setDragOrder] = useState(null);
    const dragOrderRef = useRef(null);
    const toastTimer = useRef(0);

    // Ids present at the last commit, so a video that arrives while the panel is open can announce itself.
    const seen = useRef(null);
    useEffect(() => {
      if (videos) seen.current = new Set(videos.map((video) => video.id));
    }, [videos]);

    const dismissToast = useCallback(() => {
      clearTimeout(toastTimer.current);
      setToast(null);
    }, []);

    const showToast = useCallback((next) => {
      clearTimeout(toastTimer.current);
      setToast({ ...next, key: Date.now() });
      toastTimer.current = setTimeout(() => setToast(null), next.undo ? 5200 : 2600);
    }, []);

    /* ----- actions ----- */
    const actions = useMemo(
      () => ({
        onOpen: (video, inNewTab) => openVideo(video, inNewTab),

        onRemove: (video) => {
          let index = 0;
          setVideos((current) => {
            index = Math.max(0, current.findIndex((entry) => entry.id === video.id));
            return current.filter((entry) => entry.id !== video.id);
          });
          send({ type: 'remove', id: video.id });
          showToast({
            text: 'Removed from Watchlist',
            icon: 'Trash2',
            undo: () => send({ type: 'restore', items: [{ video, index }] }),
          });
        },

        onToggleWatched: (video) => {
          const watched = !video.watched;
          setVideos((current) =>
            current.map((entry) =>
              entry.id === video.id ? { ...entry, watched, watchedAt: watched ? Date.now() : 0 } : entry
            )
          );
          send({ type: 'setWatched', id: video.id, watched });
          showToast({
            text: watched ? 'Marked as watched' : 'Back in Up next',
            icon: watched ? 'Check' : 'Undo2',
            undo: () => send({ type: 'setWatched', id: video.id, watched: !watched }),
          });
        },
      }),
      [setVideos, showToast]
    );

    const clearWatched = async () => {
      setVideos((current) => current.filter((entry) => !entry.watched));
      const res = await send({ type: 'clearWatched' });
      const removed = (res.ok && res.removed) || [];
      if (!removed.length) return;
      showToast({
        text: removed.length === 1 ? 'Cleared 1 watched video' : `Cleared ${removed.length} watched videos`,
        icon: 'Trash2',
        undo: () => send({ type: 'restore', items: removed }),
      });
    };

    const addVideo = async (item) => {
      const res = await send({ type: 'add', video: { id: item.id, title: item.title, kind: item.kind } });
      if (!res.ok) {
        showToast({ text: 'Could not save that video', icon: 'X' });
        return;
      }
      if (item.fromLink) setQuery('');
    };

    /* ----- derive what is on screen ----- */
    const list = videos || [];
    const rawQuery = query.trim();
    const needle = rawQuery.toLowerCase();
    const linkId = /youtu\.?be/i.test(rawQuery) ? parseVideoId(rawQuery) : null;

    const savedIds = useMemo(() => new Set(list.map((video) => video.id)), [list]);
    const matches = (video) => {
      if (!needle) return true;
      if (linkId) return video.id === linkId;
      return (video.title || '').toLowerCase().includes(needle) || (video.channel || '').toLowerCase().includes(needle);
    };

    const queue = list.filter((video) => !video.watched);
    const watched = list.filter((video) => video.watched).sort((a, b) => b.watchedAt - a.watchedAt);
    const canDrag = prefs.sort === 'manual' && !needle;

    let queueShown = sortQueue(queue.filter(matches), prefs.sort);
    if (dragOrder && canDrag) {
      // Mid-drag, the order under the pointer wins; anything that arrived meanwhile goes on top.
      const byId = new Map(queueShown.map((video) => [video.id, video]));
      const held = new Set(dragOrder);
      queueShown = [
        ...queueShown.filter((video) => !held.has(video.id)),
        ...dragOrder.map((id) => byId.get(id)).filter(Boolean),
      ];
    }
    const watchedShown = watched.filter(matches);

    let quickAdd = null;
    if (linkId && !savedIds.has(linkId)) {
      quickAdd = { id: linkId, title: '', caption: 'From your link', kind: isShortUrl(rawQuery) ? 'short' : 'video', fromLink: true };
    } else if (!needle && videos && active && !savedIds.has(active.id)) {
      quickAdd = { ...active, caption: 'Playing in this tab' };
    }

    const remaining = queue.reduce(
      (total, video) => total + (video.duration ? Math.max(0, video.duration - (video.progress || 0)) : 0),
      0
    );
    let subtitle = ' ';
    if (videos) {
      if (!list.length) subtitle = 'Your watch-later queue';
      else if (!queue.length) subtitle = 'All caught up';
      else subtitle = `${queue.length} to watch` + (remaining >= 60 ? ` · ${formatLength(remaining)} left` : '');
    }

    const searching = !!needle;
    const nothingFound = searching && !queueShown.length && !watchedShown.length && !quickAdd;
    const queueOpen = searching || prefs.queueOpen;
    const watchedOpen = searching || prefs.watchedOpen;
    // While searching, a section only appears if it has a match.
    const showQueue = searching ? queueShown.length > 0 : list.length > 0;
    const showWatched = watchedShown.length > 0;

    /* ----- drag to reorder ----- */
    const onReorder = (ids) => {
      dragOrderRef.current = ids;
      setDragOrder(ids);
    };
    const onDragEnd = () => {
      const ids = dragOrderRef.current;
      dragOrderRef.current = null;
      if (ids) {
        setVideos((current) => reorderWithin(current, ids));
        send({ type: 'reorder', ids });
      }
      setDragOrder(null);
    };
    const noop = () => {};

    return html`
      <${MotionConfig} reducedMotion="user" transition=${SPRING}>
        <${motion.div}
          id="app"
          layoutScroll
          onScroll=${(event) => {
            const next = event.currentTarget.scrollTop > 2;
            if (next !== scrolled) setScrolled(next);
          }}
          className="scroller [--tw-on:1] h-full overflow-y-auto overflow-x-hidden bg-canvas font-sans text-ink"
        >
          <${Header}
            scrolled=${scrolled}
            subtitle=${subtitle}
            query=${query}
            onQuery=${setQuery}
            sort=${prefs.sort}
            onSort=${(sort) => updatePrefs({ sort })}
          />

          <main className="px-2 pb-20">
            <${AnimatePresence} initial=${false}>
              ${quickAdd && html`<${QuickAdd} key=${quickAdd.id} item=${quickAdd} onAdd=${addVideo} />`}
            <//>

            ${videos && !list.length && !quickAdd && !searching && html`<${EmptyState} />`}

            ${nothingFound &&
            html`<${Note} icon="SearchX">Nothing in your Watchlist matches “${rawQuery}”.<//>`}

            ${showQueue &&
            html`
              <${Section}
                key="queue"
                title="Up next"
                count=${queueShown.length}
                open=${queueOpen}
                onToggle=${() => updatePrefs({ queueOpen: !prefs.queueOpen })}
              >
                ${queueShown.length
                  ? html`<${VideoList}
                      items=${queueShown}
                      canDrag=${canDrag}
                      seen=${seen.current}
                      onReorder=${onReorder}
                      onDragStart=${noop}
                      onDragEnd=${onDragEnd}
                      actions=${actions}
                    />`
                  : html`<${Note} icon="PartyPopper">You’re all caught up. Save something new on YouTube.<//>`}
              <//>
            `}

            ${showWatched &&
            html`
              <${Section}
                key="watched"
                title="Watched"
                count=${watchedShown.length}
                open=${watchedOpen}
                onToggle=${() => updatePrefs({ watchedOpen: !prefs.watchedOpen })}
                action=${!searching &&
                html`
                  <${motion.button}
                    type="button"
                    onClick=${clearWatched}
                    whileTap=${{ scale: 0.94 }}
                    transition=${QUICK}
                    className="h-7 rounded-full px-2.5 text-[12px] font-semibold text-accent outline-none transition-colors duration-150 hover:bg-fill focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    Clear
                  <//>
                `}
              >
                <${VideoList}
                  items=${watchedShown}
                  canDrag=${false}
                  seen=${seen.current}
                  onReorder=${noop}
                  onDragStart=${noop}
                  onDragEnd=${noop}
                  actions=${actions}
                />
              <//>
            `}
          </main>
        <//>

        <${Toast} toast=${toast} onDismiss=${dismissToast} />
      <//>
    `;
  }

  /* --------------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------------ */

  /**
   * The Tailwind CDN build only compiles classes it has seen in the DOM, which would make
   * anything that mounts later (menu, toast, a new row) flash unstyled for a frame.
   * Feeding it this file's source up front compiles every class before first paint.
   */
  async function warmTailwind() {
    try {
      const source = await (await fetch('app.js')).text();
      const tokens = new Set(source.split(/[\s"'`<>]+|\$\{|\}/));
      const classes = [];
      for (const token of tokens) {
        if (token.length > 1 && token.length < 120 && /^[!\-a-z[]/.test(token) && !/[;=]$/.test(token)) classes.push(token);
      }
      document.getElementById('tw-warm').className = classes.join(' ');
    } catch (_) {
      /* styles will still compile on demand */
    }
  }

  /** Resolves once Tailwind has styled the rendered app (or after a short grace period). */
  function whenStyled() {
    return new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        const app = document.getElementById('app');
        const styled = app && getComputedStyle(app).getPropertyValue('--tw-on').trim() === '1';
        if (styled || performance.now() - started > 1500) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  async function boot() {
    await warmTailwind();
    ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
    await whenStyled();
    requestAnimationFrame(() => document.documentElement.classList.add('ready'));
  }

  boot();
})();
