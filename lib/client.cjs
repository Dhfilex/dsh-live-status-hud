window.__ModuleLoader__.load({
  id: 'dsh-live-status-hud',
  factory(require) {
    'use strict';

// Single-file lazy-CJS Client bundle for DeepSeek Harness (dsh 0.2.2-rc.3+)
// Uses exact DSH 0.2.2-rc.3 slot API: ctx.slots.register({ name: 'shell.overlay', id }, Component)
// Externalizes only baseline `react` (zero JSX, zero bundler required at runtime).

const React = require('react');
const { useState, useEffect, useMemo, useRef } = React;
const h = React.createElement;

const HTTP_PATH_SNAPSHOT = '/dsh-live-status-hud/snapshot';
const HTTP_PATH_SETTINGS = '/dsh-live-status-hud/settings';
const POLL_ACTIVE_MS = 750;
const POLL_IDLE_MS = 2000;
const STORAGE_KEY_COMPANION_POS = 'dsh-live-status-hud:companion-pos';
const STORAGE_KEY_SESSION_PREFIX = 'dsh-live-status-hud:session:';
const STORAGE_KEY_WHALE_MODE = 'dsh-live-status-hud:display-mode';
const STORAGE_KEY_BUBBLE_OFFSET = 'dsh-live-status-hud:bubble-offset';
const STORAGE_KEY_AI_SUMMARY = 'dsh-live-status-hud:ai-summary';
const STORAGE_KEY_PREFS = 'dsh-live-status-hud:prefs';
const PREFS_EVENT = 'dsh-live-status-hud:prefs-changed';
const OWN_ROOT_ATTR = 'data-dsh-live-status-hud';

const PHASE_META = {
  idle: { badge: '🫧 摸鱼中', accent: '#3b82f6', bg: '#eff6ff' },
  thinking: { badge: '💭 动脑筋', accent: '#2563eb', bg: '#eff6ff' },
  running_tool: { badge: '🔧 干活中', accent: '#d97706', bg: '#fffbeb' },
  waiting_approval: { badge: '🙋 求批准', accent: '#ea580c', bg: '#fff7ed' },
  streaming: { badge: '✍️ 码字中', accent: '#059669', bg: '#ecfdf5' },
  done: { badge: '✨ 搞定啦', accent: '#16a34a', bg: '#f0fdf4' },
  error: { badge: '😵 绊倒了', accent: '#dc2626', bg: '#fef2f2' },
};

const IDLE_GREETINGS = [
  '悠闲吐泡泡待命中，随时喊我干活~',
  '安安静静陪着你呢，有活随时吩咐~',
  '小鲸鱼在线待命，发条消息我就冲！',
];

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatShortSec(ms) {
  const safe = Math.max(0, ms || 0);
  if (safe < 1000) return `${(safe / 1000).toFixed(1)}s`;
  const sec = safe / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s}s`;
}

const TIMELINE_NODE_STYLE = {
  thought: { dot: '#3b82f6', icon: '💭', label: '思考' },
  tool: { dot: '#f59e0b', icon: '🔧', label: '工具' },
  approval: { dot: '#f97316', icon: '🙋', label: '审批' },
  done: { dot: '#16a34a', icon: '✨', label: '完成' },
  error: { dot: '#dc2626', icon: '😵', label: '报错' },
};

function loadUserPrefs() {
  const defaults = { persona: null, notifyMode: 'background', soundEnabled: false, hideWhenIdle: null, idleAutoMinimizeMs: null, customSelector: '' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFS);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') return { ...defaults, ...p };
    }
  } catch {}
  return defaults;
}

function saveUserPrefs(patch) {
  const next = { ...loadUserPrefs(), ...patch };
  try { window.localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(next)); } catch {}
  try { window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next })); } catch {}
  return next;
}

function playGentleChime(kind) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = kind === 'error' ? [330, 262] : kind === 'waiting_approval' ? [587, 784] : [523, 659];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + idx * 0.11;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    });
    setTimeout(() => { try { ctx.close(); } catch {} }, 800);
  } catch {}
}

function triggerDesktopAlert(phase, headline, detail, prefs) {
  if (!prefs || prefs.notifyMode === 'off') return;
  const isHidden = typeof document !== 'undefined' && (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()));
  if (prefs.notifyMode === 'background' && !isHidden) return;
  if (prefs.soundEnabled) playGentleChime(phase);
  try {
    if (typeof Notification === 'function' && Notification.permission === 'granted') {
      const title = phase === 'waiting_approval' ? 'DSH 等待你的操作审批' : phase === 'error' ? 'DSH 任务执行报错' : 'DSH 任务已完成';
      const body = detail ? `${headline} — ${String(detail).slice(0, 80)}` : headline;
      new Notification(title, { body, silent: !prefs.soundEnabled });
    }
  } catch {}
}

function buildTimelineMarkdown(headline, phaseDurations, nodes, now) {
  const lines = [`### ${headline}`];
  const d = phaseDurations || {};
  const stats = [];
  if (d.thinkingMs > 0) stats.push(`思考 ${formatShortSec(d.thinkingMs)}`);
  if (d.toolMs > 0) stats.push(`工具 ${formatShortSec(d.toolMs)}`);
  if (d.approvalMs > 0) stats.push(`审批 ${formatShortSec(d.approvalMs)}`);
  if (d.streamingMs > 0) stats.push(`输出 ${formatShortSec(d.streamingMs)}`);
  if (stats.length > 0) lines.push(`> 耗时分布：${stats.join(' · ')}`);
  lines.push('');
  for (const n of nodes || []) {
    const st = TIMELINE_NODE_STYLE[n.kind] || TIMELINE_NODE_STYLE.thought;
    const dur = n.kind !== 'done' && n.kind !== 'error' ? ` (${formatShortSec(Math.max(0, (n.endedAt ?? now) - (n.startedAt || now)))})` : '';
    lines.push(`- ${st.icon} **${n.title}**${dur}`);
    if (n.detail && n.detail !== n.title) {
      lines.push('  ```');
      lines.push(...String(n.detail).split('\n').map((l) => `  ${l}`));
      lines.push('  ```');
    }
  }
  return lines.join('\n');
}

function formatClock(ts) {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}


function useIsDarkMode() {
  const [dark, setDark] = useState(() => {
    try {
      if (document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark') return true;
      return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const htmlDark = document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark';
      setDark(htmlDark || mq.matches);
    };
    mq.addEventListener?.('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => {
      mq.removeEventListener?.('change', update);
      mo.disconnect();
    };
  }, []);
  return dark;
}

function loadSavedSessionStatus(sessionId) {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_SESSION_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessionId === sessionId) {
      return {
        ...parsed,
        history: Array.isArray(parsed.history) ? parsed.history : [],
        recentSteps: Array.isArray(parsed.recentSteps) ? parsed.recentSteps : [],
      };
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function saveSessionStatus(sessionId, status) {
  try {
    window.localStorage.setItem(`${STORAGE_KEY_SESSION_PREFIX}${sessionId}`, JSON.stringify(status));
  } catch {
    // Ignore quota errors
  }
}

function mergeHistory(primary = [], saved = []) {
  const byId = new Map();
  for (const run of [...primary, ...saved]) {
    if (run && run.id && !byId.has(run.id)) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 15);
}

// --- Optional third-party mascot anchor (can be disabled via whaleAdapter.enabled: false) ---
const KNOWN_WIDGET_RULES = [
  {
    kind: 'whale-widget',
    headroomRatio: 0.03,
    spriteSelectors: [
      'img.dshwv-img',
      'img[src*="/dsh-whale/image"]',
      'img[src*="DSniang"]',
      '.dshwv-body img',
      '.dshwv-body',
    ],
    bubbleSelectors: ['.dshwv-bshape', '.dshwv-bubble svg', '.dshwv-bubble'],
    scopeBubbleToRoot: false,
  },
  {
    kind: 'dsh-pet',
    headroomRatio: 0.22,
    spriteSelectors: [
      '[class*="dsh-pet"] video',
      '[class*="dsh-pet"] canvas',
      '[class*="dsh-pet"] img',
      '[id*="dsh-pet"] video',
      '[id*="dsh-pet"] canvas',
      '[id*="dsh-pet"] img',
      '[data-dsh-pet] video',
      '[data-dsh-pet] canvas',
      '[data-dsh-pet] img',
      'video[src*="dsh-pet"]',
      'img[src*="dsh-pet"]',
    ],
    bubbleSelectors: ['[class*="bubble"]', '[class*="speech"]', '[class*="toast"]', '[class*="say"]'],
    scopeBubbleToRoot: true,
  },
  {
    kind: 'whale-musume',
    headroomRatio: 0.02,
    spriteSelectors: [
      '[class*="whale-musume"] img',
      '[id*="whale-musume"] img',
      '[class*="musume"] img',
      'img[src*="whale-musume"]',
      '[class*="whale-pet"] img',
      '[class*="whale-pet"] canvas',
      '[id*="whale-pet"] img',
      '[class*="deepseek-pet"] img',
      '[class*="deepseek-pet"] canvas',
      '[id*="deepseek-pet"] img',
      '[class*="whale-maid"] img',
      '[class*="whalechan"] img',
      '[class*="dsh-wisp"] canvas',
      '[class*="dsh-wisp"] img',
    ],
    bubbleSelectors: ['[class*="bubble"]', '[class*="speech"]', '[class*="dialog"]', '[class*="toast"]'],
    scopeBubbleToRoot: true,
  },
  {
    kind: 'deepseek-girl-pet',
    headroomRatio: 0.04,
    spriteSelectors: [
      '[class*="deepseek-girl"] img',
      '[id*="deepseek-girl"] img',
      'img[src*="deepseek-girl-pet"]',
      '[class*="deepseek-girl"]',
      '[id*="deepseek-girl"]',
      '[style*="deepseek-girl-pet"]',
      '[style*="spritesheet.webp"]',
    ],
    bubbleSelectors: ['[class*="bubble"]', '[class*="speech"]'],
    scopeBubbleToRoot: true,
  },
  {
    kind: 'live2d-pet',
    headroomRatio: 0.18,
    spriteSelectors: [
      '[class*="live2d"] canvas',
      '[id*="live2d"] canvas',
      'canvas[class*="live2d"]',
      'canvas[id*="live2d"]',
      'canvas[class*="cubism"]',
      '[data-live2d] canvas',
    ],
    bubbleSelectors: ['[class*="bubble"]', '[class*="speech"]', '[class*="toast"]'],
    scopeBubbleToRoot: true,
  },
  {
    kind: 'kun-like-pet',
    headroomRatio: 0.18,
    spriteSelectors: [
      '[class*="kun-like"] img',
      '[class*="kun-like"] canvas',
      '[class*="kun-pet"] img',
      '[id*="kun-like"] img',
      'img[src*="kun-like"]',
    ],
    bubbleSelectors: ['[class*="bubble"]', '[class*="speech"]'],
    scopeBubbleToRoot: true,
  },
  {
    kind: 'dsh-dafeiyu',
    headroomRatio: 0.22,
    spriteSelectors: [
      '[class*="dafeiyu"] img',
      '[class*="dafeiyu"] canvas',
      '[class*="dafeiyu"] video',
      '[id*="dafeiyu"] img',
      '[class*="dafeiyu"]',
    ],
    bubbleSelectors: ['[class*="bubble"]', '[class*="speech"]', '[class*="toast"]'],
    scopeBubbleToRoot: true,
  },
];

function toAnchorRect(r) {
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
}

function isElementReallyVisible(el, minW = 24, minH = 24) {
  if (!el || el.closest(`[${OWN_ROOT_ATTR}]`)) return false;
  let curr = el;
  let depth = 0;
  while (curr && curr !== document.body && depth < 6) {
    const cs = window.getComputedStyle(curr);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const opacity = Number.parseFloat(cs.opacity || '1');
    if (Number.isFinite(opacity) && opacity < 0.15) return false;
    curr = curr.parentElement;
    depth++;
  }
  const rect = el.getBoundingClientRect();
  return rect.width >= minW && rect.height >= minH;
}

function getFixedOverlayRoot(el) {
  let curr = el;
  let depth = 0;
  while (curr && curr !== document.body && depth < 8) {
    const cs = window.getComputedStyle(curr);
    if (cs.position === 'fixed') return curr;
    curr = curr.parentElement;
    depth++;
  }
  return el.parentElement || null;
}

// Strictly reject images inside scrollable lists (Plugin Marketplace cards, chat history, modals)!
function isTrueFloatingMascotOverlay(el) {
  if (!el || el.closest(`[${OWN_ROOT_ATTR}]`)) return false;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 720;
  let curr = el;
  let depth = 0;
  while (curr && curr !== document.body && depth < 10) {
    const cs = window.getComputedStyle(curr);
    const pos = cs.position;
    const isScrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (pos === 'fixed') {
      const r = curr.getBoundingClientRect();
      // Reject full-screen scrollable app shells/drawers; allow actual floating overlay roots
      if (isScrollable && r.width >= vw * 0.7 && r.height >= vh * 0.7) return false;
      return true;
    }
    // Hit a scrolling container (e.g. Plugin Marketplace or chat feed) before any fixed overlay -> NOT a mascot!
    if (isScrollable && curr.scrollHeight > curr.clientHeight + 4) return false;
    curr = curr.parentElement;
    depth++;
  }
  return false;
}

function findOpenBubbleForSprite(sprite, bubbleSelectors, scopeToRoot = false) {
  const searchRoot = scopeToRoot ? getFixedOverlayRoot(sprite) : document;
  if (!searchRoot) return null;
  for (const bSel of bubbleSelectors) {
    try {
      const nodes = searchRoot.querySelectorAll(bSel);
      for (const bEl of nodes) {
        if (bEl !== sprite && !bEl.contains(sprite) && isElementReallyVisible(bEl, 55, 36)) {
          return toAnchorRect(bEl.getBoundingClientRect());
        }
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

function findWidgetAndBubble(customSelector) {
  if (customSelector) {
    try {
      const customEl = document.querySelector(customSelector);
      if (isElementReallyVisible(customEl, 24, 24)) {
        return {
          kind: 'generic-mascot',
          sprite: customEl,
          bubbleRect: findOpenBubbleForSprite(customEl, ['.dshwv-bshape', '.dshwv-bubble']),
        };
      }
    } catch {
      // Ignore invalid selector
    }
  }
  for (const rule of KNOWN_WIDGET_RULES) {
    for (const sel of rule.spriteSelectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (!isElementReallyVisible(el, 24, 24)) continue;
          if (!isTrueFloatingMascotOverlay(el)) continue;
          return {
          kind: rule.kind,
          headroomRatio: rule.headroomRatio,
          sprite: el,
          bubbleRect: findOpenBubbleForSprite(el, rule.bubbleSelectors, Boolean(rule.scopeBubbleToRoot)),
          };
        }
      } catch {
        // Ignore
      }
    }
  }
  // Generic heuristic: any visible fixed-position corner/edge mascot (img/canvas/video) with z-index >= 50
  try {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;
    // Cover img/canvas/video (up to 480px for Live2D canvases) + CSS spritesheet overlays
    for (const node of document.querySelectorAll('img, canvas, video, [style*="background-image"]')) {
      if (!isElementReallyVisible(node, 48, 48)) continue;
      if (!isTrueFloatingMascotOverlay(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 480 || rect.height > 480) continue;
      let curr = node;
      let isFixedOverlay = false;
      let depth = 0;
      while (curr && curr !== document.body && depth < 8) {
        const cs = window.getComputedStyle(curr);
        const z = Number.parseInt(cs.zIndex || '0', 10);
        if (cs.position === 'fixed' && (!Number.isNaN(z) && z >= 20)) {
          isFixedOverlay = true;
          break;
        }
        curr = curr.parentElement;
        depth++;
      }
      if (!isFixedOverlay) continue;
      // Roaming pets (like dsh-pet) walk across the whole screen: any fixed z>=50 sprite qualifies,
      // with corner proximity only as a tie-breaker so we NEVER lose lock mid-walk!
      const score = 1 + (rect.bottom >= vh * 0.5 ? 2 : 0) + (rect.left <= vw * 0.25 || rect.right >= vw * 0.75 ? 1 : 0);
      if (!best || score > best.score) best = { el: node, score };
    }
    if (best) {
      const tag = (best.el.tagName || '').toLowerCase();
      const defaultRatio = tag === 'video' ? 0.26 : tag === 'canvas' ? 0.22 : 0.16;
      return {
        kind: 'generic-mascot',
        headroomRatio: defaultRatio,
        sprite: best.el,
        bubbleRect: findOpenBubbleForSprite(best.el, ['[class*="bubble"]', '[class*="speech"]', '[class*="toast"]'], true),
      };
    }
  } catch {
    // Ignore heuristic DOM scan errors
  }
  return { kind: 'none', sprite: null, bubbleRect: null };
}

function useWhaleAnchor(enabled, customSelector) {
  const [anchor, setAnchor] = useState({
    found: false,
    widgetKind: 'none',
    avatarRect: null,
    isLeftFlipped: false,
    widgetBubbleRect: null,
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') {
      setAnchor({ found: false, widgetKind: 'none', avatarRect: null, isLeftFlipped: false, widgetBubbleRect: null });
      return;
    }

    let rafId = 0;
    let lastFoundAt = 0;
    const LOST_GRACE_MS = 1500;
    const measure = () => {
      rafId = 0;
      const { kind, headroomRatio, sprite, bubbleRect } = findWidgetAndBubble(customSelector);
      if (!sprite) {
        // Grace period prevents teleporting to built-in whale when roaming pets swap animation frames
        if (lastFoundAt > 0 && Date.now() - lastFoundAt < LOST_GRACE_MS) return;
        setAnchor((prev) =>
          prev.found
            ? { found: false, widgetKind: 'none', avatarRect: null, isLeftFlipped: false, widgetBubbleRect: null }
            : prev,
        );
        return;
      }
      lastFoundAt = Date.now();
      const avatarRect = toAnchorRect(sprite.getBoundingClientRect());
      const centerX = avatarRect.left + avatarRect.width / 2;
      const isLeftFlipped = Boolean(
        sprite.closest('.dshwv-left') || sprite.classList.contains('dshwv-left') || centerX < window.innerWidth * 0.35,
      );
      setAnchor((prev) => {
        const sameAvatar =
          prev.found &&
          prev.widgetKind === kind &&
          prev.isLeftFlipped === isLeftFlipped &&
          prev.avatarRect &&
          Math.abs(prev.avatarRect.left - avatarRect.left) < 1 &&
          Math.abs(prev.avatarRect.top - avatarRect.top) < 1;
        const sameBubble =
          (!prev.widgetBubbleRect && !bubbleRect) ||
          (prev.widgetBubbleRect &&
            bubbleRect &&
            Math.abs(prev.widgetBubbleRect.top - bubbleRect.top) < 1 &&
            Math.abs(prev.widgetBubbleRect.left - bubbleRect.left) < 1);
        if (sameAvatar && sameBubble) return prev;
        return { found: true, widgetKind: kind, headroomRatio: headroomRatio ?? 0.18, avatarRect, isLeftFlipped, widgetBubbleRect: bubbleRect };
      });
    };

    const scheduleMeasure = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(measure);
    };

    measure();
    const mo = new MutationObserver(scheduleMeasure);
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', scheduleMeasure, { passive: true });
    window.addEventListener('pointerup', scheduleMeasure, { passive: true });
    const interval = window.setInterval(scheduleMeasure, 300);

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      mo.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('pointerup', scheduleMeasure);
      window.clearInterval(interval);
    };
  }, [enabled, customSelector]);

  return anchor;
}

// --- Built-in freely draggable SVG mini whale companion ("小鲸灵") ---
function clampCompanionPos(pos) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  const x = Math.min(Math.max(8, Math.round(pos.x)), Math.max(8, vw - 74));
  const y = Math.min(Math.max(8, Math.round(pos.y)), Math.max(8, vh - 70));
  return { x, y };
}
function getDefaultCompanionPos() {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  return clampCompanionPos({ x: vw - 84, y: vh - 78 });
}
function DefaultMiniCompanion({ phase, pos, isDragging, onDragStart, onResetPos }) {
  const isWorking = phase === 'thinking' || phase === 'running_tool' || phase === 'streaming';
  const isAlert = phase === 'waiting_approval' || phase === 'error';
  const isDone = phase === 'done';
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const isLeftHalf = pos.x + 33 < vw / 2;

  return h(
    'div',
    {
      [OWN_ROOT_ATTR]: 'companion',
      onPointerDown: onDragStart,
      onDoubleClick: onResetPos,
      title: '小鲸灵（按住可自由拖动位置，双击回到右下角）',
      'aria-label': '小鲸灵状态挂件',
      style: {
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 2147483644,
        pointerEvents: 'auto',
        cursor: isDragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
      },
    },
    h('style', null, `
      @keyframes dshMiniFloat { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-4px); } }
      @keyframes dshMiniWork { 0%,100% { transform: translateY(0px) scale(1); } 50% { transform: translateY(-5px) scale(1.04,0.96); } }
    `),
    h(
      'div',
      {
        style: {
          display: 'block',
          transform: isLeftHalf ? 'scaleX(-1)' : undefined,
        },
      },
      h(
        'svg',
        {
          width: 66,
          height: 62,
          viewBox: '0 0 66 62',
          fill: 'none',
          style: {
            filter: 'drop-shadow(0 6px 12px rgba(32, 49, 112, 0.24))',
            animation: isWorking ? 'dshMiniWork 1.1s ease-in-out infinite' : 'dshMiniFloat 2.8s ease-in-out infinite',
          },
        },
        h('path', { d: 'M54 35 C61 31, 64 25, 62 21 C59 24, 56 26, 53 28 C57 29, 61 33, 63 38 C59 39, 55 38, 52 36 Z', fill: '#60a5fa', stroke: '#203170', strokeWidth: '2.4', strokeLinejoin: 'round' }),
        h('path', { d: 'M10 34 C10 19, 22 11, 35 12 C48 13, 55 22, 55 34 C55 46, 46 53, 32 53 C18 53, 10 46, 10 34 Z', fill: isAlert ? '#fed7aa' : '#93c5fd', stroke: '#203170', strokeWidth: '2.6', strokeLinejoin: 'round' }),
        h('path', { d: 'M15 41 C20 48, 36 50, 46 44 C38 45, 24 44, 15 41 Z', fill: '#eff6ff' }),
        isWorking ? h('path', { d: 'M32 10 C32 5, 27 3, 25 6 M32 10 C32 5, 37 3, 39 6', stroke: '#38bdf8', strokeWidth: '2.4', strokeLinecap: 'round' }) : null,
        h('ellipse', { cx: 18, cy: 36, rx: 3.4, ry: 2, fill: '#fda4af', opacity: '0.85' }),
        h('ellipse', { cx: 42, cy: 36, rx: 3.4, ry: 2, fill: '#fda4af', opacity: '0.85' }),
        isDone
          ? h(React.Fragment, null,
              h('path', { d: 'M21 31 Q24 27 27 31', stroke: '#203170', strokeWidth: '2.4', strokeLinecap: 'round', fill: 'none' }),
              h('path', { d: 'M33 31 Q36 27 39 31', stroke: '#203170', strokeWidth: '2.4', strokeLinecap: 'round', fill: 'none' }),
            )
          : phase === 'error'
            ? h(React.Fragment, null,
                h('path', { d: 'M21 28 L26 33 M26 28 L21 33', stroke: '#dc2626', strokeWidth: '2.2', strokeLinecap: 'round' }),
                h('path', { d: 'M34 28 L39 33 M39 28 L34 33', stroke: '#dc2626', strokeWidth: '2.2', strokeLinecap: 'round' }),
              )
            : h(React.Fragment, null,
                h('circle', { cx: 24, cy: 30, r: 3, fill: '#203170' }),
                h('circle', { cx: 23, cy: 29, r: 1, fill: '#ffffff' }),
                h('circle', { cx: 36, cy: 30, r: 3, fill: '#203170' }),
                h('circle', { cx: 35, cy: 29, r: 1, fill: '#ffffff' }),
              ),
        h('path', { d: isAlert ? 'M28 36 Q30 34 32 36' : 'M27 35 Q30 38 33 35', stroke: '#203170', strokeWidth: '2', strokeLinecap: 'round', fill: 'none' }),
      ),
    ),
  );
}

// --- Main Comic Thought Bubble with 3-tab Drawer & Hover-Aware Auto-Minimize ---
function WhaleThoughtBubble({
  status,
  isSessionRunning = false,
  anchor,
  companionPos = null,
  isDraggingCompanion = false,
  conflictStrategy = 'stack',
  showThoughtChain = true,
  hideWhenIdle = false,
  idleAutoMinimizeMs = 12_000,
  onClearHistory,
  displayMode = 'follow',
  onCycleDisplayMode,
  aiSummary = { enabled: false, configured: false },
  onToggleAiSummary,
  userPrefs = null,
  persona = 'playful',
  onUpdatePref,
  onChangePersona,
  onResetPositions,
}) {
  const isDark = useIsDarkMode();
  const surfaceBg = isDark ? '#162038' : '#ffffff';
  const borderCol = isDark ? '#60a5fa' : '#203170';
  const textPrimary = isDark ? '#f1f5f9' : '#203170';
  const textSecondary = isDark ? '#94a3b8' : '#536ba9';
  const subtleBg = isDark ? '#1e293b' : '#f8fafc';
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState('timeline');
  const [expandedNodeIds, setExpandedNodeIds] = useState({});
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [copiedFlag, setCopiedFlag] = useState(false);
  const toggleTimelineNode = (id) => setExpandedNodeIds((prev) => ({ ...prev, [id]: !prev[id] }));
  const handleCopyTimeline = async (headline, durations, nodes) => {
    const md = buildTimelineMarkdown(headline, durations, nodes, now);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(md);
      } else {
        const ta = document.createElement('textarea');
        ta.value = md;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedFlag(true);
      window.setTimeout(() => setCopiedFlag(false), 1600);
    } catch {}
  };
  const [muted, setMuted] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [idleIndex, setIdleIndex] = useState(0);
  const prevActiveRef = useRef(false);
  const [bubbleOffset, setBubbleOffset] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY_BUBBLE_OFFSET);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p.dx === 'number' && typeof p.dy === 'number') return p;
      }
    } catch {}
    return { dx: 0, dy: 0 };
  });
  const [isDraggingBubble, setIsDraggingBubble] = useState(false);
  const bubbleDragRef = useRef(null);

  const handleBubbleDragStart = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    e.preventDefault?.();
    bubbleDragRef.current = { startX: e.clientX, startY: e.clientY, origDx: bubbleOffset.dx, origDy: bubbleOffset.dy };
    setIsDraggingBubble(true);
    const onMove = (ev) => {
      if (!bubbleDragRef.current) return;
      setBubbleOffset({
        dx: Math.round(bubbleDragRef.current.origDx + (ev.clientX - bubbleDragRef.current.startX)),
        dy: Math.round(bubbleDragRef.current.origDy + (ev.clientY - bubbleDragRef.current.startY)),
      });
    };
    const onUp = (ev) => {
      if (bubbleDragRef.current) {
        const finalOff = {
          dx: Math.round(bubbleDragRef.current.origDx + (ev.clientX - bubbleDragRef.current.startX)),
          dy: Math.round(bubbleDragRef.current.origDy + (ev.clientY - bubbleDragRef.current.startY)),
        };
        setBubbleOffset(finalOff);
        try { window.localStorage.setItem(STORAGE_KEY_BUBBLE_OFFSET, JSON.stringify(finalOff)); } catch {}
      }
      bubbleDragRef.current = null;
      setIsDraggingBubble(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleResetBubbleOffset = () => {
    const zero = { dx: 0, dy: 0 };
    setBubbleOffset(zero);
    try { window.localStorage.setItem(STORAGE_KEY_BUBBLE_OFFSET, JSON.stringify(zero)); } catch {}
  };

  const effectiveStatus = useMemo(() => {
    if (status) return status;
    return {
      sessionId: 'idle',
      phase: 'idle',
      headline: IDLE_GREETINGS[idleIndex % IDLE_GREETINGS.length],
      thoughtBuffer: '',
      thoughtBufferZh: '',
      stepCount: 0,
      activeTools: [],
      turnStartedAt: null,
      phaseStartedAt: now,
      updatedAt: now,
      isStalled: false,
      recentSteps: [],
      timeline: [],
      phaseDurations: { thinkingMs: 0, toolMs: 0, approvalMs: 0, streamingMs: 0 },
      history: [],
    };
  }, [status, idleIndex, now]);

  const isIdle = effectiveStatus.phase === 'idle';
  const isActive =
    isSessionRunning ||
    effectiveStatus.phase === 'thinking' ||
    effectiveStatus.phase === 'running_tool' ||
    effectiveStatus.phase === 'waiting_approval' ||
    effectiveStatus.phase === 'streaming';

  useEffect(() => {
    if (isActive && !prevActiveRef.current) setMuted(false);
    prevActiveRef.current = isActive;
  }, [isActive]);

  // Auto-minimize BOTH drawer and main bubble when idle/done and mouse is not hovering
  useEffect(() => {
    if (idleAutoMinimizeMs <= 0 || isActive || muted || isHovering) return;
    const timer = window.setTimeout(() => {
      setExpanded(false);
      setMuted(true);
    }, idleAutoMinimizeMs);
    return () => window.clearTimeout(timer);
  }, [isActive, muted, isHovering, idleAutoMinimizeMs]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  useEffect(() => {
    if (!isIdle || muted) return;
    const timer = window.setInterval(() => setIdleIndex((i) => (i + 1) % IDLE_GREETINGS.length), 18_000);
    return () => window.clearInterval(timer);
  }, [isIdle, muted]);

  const meta = PHASE_META[effectiveStatus.phase] || PHASE_META.idle;

  if (
    hideWhenIdle &&
    isIdle &&
    effectiveStatus.recentSteps.length === 0 &&
    (effectiveStatus.history || []).length === 0 &&
    !effectiveStatus.thoughtSnippet
  ) {
    return null;
  }

  if (conflictStrategy === 'yield' && anchor.widgetBubbleRect) return null;

  const elapsedMs = effectiveStatus.turnStartedAt
    ? Math.max(0, (isActive ? now : effectiveStatus.updatedAt) - effectiveStatus.turnStartedAt)
    : 0;

  const bubbleWidth = 276;
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 720;

  const fallbackLeftHalf = companionPos ? companionPos.x + 33 < viewportW / 2 : false;
  const isLeft = anchor.found ? anchor.isLeftFlipped : fallbackLeftHalf;
  let left = isLeft ? 18 : viewportW - bubbleWidth - 18;
  let bottom = 80;
  let topOverride = null;
  let dodgingWidgetBubble = false;

  if (anchor.found && anchor.avatarRect) {
    const avatar = anchor.avatarRect;
    const widgetBubble = anchor.widgetBubbleRect;
    if (widgetBubble) {
      dodgingWidgetBubble = true;
      if (widgetBubble.top >= 145) {
        const idealLeft = isLeft ? widgetBubble.left : widgetBubble.right - bubbleWidth;
        left = Math.min(Math.max(12, idealLeft), viewportW - bubbleWidth - 12);
        bottom = Math.min(viewportH - widgetBubble.top + 16, viewportH - 130);
      } else {
        left = isLeft
          ? Math.min(widgetBubble.right + 14, viewportW - bubbleWidth - 12)
          : Math.max(12, widgetBubble.left - bubbleWidth - 14);
        bottom = Math.max(20, viewportH - widgetBubble.bottom);
      }
    } else {
      // Center bubble directly above the mascot's head with exact headroom compensation
      const ratio = typeof anchor.headroomRatio === 'number' ? anchor.headroomRatio : (avatar.height >= 150 ? 0.16 : 0.02);
      const headroomInset = Math.round(avatar.height * ratio);
      const effectiveTop = avatar.top + headroomInset;
      const headCenterX = avatar.left + avatar.width * 0.5;
      const idealLeft = headCenterX - bubbleWidth * 0.5;
      left = Math.min(Math.max(12, idealLeft), viewportW - bubbleWidth - 12);
      bottom = Math.min(Math.max(14, viewportH - effectiveTop + 4), viewportH - 120);
    }
  } else if (companionPos) {
    const idealLeft = isLeft
      ? companionPos.x - 4
      : companionPos.x + 66 - bubbleWidth;
    left = Math.min(Math.max(12, idealLeft), viewportW - bubbleWidth - 12);
    if (companionPos.y < 180) {
      topOverride = Math.min(viewportH - 120, companionPos.y + 68);
    } else {
      bottom = Math.min(Math.max(18, viewportH - companionPos.y + 6), viewportH - 130);
    }
  }

  // Apply user's fine-tuned relative offset (drag bubble top bar to adjust; double-click to reset)
  if (bubbleOffset.dx !== 0 || bubbleOffset.dy !== 0) {
    left = Math.min(Math.max(10, left + bubbleOffset.dx), viewportW - bubbleWidth - 10);
    if (topOverride !== null) {
      topOverride = Math.min(Math.max(10, topOverride + bubbleOffset.dy), viewportH - 80);
    } else {
      bottom = Math.min(Math.max(10, bottom - bubbleOffset.dy), viewportH - 80);
    }
  }

  const displayHeadline =
    isIdle && (!status || status.headline === '悠闲吐泡泡待命中~' || status.headline === '安安静静陪着你呢~')
      ? IDLE_GREETINGS[idleIndex % IDLE_GREETINGS.length]
      : effectiveStatus.headline;

  const displayThoughtSnippet = effectiveStatus.thoughtSnippetZh || effectiveStatus.thoughtSnippet;
  const displayThoughtBody = effectiveStatus.thoughtBufferZh || effectiveStatus.thoughtBuffer;
  const historyList = effectiveStatus.history || [];
  // Build unified metro timeline (falls back cleanly if cached v0.8 snapshot lacks timeline)
  const timelineNodes = Array.isArray(effectiveStatus.timeline) && effectiveStatus.timeline.length > 0
    ? effectiveStatus.timeline
    : [
        ...(displayThoughtBody
          ? [{ id: 'fallback-thought', kind: 'thought', title: displayThoughtSnippet || '思考整理中…', detail: displayThoughtBody, rawText: effectiveStatus.thoughtBuffer, status: isActive ? 'running' : 'completed', startedAt: effectiveStatus.turnStartedAt || now, endedAt: isActive ? null : effectiveStatus.updatedAt }]
          : []),
        ...(effectiveStatus.recentSteps || []).map((s) => ({ id: `step-${s.id}`, kind: 'tool', toolName: s.toolName, title: s.label, detail: s.detail || s.toolName, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt || null })),
      ];
  const phaseDurations = effectiveStatus.phaseDurations || { thinkingMs: 0, toolMs: 0, approvalMs: 0, streamingMs: 0 };
  const totalPhaseMs = (phaseDurations.thinkingMs || 0) + (phaseDurations.toolMs || 0) + (phaseDurations.approvalMs || 0) + (phaseDurations.streamingMs || 0);
  const badgeCount = effectiveStatus.recentSteps.length > 0 ? effectiveStatus.recentSteps.length : historyList.length;

  if (muted) {
    const anchorCenterLeft = anchor.found && anchor.avatarRect
      ? Math.round(anchor.avatarRect.left + anchor.avatarRect.width * 0.5 - 18 + bubbleOffset.dx)
      : isLeft ? Math.max(14, left + 8) : Math.min(viewportW - 48, left + bubbleWidth - 38);
    const iconLeft = Math.min(Math.max(12, anchorCenterLeft), viewportW - 48);
    return h(
      'button',
      {
        type: 'button',
        [OWN_ROOT_ATTR]: 'muted',
        onClick: () => { setIsHovering(false); setMuted(false); },
        title: '点我展开查看思考链、干活记录与历史~',
        style: {
          position: 'fixed',
          left: iconLeft,
          ...(topOverride !== null ? { top: topOverride } : { bottom }),
          zIndex: 2147483646,
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: '#ffffff',
          border: '2.5px solid #203170',
          boxShadow: '0 4px 12px rgba(32, 49, 112, 0.24)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#203170',
          fontSize: 15,
          transition: (isDraggingCompanion || isDraggingBubble) ? 'none' : 'left 220ms ease, bottom 220ms ease, top 220ms ease',
        },
      },
      '💭',
      badgeCount > 0
        ? h(
            'span',
            {
              style: {
                position: 'absolute',
                top: -5,
                right: -5,
                minWidth: 17,
                height: 17,
                borderRadius: 999,
                background: '#203170',
                color: '#ffffff',
                fontSize: 10,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
              },
            },
            badgeCount,
          )
        : null,
    );
  }

  const tabBtnStyle = (active) => ({
    background: active ? '#eff6ff' : 'transparent',
    color: active ? '#203170' : '#64748b',
    border: active ? '1px solid #bfdbfe' : '1px solid transparent',
    borderRadius: 999,
    padding: '2px 7px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  });

  return h(
    'div',
    {
      [OWN_ROOT_ATTR]: 'bubble',
      'aria-live': 'polite',
      style: {
        position: 'fixed',
        left,
        ...(topOverride !== null ? { top: topOverride } : { bottom }),
        width: bubbleWidth,
        zIndex: 2147483646,
        pointerEvents: 'none',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        transition: (isDraggingCompanion || isDraggingBubble) ? 'none' : 'left 220ms cubic-bezier(.22,1,.36,1), bottom 220ms cubic-bezier(.22,1,.36,1), top 220ms cubic-bezier(.22,1,.36,1)',
      },
    },
    h('style', null, '@keyframes dshWhaleDotPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.32); opacity: 0.5; } }'),
    h(
      'div',
      {
        style: { pointerEvents: 'auto', position: 'relative' },
        onMouseEnter: () => setIsHovering(true),
        onMouseLeave: () => setIsHovering(false),
      },
      expanded
        ? h(
            'div',
            {
              style: {
                marginBottom: 8,
                borderRadius: 18,
                background: surfaceBg,
                border: `2.5px solid ${borderCol}`,
                boxShadow: '0 10px 26px rgba(32, 49, 112, 0.2)',
                padding: '10px 12px',
                color: '#334155',
                fontSize: 12,
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                  paddingBottom: 6,
                  borderBottom: '1px dashed rgba(32, 49, 112, 0.2)',
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                h('button', { type: 'button', onClick: () => setActiveTab('timeline'), style: tabBtnStyle(activeTab === 'timeline') }, `🗺️ 脉络 (${timelineNodes.length})`),
                h('button', { type: 'button', onClick: () => setActiveTab('history'), style: tabBtnStyle(activeTab === 'history') }, `📜 历史 (${historyList.length})`),
                h('button', { type: 'button', onClick: () => setActiveTab(activeTab === 'settings' ? 'timeline' : 'settings'), style: tabBtnStyle(activeTab === 'settings'), title: '打开设置（文案人设、通知、提示音、自动收起等）' }, '⚙️'),
              ),
              h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                onCycleDisplayMode
                  ? h('button', {
                      type: 'button',
                      onClick: onCycleDisplayMode,
                      title: '切换模式：🐋 跟随市场挂件 / ✨ 独立小鲸灵 / 📌 仅气泡（适合独立桌宠窗）',
                      style: { background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 999, padding: '1px 6px', fontSize: 10, color: '#334155', cursor: 'pointer' },
                    }, displayMode === 'follow' ? '🐋 跟随' : displayMode === 'standalone' ? '✨ 小鲸灵' : '📌 仅气泡')
                  : null,
                h('button', { type: 'button', onClick: () => setExpanded(false), style: { background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12 } }, '✕'),
              ),
            ),
            activeTab === 'timeline'
              ? h(
                  'div',
                  null,
                  // 1. Mini Phase Duration Stacked Bar
                  totalPhaseMs > 0
                    ? h(
                        'div',
                        { style: { marginBottom: 8 } },
                        h(
                          'div',
                          { style: { display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', background: isDark ? '#1e293b' : '#e2e8f0', gap: 1 } },
                          phaseDurations.thinkingMs > 0 ? h('div', { title: `动脑筋 ${formatShortSec(phaseDurations.thinkingMs)}`, style: { width: `${Math.max(4, (phaseDurations.thinkingMs / totalPhaseMs) * 100)}%`, background: '#3b82f6' } }) : null,
                          phaseDurations.toolMs > 0 ? h('div', { title: `跑工具 ${formatShortSec(phaseDurations.toolMs)}`, style: { width: `${Math.max(4, (phaseDurations.toolMs / totalPhaseMs) * 100)}%`, background: '#f59e0b' } }) : null,
                          phaseDurations.approvalMs > 0 ? h('div', { title: `等审批 ${formatShortSec(phaseDurations.approvalMs)}`, style: { width: `${Math.max(4, (phaseDurations.approvalMs / totalPhaseMs) * 100)}%`, background: '#f97316' } }) : null,
                          phaseDurations.streamingMs > 0 ? h('div', { title: `码字 ${formatShortSec(phaseDurations.streamingMs)}`, style: { width: `${Math.max(4, (phaseDurations.streamingMs / totalPhaseMs) * 100)}%`, background: '#10b981' } }) : null,
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4, fontSize: 10, color: textSecondary, fontVariantNumeric: 'tabular-nums' } },
                          phaseDurations.thinkingMs > 0 ? h('span', null, h('span', { style: { color: '#3b82f6', marginRight: 2 } }, '●'), `思考 ${formatShortSec(phaseDurations.thinkingMs)}`) : null,
                          phaseDurations.toolMs > 0 ? h('span', null, h('span', { style: { color: '#f59e0b', marginRight: 2 } }, '●'), `工具 ${formatShortSec(phaseDurations.toolMs)}`) : null,
                          phaseDurations.approvalMs > 0 ? h('span', null, h('span', { style: { color: '#f97316', marginRight: 2 } }, '●'), `审批 ${formatShortSec(phaseDurations.approvalMs)}`) : null,
                          phaseDurations.streamingMs > 0 ? h('span', null, h('span', { style: { color: '#10b981', marginRight: 2 } }, '●'), `输出 ${formatShortSec(phaseDurations.streamingMs)}`) : null,
                        ),
                      )
                    : null,
                  // 2. Vertical Metro-Line Timeline with Collapsible Node Cards
                  timelineNodes.length === 0
                    ? h(
                        'div',
                        { style: { background: subtleBg, borderRadius: 10, padding: '10px 12px', fontSize: 11.5, color: textSecondary, lineHeight: 1.5 } },
                        '现在正悠闲待命呢，发新任务后我会把思考与工具脉络画成时间轴直播给你看~',
                      )
                    : h(
                        'div',
                        { style: { maxHeight: 240, overflowY: 'auto', paddingRight: 2 } },
                        ...timelineNodes.map((node, idx) => {
                          const st = TIMELINE_NODE_STYLE[node.kind] || TIMELINE_NODE_STYLE.thought;
                          const dotColor = node.status === 'failed' ? '#dc2626' : st.dot;
                          const isLast = idx === timelineNodes.length - 1;
                          const isRunningNode = node.status === 'running';
                          const durMs = Math.max(0, (node.endedAt ?? now) - (node.startedAt || now));
                          const detailText = node.detail;
                          const hasExpandable = Boolean(detailText && detailText !== node.title);
                          const isOpen = Boolean(expandedNodeIds[node.id]);
                          return h(
                            'div',
                            { key: node.id, style: { display: 'flex', alignItems: 'stretch', gap: 8 } },
                            // Left metro rail
                            h(
                              'div',
                              { style: { width: 14, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' } },
                              h('span', {
                                style: {
                                  width: 9,
                                  height: 9,
                                  marginTop: 7,
                                  borderRadius: '50%',
                                  background: dotColor,
                                  boxShadow: isRunningNode ? `0 0 0 3px ${dotColor}33` : 'none',
                                  animation: isRunningNode ? 'dshWhaleDotPulse 1.4s ease-in-out infinite' : undefined,
                                  flexShrink: 0,
                                },
                              }),
                              !isLast
                                ? h('span', { style: { width: 2, flex: 1, minHeight: 12, background: isDark ? '#334155' : '#cbd5e1', marginTop: 2 } })
                                : null,
                            ),
                            // Right collapsible node card
                            h(
                              'div',
                              {
                                style: {
                                  flex: 1,
                                  minWidth: 0,
                                  marginBottom: isLast ? 0 : 6,
                                  background: subtleBg,
                                  border: `1px solid ${isRunningNode ? dotColor + '66' : (isDark ? '#334155' : '#e2e8f0')}`,
                                  borderRadius: 9,
                                  padding: '5px 8px',
                                },
                              },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  onClick: () => hasExpandable && toggleTimelineNode(node.id),
                                  style: {
                                    width: '100%',
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    textAlign: 'left',
                                    cursor: hasExpandable ? 'pointer' : 'default',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 6,
                                  },
                                },
                                h(
                                  'span',
                                  { style: { fontSize: 11, fontWeight: 600, color: textPrimary, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }, title: node.title },
                                  `${st.icon} ${node.title}`,
                                ),
                                h(
                                  'span',
                                  { style: { display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 10, color: isRunningNode ? dotColor : textSecondary, fontVariantNumeric: 'tabular-nums' } },
                                  node.kind !== 'done' && node.kind !== 'error' ? (isRunningNode ? `${formatShortSec(durMs)}…` : formatShortSec(durMs)) : '',
                                  hasExpandable ? h('span', { style: { fontSize: 9, opacity: 0.7 } }, isOpen ? '▾' : '▸') : null,
                                ),
                              ),
                              isOpen && hasExpandable
                                ? h(
                                    'div',
                                    {
                                      style: {
                                        marginTop: 5,
                                        paddingTop: 5,
                                        borderTop: `1px dashed ${isDark ? '#334155' : '#cbd5e1'}`,
                                        fontSize: 10.5,
                                        lineHeight: 1.5,
                                        color: isDark ? '#cbd5e1' : '#475569',
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                        maxHeight: 180,
                                        overflowY: 'auto',
                                      },
                                    },
                                    detailText,
                                  )
                                : null,
                            ),
                          );
                        }),
                      ),
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginTop: 6 } },
                    onToggleAiSummary
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: onToggleAiSummary,
                            title: aiSummary.viaDsh
                              ? '已直连 DeepSeek Harness 当前模型通道，开启后自动总结复杂命令（消耗极少量 Token）'
                              : aiSummary.configured
                                ? '开启后用轻量模型把复杂终端命令总结成一句中文（消耗极少量 Token）'
                                : '需先配置 DSH 模型或在 cordis.patch.yml 填写 aiSummary.apiKey',
                            style: {
                              background: aiSummary.enabled ? '#eff6ff' : 'transparent',
                              border: `1px solid ${aiSummary.enabled ? '#93c5fd' : (isDark ? '#334155' : '#cbd5e1')}`,
                              borderRadius: 999,
                              padding: '1px 7px',
                              fontSize: 10,
                              color: aiSummary.enabled ? '#2563eb' : textSecondary,
                              cursor: 'pointer',
                            },
                          },
                          aiSummary.enabled ? '✨ AI总结: 开' : '✨ AI总结: 关',
                        )
                      : h('span', null),
                    timelineNodes.length > 0
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => { void handleCopyTimeline(displayHeadline, phaseDurations, timelineNodes); },
                            title: '一键复制本轮时间轴与详情（Markdown 格式）',
                            style: {
                              background: 'transparent',
                              border: `1px solid ${isDark ? '#334155' : '#cbd5e1'}`,
                              borderRadius: 999,
                              padding: '1px 7px',
                              fontSize: 10,
                              color: copiedFlag ? '#16a34a' : textSecondary,
                              cursor: 'pointer',
                            },
                          },
                          copiedFlag ? '✅ 已复制' : '📋 复制脉络',
                        )
                      : null,
                  ),
                  aiSummary.enabled && !aiSummary.configured
                    ? h(
                        'div',
                        { style: { marginTop: 4, fontSize: 10, color: '#d97706', lineHeight: 1.4 } },
                        '提示：未检测到 DEEPSEEK_API_KEY，请在系统环境变量或 cordis.patch.yml 的 aiSummary.apiKey 中填入 Key 后生效。',
                      )
                    : aiSummary.enabled && aiSummary.lastError
                      ? h(
                          'div',
                          { style: { marginTop: 4, fontSize: 10, color: '#dc2626', lineHeight: 1.4 } },
                          `AI总结失败（${aiSummary.lastError}），已自动回退为本地中文摘要。`,
                        )
                      : null,
                )
                : activeTab === 'settings'
                  ? (() => {
                      const p = userPrefs || loadUserPrefs();
                      const sBtn = (active) => ({
                        padding: '2px 7px',
                        borderRadius: 999,
                        fontSize: 10.5,
                        cursor: 'pointer',
                        border: `1px solid ${active ? '#3b82f6' : (isDark ? '#334155' : '#cbd5e1')}`,
                        background: active ? (isDark ? '#1d4ed8' : '#eff6ff') : 'transparent',
                        color: active ? (isDark ? '#ffffff' : '#1d4ed8') : textPrimary,
                      });
                      const row = { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0', borderBottom: `1px dashed ${isDark ? '#334155' : '#e2e8f0'}` };
                      return h(
                        'div',
                        { style: { maxHeight: 245, overflowY: 'auto', paddingRight: 2, fontSize: 11, color: textPrimary } },
                        h('div', { style: row },
                          h('span', { style: { fontWeight: 700, fontSize: 11 } }, '文案风格（人设）'),
                          h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                            h('button', { type: 'button', onClick: () => onChangePersona && onChangePersona('playful'), style: sBtn(persona === 'playful') }, '🫧 可爱俏皮'),
                            h('button', { type: 'button', onClick: () => onChangePersona && onChangePersona('concise'), style: sBtn(persona === 'concise') }, '💼 简洁专业'),
                            h('button', { type: 'button', onClick: () => onChangePersona && onChangePersona('geek'), style: sBtn(persona === 'geek') }, '⌨️ 冷静极客'),
                          ),
                        ),
                        h('div', { style: row },
                          h('span', { style: { fontWeight: 700, fontSize: 11 } }, '后台完成 / 审批提醒'),
                          h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                            h('button', { type: 'button', onClick: () => onUpdatePref && onUpdatePref({ notifyMode: 'background' }), style: sBtn(p.notifyMode === 'background') }, '仅后台'),
                            h('button', { type: 'button', onClick: () => onUpdatePref && onUpdatePref({ notifyMode: 'always' }), style: sBtn(p.notifyMode === 'always') }, '总是'),
                            h('button', { type: 'button', onClick: () => onUpdatePref && onUpdatePref({ notifyMode: 'off' }), style: sBtn(p.notifyMode === 'off') }, '关闭'),
                            h('button', { type: 'button', onClick: () => onUpdatePref && onUpdatePref({ soundEnabled: !p.soundEnabled }), style: sBtn(Boolean(p.soundEnabled)) }, p.soundEnabled ? '🔔 提示音开' : '🔕 提示音关'),
                          ),
                        ),
                        h('div', { style: row },
                          h('span', { style: { fontWeight: 700, fontSize: 11 } }, '空闲自动收起成 💭'),
                          h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                            ...[0, 12000, 30000, 60000].map((ms) =>
                              h('button', { key: ms, type: 'button', onClick: () => onUpdatePref && onUpdatePref({ idleAutoMinimizeMs: ms }), style: sBtn((p.idleAutoMinimizeMs ?? 12000) === ms) }, ms === 0 ? '关闭' : `${ms / 1000}s`),
                            ),
                          ),
                        ),
                        h('div', { style: { ...row, borderBottom: 'none' } },
                          h('span', { style: { fontWeight: 700, fontSize: 11 } }, '自定义挂件选择器（可选）'),
                          h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                            h('input', {
                              type: 'text',
                              value: p.customSelector || '',
                              placeholder: '留空自动识别',
                              onChange: (e) => onUpdatePref && onUpdatePref({ customSelector: e.target.value }),
                              style: { flex: 1, minWidth: 0, padding: '2px 6px', borderRadius: 6, border: `1px solid ${isDark ? '#334155' : '#cbd5e1'}`, background: 'transparent', color: textPrimary, fontSize: 10.5 },
                            }),
                            h('button', { type: 'button', onClick: () => onResetPositions && onResetPositions(), style: sBtn(false), title: '重置小鲸灵与气泡位置' }, '↺ 复位'),
                          ),
                        ),
                      );
                    })()
                  : h(
                    'div',
                    null,
                    historyList.length === 0
                      ? h('div', { style: { color: '#64748b', fontSize: 11 } }, '还没有已归档的历史任务，跑完一轮任务就会自动存在这里（刷新页面也不丢哦~）。')
                      : h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 170, overflowY: 'auto' } },
                          ...historyList.map((run) => {
                            const isOpen = expandedHistoryId === run.id;
                            return h(
                              'div',
                              { key: run.id, style: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '6px 8px' } },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  onClick: () => setExpandedHistoryId(isOpen ? null : run.id),
                                  style: { width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 },
                                },
                                h('span', { style: { fontSize: 11.5, fontWeight: 700, color: '#203170', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${run.outcome === 'error' ? '😵 ' : '✨ '}${run.headline}`),
                                h('span', { style: { fontSize: 10.5, color: '#64748b', flexShrink: 0 } }, `${formatClock(run.finishedAt)} · ${(run.steps || []).length}步`),
                              ),
                              isOpen
                                ? (() => {
                                    const runDur = run.phaseDurations || {};
                                    const runTotal = (runDur.thinkingMs || 0) + (runDur.toolMs || 0) + (runDur.approvalMs || 0) + (runDur.streamingMs || 0);
                                    const runNodes = Array.isArray(run.timeline) && run.timeline.length > 0
                                      ? run.timeline
                                      : (run.steps || []).map((s) => ({ id: s.id, kind: 'tool', title: s.label, detail: s.detail, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt }));
                                    return h(
                                      'div',
                                      { style: { marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${isDark ? '#334155' : '#cbd5e1'}` } },
                                      runTotal > 0
                                        ? h(
                                            'div',
                                            { style: { marginBottom: 6 } },
                                            h(
                                              'div',
                                              { style: { display: 'flex', height: 5, borderRadius: 999, overflow: 'hidden', background: isDark ? '#1e293b' : '#e2e8f0', gap: 1 } },
                                              runDur.thinkingMs > 0 ? h('div', { style: { width: `${Math.max(4, (runDur.thinkingMs / runTotal) * 100)}%`, background: '#3b82f6' } }) : null,
                                              runDur.toolMs > 0 ? h('div', { style: { width: `${Math.max(4, (runDur.toolMs / runTotal) * 100)}%`, background: '#f59e0b' } }) : null,
                                              runDur.approvalMs > 0 ? h('div', { style: { width: `${Math.max(4, (runDur.approvalMs / runTotal) * 100)}%`, background: '#f97316' } }) : null,
                                              runDur.streamingMs > 0 ? h('div', { style: { width: `${Math.max(4, (runDur.streamingMs / runTotal) * 100)}%`, background: '#10b981' } }) : null,
                                            ),
                                          )
                                        : null,
                                      ...runNodes.map((n, i) => {
                                        const st = TIMELINE_NODE_STYLE[n.kind] || TIMELINE_NODE_STYLE.thought;
                                        const dc = n.status === 'failed' ? '#dc2626' : st.dot;
                                        return h(
                                          'div',
                                          { key: n.id || i, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: isDark ? '#cbd5e1' : '#334155', marginTop: 3 } },
                                          h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: dc, flexShrink: 0 } }),
                                          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: n.detail || n.title }, `${st.icon} ${n.title}`),
                                        );
                                      }),
                                      h(
                                        'div',
                                        { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 5 } },
                                        h('button', { type: 'button', onClick: () => { void handleCopyTimeline(run.headline, runDur, runNodes); }, style: { background: 'none', border: 'none', color: '#64748b', fontSize: 10, cursor: 'pointer', padding: 0, textDecoration: 'underline' } }, '📋 复制该轮'),
                                      ),
                                    );
                                  })()
                                : null,
                            );
                          }),
                        ),
                    historyList.length > 0 && onClearHistory
                      ? h(
                          'div',
                          { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
                          h('button', { type: 'button', onClick: onClearHistory, style: { background: 'none', border: 'none', color: '#94a3b8', fontSize: 10.5, cursor: 'pointer', padding: 0, textDecoration: 'underline' } }, '清空本会话历史'),
                        )
                      : null,
                  ),
          )
        : null,
      h(
        'div',
        {
          style: {
            position: 'relative',
            background: surfaceBg,
            border: `3px solid ${effectiveStatus.isStalled ? '#ea580c' : borderCol}`,
            borderRadius: '26px',
            padding: '10px 14px 11px',
            boxShadow: '0 8px 20px rgba(32, 49, 112, 0.18)',
            color: textPrimary,
          },
        },
        h(
          'div',
          {
            onPointerDown: handleBubbleDragStart,
            onDoubleClick: handleResetBubbleOffset,
            title: '按住状态栏可微调气泡相对挂件的位置，双击恢复默认',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              marginBottom: 4,
              cursor: isDraggingBubble ? 'grabbing' : 'grab',
              userSelect: 'none',
              touchAction: 'none',
            },
          },
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: meta.bg, color: meta.accent } },
            h('span', {
              style: {
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: meta.accent,
                animation: isActive ? 'dshWhaleDotPulse 1.5s ease-in-out infinite' : undefined,
              },
            }),
            effectiveStatus.isStalled ? '🐢 有点硬核' : meta.badge,
          ),
          h(
            'div',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            !isIdle || effectiveStatus.stepCount > 0
              ? h('span', { style: { fontSize: 11, color: '#536ba9', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, `第${Math.max(1, effectiveStatus.stepCount)}步 · ${formatDuration(elapsedMs)}`)
              : null,
            h('button', { type: 'button', onClick: () => setMuted(true), title: '收起为 💭 小圆标', style: { background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0, fontSize: 11, lineHeight: 1 } }, '—'),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => setExpanded((v) => !v),
            title: effectiveStatus.detail ? `${displayHeadline}\n${effectiveStatus.detail}` : displayHeadline,
            style: {
              width: '100%',
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              color: textPrimary,
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1.4,
            },
          },
          displayHeadline,
        ),
        showThoughtChain && displayThoughtSnippet
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => { setActiveTab('timeline'); setExpanded(true); },
                title: '点击展开完整中文思考链',
                style: {
                  width: '100%',
                  marginTop: 6,
                  padding: '5px 8px',
                  borderRadius: 10,
                  background: '#f1f5ff',
                  border: '1px dashed rgba(83, 107, 169, 0.35)',
                  color: '#475569',
                  fontSize: 11,
                  lineHeight: 1.4,
                  textAlign: 'left',
                  cursor: 'pointer',
                },
              },
              `💭 ${displayThoughtSnippet}`,
            )
          : null,
      ),
      !dodgingWidgetBubble && topOverride === null
        ? (() => {
            const targetHeadX = anchor.found && anchor.avatarRect
              ? anchor.avatarRect.left + anchor.avatarRect.width * 0.5
              : companionPos ? companionPos.x + 33 : left + bubbleWidth * 0.5;
            const tailX = Math.min(Math.max(24, Math.round(targetHeadX - left)), bubbleWidth - 24);
            return h(
              'div',
              { style: { position: 'relative', height: 18, pointerEvents: 'none' } },
              h('span', { style: { position: 'absolute', top: 2, left: tailX - 6, width: 12, height: 9, borderRadius: '50%', background: '#ffffff', border: `2.5px solid ${effectiveStatus.isStalled ? '#ea580c' : '#203170'}` } }),
              h('span', { style: { position: 'absolute', top: 12, left: tailX - 3, width: 7, height: 6, borderRadius: '50%', background: '#ffffff', border: `2px solid ${effectiveStatus.isStalled ? '#ea580c' : '#203170'}` } }),
            );
          })()
        : null,
    ),
  );
}

