import React, { useEffect, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { LiveStatusCapsule } from './LiveStatusCapsule.tsx';
import { WhaleThoughtBubble } from './WhaleThoughtBubble.tsx';
import { DefaultMiniCompanion } from './DefaultMiniCompanion.tsx';
import { useWhaleAnchor } from './whaleAnchor.ts';
import type {
  BubbleTheme,
  CompletedRunRecord,
  HudPosition,
  HudSnapshotResponse,
  SessionLiveStatus,
  WhaleAdapterConfig,
} from '../types.ts';

export const name = 'live-status-hud-client';
export const inject = ['slots'];

const HTTP_PATH_SNAPSHOT = '/dsh-live-status-hud/snapshot';
const POLL_ACTIVE_MS = 750;
const POLL_IDLE_MS = 2000;
const STORAGE_KEY_COMPANION_SIDE = 'dsh-live-status-hud:companion-side';
const STORAGE_KEY_SESSION_PREFIX = 'dsh-live-status-hud:session:';

interface SessionSummary {
  id: string;
  status?: string;
  pendingInteraction?: string | null;
}

interface SessionsStateShape {
  currentSessionId?: string | null;
  activeSessionId?: string | null;
  selectedSessionId?: string | null;
  currentId?: string | null;
  sessions?: SessionSummary[];
}

interface OverlaySlotProps {
  useSessions?: <T = SessionsStateShape>(selector: (state: SessionsStateShape) => T) => T;
}

const IDENTITY_SELECTOR = <T,>(s: T): T => s;

interface DshClientContext extends Context {
  slots: {
    register(
      meta: { name: string; id: string; order?: number },
      component: React.FC<OverlaySlotProps>,
    ): () => void;
  };
}

function loadSavedSessionStatus(sessionId: string): SessionLiveStatus | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_SESSION_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionLiveStatus;
    if (parsed && typeof parsed === 'object' && parsed.sessionId === sessionId) {
      return {
        ...parsed,
        history: Array.isArray(parsed.history) ? parsed.history : [],
        recentSteps: Array.isArray(parsed.recentSteps) ? parsed.recentSteps : [],
      };
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function saveSessionStatus(sessionId: string, status: SessionLiveStatus): void {
  try {
    window.localStorage.setItem(`${STORAGE_KEY_SESSION_PREFIX}${sessionId}`, JSON.stringify(status));
  } catch {
    // Ignore quota errors
  }
}

function mergeHistory(
  primary: CompletedRunRecord[] = [],
  saved: CompletedRunRecord[] = [],
): CompletedRunRecord[] {
  const byId = new Map<string, CompletedRunRecord>();
  for (const run of [...primary, ...saved]) {
    if (run && run.id && !byId.has(run.id)) byId.set(run.id, run);
  }
  return [...byId.values()].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 15);
}

export function apply(ctx: Context): void {
  const clientCtx = ctx as DshClientContext;

  const LiveStatusOverlay: React.FC<OverlaySlotProps> = ({ useSessions }) => {
    const sessionState = typeof useSessions === 'function' ? useSessions(IDENTITY_SELECTOR) : undefined;
    const activeId =
      sessionState?.currentSessionId ??
      sessionState?.activeSessionId ??
      sessionState?.selectedSessionId ??
      sessionState?.currentId ??
      null;
    const activeSummary = Array.isArray(sessionState?.sessions) ? sessionState.sessions.find((s) => s.id === activeId) : undefined;
    const isSessionRunning = activeSummary?.status === 'running';

    const [status, setStatus] = useState<SessionLiveStatus | null>(null);
    const [defaultPosition, setDefaultPosition] = useState<HudPosition>('bottom-right');
    const [bubbleTheme, setBubbleTheme] = useState<BubbleTheme>('whale-comic');
    const [showThoughtChain, setShowThoughtChain] = useState<boolean>(true);
    const [hideWhenIdle, setHideWhenIdle] = useState<boolean>(false);
    const [idleAutoMinimizeMs, setIdleAutoMinimizeMs] = useState<number>(12_000);
    const [whaleConfig, setWhaleConfig] = useState<WhaleAdapterConfig>({
      enabled: true,
      conflictStrategy: 'stack',
    });
    const [companionSide, setCompanionSide] = useState<'left' | 'right'>(() => {
      try {
        return window.localStorage.getItem(STORAGE_KEY_COMPANION_SIDE) === 'left' ? 'left' : 'right';
      } catch {
        return 'right';
      }
    });

    const whaleAnchor = useWhaleAnchor(
      whaleConfig.enabled && bubbleTheme === 'whale-comic',
      whaleConfig.customSelector,
    );

    const toggleCompanionSide = () => {
      setCompanionSide((prev) => {
        const next = prev === 'right' ? 'left' : 'right';
        try { window.localStorage.setItem(STORAGE_KEY_COMPANION_SIDE, next); } catch {}
        return next;
      });
    };

    const handleClearHistory = () => {
      if (!activeId) return;
      try { window.localStorage.removeItem(`${STORAGE_KEY_SESSION_PREFIX}${activeId}`); } catch {}
      setStatus((prev) => (prev ? { ...prev, history: [] } : prev));
    };

    useEffect(() => {
      if (!activeId) {
        setStatus(null);
        return;
      }

      const initialSaved = loadSavedSessionStatus(activeId);
      if (initialSaved) setStatus(initialSaved);

      let cancelled = false;
      let timerId = 0;

      const poll = async () => {
        let resp: HudSnapshotResponse | null = null;
        try {
          const r = await fetch(`${HTTP_PATH_SNAPSHOT}?sessionId=${encodeURIComponent(activeId)}`, {
            cache: 'no-store',
          });
          if (r.ok) resp = (await r.json()) as HudSnapshotResponse;
        } catch {
          // Ignore transient errors
        }
        if (cancelled) return;
        if (resp?.config) {
          if (resp.config.defaultPosition) setDefaultPosition(resp.config.defaultPosition);
          if (resp.config.bubbleTheme) setBubbleTheme(resp.config.bubbleTheme);
          if (typeof resp.config.showThoughtChain === 'boolean') setShowThoughtChain(resp.config.showThoughtChain);
          if (typeof resp.config.hideWhenIdle === 'boolean') setHideWhenIdle(resp.config.hideWhenIdle);
          if (typeof resp.config.idleAutoMinimizeMs === 'number') setIdleAutoMinimizeMs(resp.config.idleAutoMinimizeMs);
          if (resp.config.whaleAdapter) setWhaleConfig(resp.config.whaleAdapter);
        }

        const saved = loadSavedSessionStatus(activeId);
        const incoming = resp?.status ?? null;
        const nextDelay =
          isSessionRunning ||
          incoming?.phase === 'thinking' ||
          incoming?.phase === 'running_tool' ||
          incoming?.phase === 'streaming'
            ? POLL_ACTIVE_MS
            : POLL_IDLE_MS;

        if (incoming) {
          const merged: SessionLiveStatus = {
            ...incoming,
            history: mergeHistory(incoming.history, saved?.history),
          };
          if (merged.recentSteps.length > 0 || merged.thoughtBuffer || merged.history.length > 0) {
            saveSessionStatus(activeId, merged);
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
    }, [activeId, isSessionRunning]);

    if (bubbleTheme === 'whale-comic') {
      const showDefaultCompanion = !whaleAnchor.found;
      return React.createElement(
        React.Fragment,
        null,
        showDefaultCompanion
          ? React.createElement(DefaultMiniCompanion, {
              phase: status?.phase ?? 'idle',
              side: companionSide,
              onToggleSide: toggleCompanionSide,
            })
          : null,
        React.createElement(WhaleThoughtBubble, {
          status,
          isSessionRunning,
          anchor: whaleAnchor,
          fallbackSide: companionSide,
          conflictStrategy: whaleConfig.conflictStrategy,
          showThoughtChain,
          hideWhenIdle,
          idleAutoMinimizeMs,
          onClearHistory: handleClearHistory,
        }),
      );
    }

    return React.createElement(LiveStatusCapsule, { status, defaultPosition });
  };

  const mountSlot = () => clientCtx.slots.register({ name: 'shell.overlay', id: 'live-status-hud' }, LiveStatusOverlay);
  if (typeof (clientCtx.slots as any)?.inject === 'function') {
    (clientCtx.slots as any).inject('shell.overlay', mountSlot);
  } else {
    mountSlot();
  }
}
