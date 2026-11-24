import { useEffect, useState } from 'react';

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface WhaleAnchorState {
  found: boolean;
  widgetKind: 'whale-widget' | 'dsh-dafeiyu' | 'dsh-pet' | 'generic-mascot' | 'none';
  /** Tight bounding box of the actual mascot character sprite */
  avatarRect: AnchorRect | null;
  /** True when the widget is docked on the left half or carries `.dshwv-left` */
  isLeftFlipped: boolean;
  /** Exact painted bounding box of the widget's own bubble ONLY when genuinely open */
  widgetBubbleRect: AnchorRect | null;
}

const OWN_ROOT_ATTR = 'data-dsh-live-status-hud';

interface KnownWidgetRule {
  kind: WhaleAnchorState['widgetKind'];
  spriteSelectors: string[];
  /** Ordered from tightest painted SVG shape (e.g. .dshwv-bshape) to outer bubble wrapper */
  bubbleSelectors: string[];
}

const KNOWN_WIDGET_RULES: KnownWidgetRule[] = [
  {
    kind: 'whale-widget',
    spriteSelectors: [
      'img.dshwv-img',
      'img[src*="/dsh-whale/image"]',
      'img[src*="DSniang"]',
      '.dshwv-body img',
      '.dshwv-body',
    ],
    bubbleSelectors: [
      '.dshwv-bshape',
      '.dshwv-bubble svg',
      '.dshwv-bubble',
    ],
  },
  {
    kind: 'dsh-dafeiyu',
    spriteSelectors: [
      '[class*="dafeiyu"] img',
      '[class*="dafeiyu"] canvas',
      '[id*="dafeiyu"] img',
      '[class*="dafeiyu"]',
    ],
    bubbleSelectors: ['[class*="dafeiyu"] [class*="bubble"]', '[class*="dafeiyu"] [class*="speech"]'],
  },
  {
    kind: 'dsh-pet',
    spriteSelectors: [
      '[class*="dsh-pet"] video',
      '[class*="dsh-pet"] canvas',
      '[class*="dsh-pet"] img',
      '[id*="dsh-pet"] video',
      '[id*="dsh-pet"] canvas',
      '[id*="dsh-pet"] img',
      '[class*="whalechan"] img',
      '[class*="dsh-wisp"] canvas',
      '[class*="dsh-wisp"] img',
    ],
    bubbleSelectors: [
      '[class*="dsh-pet"] [class*="bubble"]',
      '[class*="whalechan"] [class*="bubble"]',
      '[class*="dsh-wisp"] [class*="bubble"]',
    ],
  },
];

function toAnchorRect(domRect: DOMRect): AnchorRect {
  return {
    left: domRect.left,
    top: domRect.top,
    width: domRect.width,
    height: domRect.height,
    right: domRect.right,
    bottom: domRect.bottom,
  };
}

function isInsideOwnHud(el: Element): boolean {
  return Boolean(el.closest(`[${OWN_ROOT_ATTR}]`));
}

/**
 * Checks effective visibility across the element AND its ancestors up to 5 levels,
 * working cleanly for both HTMLElement and SVGElement (like ellipse.dshwv-bshape!).
 * Does NOT reject `pointer-events: none` because SVG bubble wrappers often keep
 * `pointer-events: none` even while visibly open.
 */
function isElementReallyVisible(el: Element | null, minW = 24, minH = 24): el is Element {
  if (!el || isInsideOwnHud(el)) return false;

  let curr: Element | null = el;
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

function detectGenericFloatingMascot(): Element | null {
  const candidates = document.querySelectorAll('img, canvas, video');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best: { el: Element; score: number } | null = null;

  for (const node of candidates) {
    if (!isElementReallyVisible(node, 48, 48)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width > 360 || rect.height > 360) continue;

    let curr: Element | null = node;
    let isFloatingOverlay = false;
    let depth = 0;
    while (curr && curr !== document.body && depth < 6) {
      const cs = window.getComputedStyle(curr);
      const z = Number.parseInt(cs.zIndex || '0', 10);
      if (cs.position === 'fixed' && !Number.isNaN(z) && z >= 50) {
        isFloatingOverlay = true;
        break;
      }
      curr = curr.parentElement;
      depth++;
    }
    if (!isFloatingOverlay) continue;

    const nearBottom = rect.bottom >= vh * 0.5 ? 2 : 0;
    const nearSide = rect.left <= vw * 0.25 || rect.right >= vw * 0.75 ? 1 : 0;
    const score = 1 + nearBottom + nearSide;
    if (!best || score > best.score) {
      best = { el: node, score };
    }
  }

  return best?.el ?? null;
}

function findOpenBubbleForSprite(sprite: Element, bubbleSelectors: string[]): AnchorRect | null {
  // 1. Check exact selectors (starting with SVG .dshwv-bshape so we measure the true painted oval!)
  for (const bSel of bubbleSelectors) {
    try {
      const nodes = document.querySelectorAll(bSel);
      for (const bEl of nodes) {
        if (bEl === sprite) continue;
        // Must have substantial painted area (hidden scale(0) shapes shrink to 0x0)
        if (isElementReallyVisible(bEl, 55, 36)) {
          return toAnchorRect(bEl.getBoundingClientRect());
        }
      }
    } catch {
      // Ignore selector error
    }
  }

  // 2. Also check any visible bubble/popover sibling inside the widget's fixed root
  const root = sprite.closest('[class*="dshwv"], [class*="dafeiyu"], [class*="dsh-pet"]') ?? sprite.parentElement;
  if (root) {
    const extras = root.querySelectorAll('[class*="bubble"], [class*="pop"], [class*="speech"], [class*="toast"]');
    for (const el of extras) {
      if (el === sprite || el.contains(sprite)) continue;
      if (isElementReallyVisible(el, 55, 36)) {
        return toAnchorRect(el.getBoundingClientRect());
      }
    }
  }

  return null;
}

function findWidgetAndBubble(customSelector?: string): {
  kind: WhaleAnchorState['widgetKind'];
  sprite: Element | null;
  bubbleRect: AnchorRect | null;
} {
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
        const el = document.querySelector(sel);
        if (!isElementReallyVisible(el, 24, 24)) continue;
        return {
          kind: rule.kind,
          sprite: el,
          bubbleRect: findOpenBubbleForSprite(el, rule.bubbleSelectors),
        };
      } catch {
        // Ignore selector error
      }
    }
  }

  const generic = detectGenericFloatingMascot();
  if (generic) {
    return {
      kind: 'generic-mascot',
      sprite: generic,
      bubbleRect: findOpenBubbleForSprite(generic, []),
    };
  }

  return { kind: 'none', sprite: null, bubbleRect: null };
}