// --- Client Plugin Entry (DSH 0.2.2-rc.3+ exact slot & useSelector hook contract) ---
const IDENTITY_SELECTOR = (s) => s;
function resolveFetch() {
  if (typeof globalThis !== 'undefined' && globalThis.__DSH_TRANSPORT__ && typeof globalThis.__DSH_TRANSPORT__.fetch === 'function') {
    return globalThis.__DSH_TRANSPORT__.fetch.bind(globalThis.__DSH_TRANSPORT__);
  }
  return fetch;
}
function apply(ctx) {
  function LiveStatusOverlay({ useSessions }) {
    const sessionState = typeof useSessions === 'function' ? useSessions(IDENTITY_SELECTOR) : undefined;
    const activeId =
      sessionState?.currentSessionId ??
      sessionState?.activeSessionId ??
      sessionState?.selectedSessionId ??
      sessionState?.currentId ??
      null;
    const activeSummary = Array.isArray(sessionState?.sessions) ? sessionState.sessions.find((s) => s.id === activeId) : undefined;
    const isSessionRunning = activeSummary?.status === 'running';

    const [status, setStatus] = useState(null);
    const [showThoughtChain, setShowThoughtChain] = useState(true);
    const [hideWhenIdle, setHideWhenIdle] = useState(false);
    const [idleAutoMinimizeMs, setIdleAutoMinimizeMs] = useState(12_000);
    const lastRevRef = useRef(0);
    const [whaleConfig, setWhaleConfig] = useState({ enabled: true, conflictStrategy: 'stack' });
    const [aiSummaryState, setAiSummaryState] = useState({ enabled: false, configured: false });
    const [userPrefs, setUserPrefs] = useState(() => loadUserPrefs());
    const [activePersona, setActivePersona] = useState(() => loadUserPrefs().persona || 'playful');
    const aiSyncDoneRef = useRef(false);
    const handleInlineUpdatePref = (patch) => {
      const next = saveUserPrefs(patch);
      setUserPrefs(next);
      if (patch.notifyMode && patch.notifyMode !== 'off' && typeof Notification === 'function' && Notification.permission === 'default') {
        try { void Notification.requestPermission(); } catch {}
      }
    };
    const handleInlineChangePersona = async (p) => {
      setActivePersona(p);
      handleInlineUpdatePref({ persona: p });
      try { await resolveFetch()(`${HTTP_PATH_SETTINGS}?persona=${encodeURIComponent(p)}`, { cache: 'no-store' }); } catch {}
    };
    const handleInlineResetPos = () => {
      saveUserPrefs({ _resetPos: Date.now() });
    };
    const lastAlertKeyRef = useRef('');

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onPrefs = (ev) => {
        const next = ev?.detail || loadUserPrefs();
        setUserPrefs(next);
        if (next._resetPos) {
          const def = getDefaultCompanionPos();
          setCompanionPos(def);
          try {
            window.localStorage.setItem(STORAGE_KEY_COMPANION_POS, JSON.stringify(def));
            window.localStorage.setItem(STORAGE_KEY_BUBBLE_OFFSET, JSON.stringify({ dx: 0, dy: 0 }));
          } catch {}
        }
        if (next._displayMode) setDisplayModeOverride(next._displayMode);
        if (typeof next._aiSummary === 'boolean') {
          setAiSummaryState((prev) => ({ ...prev, enabled: next._aiSummary }));
        }
      };
      window.addEventListener(PREFS_EVENT, onPrefs);
      return () => window.removeEventListener(PREFS_EVENT, onPrefs);
    }, []);

    useEffect(() => {
      if (!status || !status.phase) return;
      const p = status.phase;
      if (p !== 'waiting_approval' && p !== 'done' && p !== 'error') return;
      if (p === 'done' && !status.stepCount && (!status.recentSteps || status.recentSteps.length === 0)) return;
      const key = `${status.sessionId}:${status.turnStartedAt || 0}:${p}:${status.stepCount || 0}`;
      if (lastAlertKeyRef.current === key) return;
      lastAlertKeyRef.current = key;
      triggerDesktopAlert(p, status.headline, status.detail, userPrefs);
    }, [status?.phase, status?.turnStartedAt, status?.stepCount, userPrefs.notifyMode, userPrefs.soundEnabled]);
    // 3-state mode: 'follow' (auto-anchor to 10+ marketplace mascots) | 'standalone' (built-in draggable whale) | 'bubble-only' (no whale, for native OS window pets like dsh-dafeiyu)
    const [displayModeOverride, setDisplayModeOverride] = useState(() => {
      try {
        const v = window.localStorage.getItem(STORAGE_KEY_WHALE_MODE);
        if (v === 'follow' || v === 'standalone' || v === 'bubble-only') return v;
      } catch {}
      return null;
    });
    const displayMode = displayModeOverride || (whaleConfig.enabled ? 'follow' : 'standalone');
    const effectiveWhaleEnabled = displayMode === 'follow';
    const [companionPos, setCompanionPos] = useState(() => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY_COMPANION_POS);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return clampCompanionPos(parsed);
          }
        }
      } catch {}
      return getDefaultCompanionPos();
    });
    const [isDraggingCompanion, setIsDraggingCompanion] = useState(false);
    const dragRef = useRef(null);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onResize = () => setCompanionPos((prev) => clampCompanionPos(prev));
      window.addEventListener('resize', onResize, { passive: true });
      return () => window.removeEventListener('resize', onResize);
    }, []);

    const handleCompanionDragStart = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault?.();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: companionPos.x,
        origY: companionPos.y,
      };
      setIsDraggingCompanion(true);

      const onMove = (ev) => {
        if (!dragRef.current) return;
        const next = clampCompanionPos({
          x: dragRef.current.origX + (ev.clientX - dragRef.current.startX),
          y: dragRef.current.origY + (ev.clientY - dragRef.current.startY),
        });
        setCompanionPos(next);
      };
      const onUp = (ev) => {
        if (dragRef.current) {
          const finalPos = clampCompanionPos({
            x: dragRef.current.origX + (ev.clientX - dragRef.current.startX),
            y: dragRef.current.origY + (ev.clientY - dragRef.current.startY),
          });
          setCompanionPos(finalPos);
          try { window.localStorage.setItem(STORAGE_KEY_COMPANION_POS, JSON.stringify(finalPos)); } catch {}
        }
        dragRef.current = null;
        setIsDraggingCompanion(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    const handleResetCompanionPos = () => {
      const def = getDefaultCompanionPos();
      setCompanionPos(def);
      try { window.localStorage.setItem(STORAGE_KEY_COMPANION_POS, JSON.stringify(def)); } catch {}
    };

    const whaleAnchor = useWhaleAnchor(effectiveWhaleEnabled, userPrefs.customSelector || whaleConfig.customSelector);
    const cycleDisplayMode = () => {
      const order = ['follow', 'standalone', 'bubble-only'];
      const next = order[(order.indexOf(displayMode) + 1) % order.length];
      setDisplayModeOverride(next);
      try { window.localStorage.setItem(STORAGE_KEY_WHALE_MODE, next); } catch {}
    };

    const handleToggleAiSummary = async () => {
      const nextEnabled = !aiSummaryState.enabled;
      setAiSummaryState((prev) => ({ ...prev, enabled: nextEnabled }));
      try { window.localStorage.setItem(STORAGE_KEY_AI_SUMMARY, nextEnabled ? '1' : '0'); } catch {}
      try {
        const fetchFn = resolveFetch();
        const r = await fetchFn(`${HTTP_PATH_SETTINGS}?aiSummary=${nextEnabled ? '1' : '0'}`, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (j?.aiSummary) setAiSummaryState(j.aiSummary);
        }
      } catch {}
    };

    const handleClearHistory = () => {
      if (!activeId) return;
      try { window.localStorage.removeItem(`${STORAGE_KEY_SESSION_PREFIX}${activeId}`); } catch {}
      setStatus((prev) => (prev ? { ...prev, history: [] } : prev));
    };

    useEffect(() => {
      lastRevRef.current = 0;
      if (activeId) {
        const initialSaved = loadSavedSessionStatus(activeId);
        if (initialSaved) setStatus(initialSaved);
      }

      let cancelled = false;
      let timerId = 0;
      const poll = async () => {
        let resp = null;
        try {
          const params = new URLSearchParams();
          if (activeId) params.set('sessionId', activeId);
          if (lastRevRef.current > 0) params.set('rev', String(lastRevRef.current));
          const qs = params.toString();
          const url = qs ? `${HTTP_PATH_SNAPSHOT}?${qs}` : HTTP_PATH_SNAPSHOT;
          const fetchFn = resolveFetch();
          const r = await fetchFn(url, { cache: 'no-store' });
          if (r.status === 304) {
            if (!cancelled) timerId = window.setTimeout(() => { void poll(); }, isSessionRunning ? POLL_ACTIVE_MS : POLL_IDLE_MS);
            return;
          }
          if (r.ok) resp = await r.json();
        } catch {
          // Ignore transient network errors
        }
        if (cancelled) return;
        if (resp?.config) {
          if (typeof resp.config.showThoughtChain === 'boolean') setShowThoughtChain(resp.config.showThoughtChain);
          if (typeof resp.config.hideWhenIdle === 'boolean') setHideWhenIdle(resp.config.hideWhenIdle);
          if (typeof resp.config.idleAutoMinimizeMs === 'number') setIdleAutoMinimizeMs(resp.config.idleAutoMinimizeMs);
          if (resp.config.whaleAdapter) setWhaleConfig(resp.config.whaleAdapter);
          if (resp.config.persona) setActivePersona(resp.config.persona);
          if (resp.config.aiSummary) {
            if (!aiSyncDoneRef.current) {
              aiSyncDoneRef.current = true;
              let savedPref = null;
              try { savedPref = window.localStorage.getItem(STORAGE_KEY_AI_SUMMARY); } catch {}
              if ((savedPref === '1' && !resp.config.aiSummary.enabled) || (savedPref === '0' && resp.config.aiSummary.enabled)) {
                const want = savedPref === '1';
                setAiSummaryState({ ...resp.config.aiSummary, enabled: want });
                void resolveFetch()(`${HTTP_PATH_SETTINGS}?aiSummary=${want ? '1' : '0'}`, { cache: 'no-store' }).catch(() => {});
              } else {
                setAiSummaryState(resp.config.aiSummary);
              }
            } else {
              setAiSummaryState(resp.config.aiSummary);
            }
          }
        }

        const incoming = resp?.status ?? null;
        const storageSid = activeId || incoming?.sessionId || null;
        const saved = storageSid ? loadSavedSessionStatus(storageSid) : null;
        const nextDelay =
          isSessionRunning ||
          incoming?.phase === 'thinking' ||
          incoming?.phase === 'running_tool' ||
          incoming?.phase === 'streaming'
            ? POLL_ACTIVE_MS
            : POLL_IDLE_MS;

        if (incoming) {
          if (typeof incoming.rev === 'number') lastRevRef.current = incoming.rev;
          const merged = { ...incoming, history: mergeHistory(incoming.history, saved?.history) };
          if (storageSid && (merged.recentSteps.length > 0 || merged.thoughtBuffer || merged.history.length > 0)) {
            saveSessionStatus(storageSid, merged);
          }
          setStatus(merged);
        } else if (saved) {
          setStatus(saved);
        }

        if (!cancelled) {
          timerId = window.setTimeout(() => { void poll(); }, nextDelay);
        }
      };

      void poll();
      return () => {
        cancelled = true;
        if (timerId) window.clearTimeout(timerId);
      };
    }, [activeId, activeSummary?.status, activeSummary?.pendingInteraction]);

    const showDefaultCompanion = displayMode === 'standalone' || (displayMode === 'follow' && !whaleAnchor.found);
    return h(
      React.Fragment,
      null,
      showDefaultCompanion
        ? h(DefaultMiniCompanion, {
            phase: status?.phase ?? 'idle',
            pos: companionPos,
            isDragging: isDraggingCompanion,
            onDragStart: handleCompanionDragStart,
            onResetPos: handleResetCompanionPos,
          })
        : null,
      h(WhaleThoughtBubble, {
        status,
        isSessionRunning,
        anchor: whaleAnchor,
        companionPos,
        isDraggingCompanion,
        conflictStrategy: whaleConfig.conflictStrategy,
        showThoughtChain,
        hideWhenIdle: typeof userPrefs.hideWhenIdle === 'boolean' ? userPrefs.hideWhenIdle : hideWhenIdle,
        idleAutoMinimizeMs: typeof userPrefs.idleAutoMinimizeMs === 'number' ? userPrefs.idleAutoMinimizeMs : idleAutoMinimizeMs,
        onClearHistory: handleClearHistory,
        displayMode,
        onCycleDisplayMode: cycleDisplayMode,
        aiSummary: aiSummaryState,
        onToggleAiSummary: handleToggleAiSummary,
        userPrefs,
        persona: activePersona,
        onUpdatePref: handleInlineUpdatePref,
        onChangePersona: handleInlineChangePersona,
        onResetPositions: handleInlineResetPos,
      }),
    );
  }

  function LiveStatusSettingsCard() {
    const isDark = useIsDarkMode();
    const [prefs, setPrefs] = useState(() => loadUserPrefs());
    const [mode, setMode] = useState(() => {
      try {
        const v = window.localStorage.getItem(STORAGE_KEY_WHALE_MODE);
        if (v === 'follow' || v === 'standalone' || v === 'bubble-only') return v;
      } catch {}
      return 'follow';
    });
    const [aiState, setAiState] = useState({ enabled: false, configured: false, viaDsh: false });
    const [persona, setPersona] = useState(() => loadUserPrefs().persona || 'playful');

    useEffect(() => {
      void (async () => {
        try {
          const r = await resolveFetch()(HTTP_PATH_SETTINGS, { cache: 'no-store' });
          if (r.ok) {
            const j = await r.json();
            if (j?.aiSummary) setAiState(j.aiSummary);
            if (j?.persona) setPersona(j.persona);
          }
        } catch {}
      })();
    }, []);

    const updatePref = (patch) => {
      const next = saveUserPrefs(patch);
      setPrefs(next);
    };
    const updateMode = (m) => {
      setMode(m);
      try { window.localStorage.setItem(STORAGE_KEY_WHALE_MODE, m); } catch {}
      saveUserPrefs({ _displayMode: m });
    };
    const updatePersona = async (p) => {
      setPersona(p);
      updatePref({ persona: p });
      try { await resolveFetch()(`${HTTP_PATH_SETTINGS}?persona=${encodeURIComponent(p)}`, { cache: 'no-store' }); } catch {}
    };
    const toggleAi = async () => {
      const next = !aiState.enabled;
      setAiState((prev) => ({ ...prev, enabled: next }));
      try { window.localStorage.setItem(STORAGE_KEY_AI_SUMMARY, next ? '1' : '0'); } catch {}
      saveUserPrefs({ _aiSummary: next });
      try {
        const r = await resolveFetch()(`${HTTP_PATH_SETTINGS}?aiSummary=${next ? '1' : '0'}`, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (j?.aiSummary) setAiState(j.aiSummary);
        }
      } catch {}
    };
    const updateNotify = (val) => {
      updatePref({ notifyMode: val });
      if (val !== 'off' && typeof Notification === 'function' && Notification.permission === 'default') {
        try { void Notification.requestPermission(); } catch {}
      }
    };

    const cardBg = isDark ? '#1e293b' : '#ffffff';
    const border = isDark ? '#334155' : '#e2e8f0';
    const fg = isDark ? '#f1f5f9' : '#0f172a';
    const mutedFg = isDark ? '#94a3b8' : '#64748b';
    const pill = (active) => ({
      padding: '4px 10px',
      borderRadius: 999,
      fontSize: 12,
      cursor: 'pointer',
      border: `1px solid ${active ? '#3b82f6' : border}`,
      background: active ? (isDark ? '#1d4ed8' : '#eff6ff') : 'transparent',
      color: active ? (isDark ? '#ffffff' : '#1d4ed8') : fg,
    });
    const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${border}` };

    return h(
      'div',
      { style: { background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: '14px 16px', color: fg, marginBottom: 12 } },
      h('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 4 } }, '🫧 实时状态与思考链气泡 (Live Status HUD v1.0.4)'),
      h('div', { style: { fontSize: 12, color: mutedFg, marginBottom: 10 } }, '修改后立即生效，无需重启桌面版。'),
      h('div', { style: rowStyle },
        h('span', { style: { fontSize: 12.5 } }, '挂件显示模式'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => updateMode('follow'), style: pill(mode === 'follow') }, '🐋 跟随市场挂件'),
          h('button', { type: 'button', onClick: () => updateMode('standalone'), style: pill(mode === 'standalone') }, '✨ 独立小鲸灵'),
          h('button', { type: 'button', onClick: () => updateMode('bubble-only'), style: pill(mode === 'bubble-only') }, '📌 仅气泡'),
        ),
      ),
      h('div', { style: rowStyle },
        h('span', { style: { fontSize: 12.5 } }, '文案风格（人设）'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => { void updatePersona('playful'); }, style: pill(persona === 'playful') }, '🫧 可爱俏皮'),
          h('button', { type: 'button', onClick: () => { void updatePersona('concise'); }, style: pill(persona === 'concise') }, '💼 简洁专业'),
          h('button', { type: 'button', onClick: () => { void updatePersona('geek'); }, style: pill(persona === 'geek') }, '⌨️ 冷静极客'),
        ),
      ),
      h('div', { style: rowStyle },
        h('span', { style: { fontSize: 12.5 } }, '空闲自动收起成 💭'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          ...[0, 12000, 30000, 60000].map((ms) =>
            h('button', { key: ms, type: 'button', onClick: () => updatePref({ idleAutoMinimizeMs: ms }), style: pill((prefs.idleAutoMinimizeMs ?? 12000) === ms) }, ms === 0 ? '不自动收起' : `${ms / 1000} 秒`),
          ),
        ),
      ),
      h('div', { style: rowStyle },
        h('span', { style: { fontSize: 12.5 } }, '后台完成 / 审批提醒'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => updateNotify('background'), style: pill(prefs.notifyMode === 'background') }, '仅后台通知'),
          h('button', { type: 'button', onClick: () => updateNotify('always'), style: pill(prefs.notifyMode === 'always') }, '总是通知'),
          h('button', { type: 'button', onClick: () => updateNotify('off'), style: pill(prefs.notifyMode === 'off') }, '关闭'),
          h('button', { type: 'button', onClick: () => updatePref({ soundEnabled: !prefs.soundEnabled }), style: pill(Boolean(prefs.soundEnabled)) }, prefs.soundEnabled ? '🔔 提示音: 开' : '🔕 提示音: 关'),
        ),
      ),
      h('div', { style: rowStyle },
        h('span', { style: { fontSize: 12.5 } }, `AI 智能命令总结${aiState.viaDsh ? '（已直连 DSH 模型通道）' : ''}`),
        h('button', { type: 'button', onClick: () => { void toggleAi(); }, style: pill(Boolean(aiState.enabled)) }, aiState.enabled ? '✨ 已开启' : '已关闭'),
      ),
      h('div', { style: rowStyle },
        h('span', { style: { fontSize: 12.5 } }, '自定义挂件 CSS 选择器（可选）'),
        h('input', {
          type: 'text',
          value: prefs.customSelector || '',
          placeholder: '留空自动识别，如 .dshwv-img',
          onChange: (e) => updatePref({ customSelector: e.target.value }),
          style: { width: 200, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: fg, fontSize: 12 },
        }),
      ),
      h('div', { style: { ...rowStyle, justifyContent: 'flex-end' } },
        h('button', { type: 'button', onClick: () => saveUserPrefs({ _resetPos: Date.now() }), style: pill(false) }, '↺ 重置气泡与小鲸灵位置'),
      ),
    );
  }

  // Wait for ui-layout to declare 'shell.overlay' via ctx.slots.inject (DSH 0.2.2-rc.3 standard)
  const mountSlot = () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'live-status-hud' }, LiveStatusOverlay);
  if (typeof ctx.slots?.inject === 'function') {
    ctx.slots.inject('shell.overlay', mountSlot);
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register({ name: 'settings.section', id: 'live-status-hud-settings', label: '实时状态气泡', order: 60 }, LiveStatusSettingsCard),
    );
  } else {
    mountSlot();
  }
};

    return { name: 'live-status-hud-client', inject: ['slots'], apply };
  },
});