/**
 * Observes ANY installed DSH mascot/pet widget with accurate SVG/HTML open-bubble detection
 * and instant MutationObserver response so our status bubble NEVER overlaps the widget's bubble.
 */
export function useWhaleAnchor(enabled: boolean, customSelector?: string): WhaleAnchorState {
  const [anchor, setAnchor] = useState<WhaleAnchorState>({
    found: false,
    widgetKind: 'none',
    avatarRect: null,
    isLeftFlipped: false,
    widgetBubbleRect: null,
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      setAnchor({
        found: false,
        widgetKind: 'none',
        avatarRect: null,
        isLeftFlipped: false,
        widgetBubbleRect: null,
      });
      return;
    }

    let rafId = 0;

    const measure = () => {
      rafId = 0;
      const { kind, sprite, bubbleRect } = findWidgetAndBubble(customSelector);
      if (!sprite) {
        setAnchor((prev) =>
          prev.found
            ? {
                found: false,
                widgetKind: 'none',
                avatarRect: null,
                isLeftFlipped: false,
                widgetBubbleRect: null,
              }
            : prev,
        );
        return;
      }

      const avatarRect = toAnchorRect(sprite.getBoundingClientRect());
      const centerX = avatarRect.left + avatarRect.width / 2;
      const isLeftFlipped = Boolean(
        sprite.closest('.dshwv-left') ||
          sprite.classList.contains('dshwv-left') ||
          centerX < window.innerWidth * 0.35,
      );

      setAnchor((prev) => {
        const sameAvatar =
          prev.found &&
          prev.widgetKind === kind &&
          prev.isLeftFlipped === isLeftFlipped &&
          prev.avatarRect &&
          Math.abs(prev.avatarRect.left - avatarRect.left) < 1 &&
          Math.abs(prev.avatarRect.top - avatarRect.top) < 1 &&
          Math.abs(prev.avatarRect.width - avatarRect.width) < 1 &&
          Math.abs(prev.avatarRect.height - avatarRect.height) < 1;

        const sameBubble =
          (!prev.widgetBubbleRect && !bubbleRect) ||
          (prev.widgetBubbleRect &&
            bubbleRect &&
            Math.abs(prev.widgetBubbleRect.top - bubbleRect.top) < 1 &&
            Math.abs(prev.widgetBubbleRect.left - bubbleRect.left) < 1 &&
            Math.abs(prev.widgetBubbleRect.width - bubbleRect.width) < 1 &&
            Math.abs(prev.widgetBubbleRect.height - bubbleRect.height) < 1);

        if (sameAvatar && sameBubble) return prev;
        return { found: true, widgetKind: kind, avatarRect, isLeftFlipped, widgetBubbleRect: bubbleRect };
      });
    };

    const scheduleMeasure = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(measure);
    };

    measure();

    // Instant reaction when widget opens/closes its balance bubble via class/style mutations
    const mo = new MutationObserver(scheduleMeasure);
    mo.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    window.addEventListener('resize', scheduleMeasure, { passive: true });
    window.addEventListener('pointerup', scheduleMeasure, { passive: true });
    window.addEventListener('pointermove', scheduleMeasure, { passive: true });
    const interval = window.setInterval(scheduleMeasure, 250);

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      mo.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('pointerup', scheduleMeasure);
      window.removeEventListener('pointermove', scheduleMeasure);
      window.clearInterval(interval);
    };
  }, [enabled, customSelector]);

  return anchor;
}
