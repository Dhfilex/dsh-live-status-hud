import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_HUD_CONFIG, LiveStatusTracker } from './tracker.ts';
import type { HudSnapshotResponse, LiveHudConfig } from './types.ts';

export const name = 'live-status-hud';
export const inject = [];

export const HTTP_PATH_SNAPSHOT = '/dsh-live-status-hud/snapshot';
export const HTTP_PATH_DEBUG = '/dsh-live-status-hud/debug';

type AnyRecord = Record<string, unknown>;

interface HttpLikeReq {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

interface HttpLikeRes {
  statusCode?: number;
  setHeader?(name: string, value: string): void;
  end?(body?: string): void;
}

interface DshHostContext extends Context {
  on(event: string, listener: (...args: any[]) => void): () => void;
  inject?(deps: string[], callback: (ctx: DshHostContext) => void): () => void;
  effect?(callback: () => (() => void) | void): () => void;
  webServer?: {
    register(route: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: HttpLikeReq, res: HttpLikeRes) => unknown;
    }): () => void;
  };
}

function asRecord(val: unknown): AnyRecord | undefined {
  return val && typeof val === 'object' ? (val as AnyRecord) : undefined;
}

function extractSessionId(first: unknown, second?: unknown): string | undefined {
  for (const candidateObj of [first, second]) {
    const rec = asRecord(candidateObj);
    if (!rec) continue;
    const direct =
      rec.sessionId ??
      rec.id ??
      asRecord(rec.session)?.id ??
      asRecord(rec.agent)?.sessionId ??
      asRecord(rec.context)?.sessionId;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }
  }
  return undefined;
}

function isLocalAuthorizedRequest(req: HttpLikeReq | undefined): boolean {
  if (!req || typeof req !== 'object') return true;
  const headers = req.headers || {};
  const origin = String(headers.origin || headers.Origin || '').trim();
  if (origin) {
    const allowedOrigin =
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin) ||
      /^dsh-app:\/\//i.test(origin);
    if (!allowedOrigin) return false;
  }
  const remoteAddr = String(req.socket?.remoteAddress || '');
  if (remoteAddr) {
    const isLoopback =
      remoteAddr === '127.0.0.1' ||
      remoteAddr === '::1' ||
      remoteAddr === '::ffff:127.0.0.1';
    if (!isLoopback) return false;
  }
  return true;
}

function sendJson(res: HttpLikeRes, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end?.(JSON.stringify(payload));
}

function parseQuerySessionId(urlStr: string | undefined): string | undefined {
  if (!urlStr) return undefined;
  try {
    const parsed = new URL(urlStr, 'http://127.0.0.1');
    const sid = parsed.searchParams.get('sessionId');
    return sid && sid.trim() ? sid.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx: Context, rawConfig?: Partial<LiveHudConfig>): void {
  const hostCtx = ctx as DshHostContext;
  const tracker = new LiveStatusTracker(rawConfig);
  const config = tracker.getConfig();

  let lastActiveSessionId: string | undefined;
  const recentRawEventTypes: string[] = [];

  const recordDebugType = (label: string) => {
    recentRawEventTypes.push(label);
    if (recentRawEventTypes.length > 25) recentRawEventTypes.shift();
  };

  const buildSnapshot = (requestedSessionId?: string): HudSnapshotResponse => {
    const serverNow = Date.now();
    const targetId = requestedSessionId || lastActiveSessionId;
    const status =
      (targetId ? tracker.getSnapshot(targetId, serverNow) : null) ??
      (lastActiveSessionId && lastActiveSessionId !== targetId
        ? tracker.getSnapshot(lastActiveSessionId, serverNow)
        : null);

    return {
      status,
      config: {
        locale: config.locale,
        persona: config.persona,
        showThoughtChain: config.showThoughtChain,
        hideWhenIdle: config.hideWhenIdle,
        idleAutoMinimizeMs: config.idleAutoMinimizeMs,
        stallThresholdMs: config.stallThresholdMs,
        defaultPosition: config.defaultPosition,
        bubbleTheme: config.bubbleTheme,
        whaleAdapter: config.whaleAdapter,
      },
      serverNow,
    };
  };

  const disposers: Array<() => void> = [];

  // Read-only session events ONLY (never hooks tools/pre-execute waterfall)
  disposers.push(
    hostCtx.on('session/event', (arg1: unknown, arg2?: unknown) => {
      const eventObj = asRecord(arg2) ?? asRecord(asRecord(arg1)?.event) ?? asRecord(arg1);
      const sessionId = extractSessionId(arg1, arg2);
      const eventType = String(eventObj?.type ?? '');
      if (!sessionId || !eventType) return;

      lastActiveSessionId = sessionId;
      recordDebugType(`session/event:${eventType}`);

      const eventData = asRecord(eventObj?.data) ?? asRecord(eventObj?.payload) ?? eventObj;
      tracker.handleEvent({
        sessionId,
        type: eventType,
        data: eventData,
      });
    }),
  );

  // Read-only emit events ONLY (NEVER hook waterfall events like llm/stream, approval/request, tools/pre-execute!)
  for (const eventName of [
    'assistant/live-chunk',
    'agent/assistant-stream',
    'approval/asked',
    'approval/decided',
    'agent/status',
    'agent/error',
    'agent/disposed',
  ] as const) {
    disposers.push(
      hostCtx.on(eventName, (arg1: unknown, arg2?: unknown) => {
        const payload = asRecord(arg2) ?? asRecord(arg1);
        const sessionId = extractSessionId(arg1, arg2) ?? lastActiveSessionId;
        if (!sessionId) return;
        if (eventName !== 'agent/disposed') {
          lastActiveSessionId = sessionId;
        }
        recordDebugType(eventName);
        tracker.handleEvent({
          sessionId,
          type: eventName,
          data: payload,
        });
      }),
    );
  }

  const mountWebRoutes = (webCtx: DshHostContext) => {
    const ws = webCtx.webServer;
    if (!ws || typeof ws.register !== 'function') return;

    const d1 = ws.register({
      kind: 'exact',
      path: HTTP_PATH_SNAPSHOT,
      handler: (req, res) => {
        if (!isLocalAuthorizedRequest(req)) {
          sendJson(res, { ok: false, error: 'Forbidden origin or non-loopback peer' }, 403);
          return;
        }
        sendJson(res, buildSnapshot(parseQuerySessionId(req?.url)));
      },
    });
    const d2 = ws.register({
      kind: 'exact',
      path: HTTP_PATH_DEBUG,
      handler: (req, res) => {
        if (!isLocalAuthorizedRequest(req)) {
          sendJson(res, { ok: false, error: 'Forbidden origin or non-loopback peer' }, 403);
          return;
        }
        const snap = buildSnapshot(lastActiveSessionId).status;
        sendJson(res, {
          ok: true,
          version: '1.0.1',
          lastActiveSessionId: lastActiveSessionId ?? null,
          recentRawEventTypes,
          summary: snap
            ? {
                phase: snap.phase,
                stepCount: snap.stepCount,
                recentStepsCount: snap.recentSteps.length,
                historyCount: snap.history.length,
                thoughtLength: snap.thoughtBuffer.length,
              }
            : null,
        });
      },
    });
    if (typeof d1 === 'function') disposers.push(d1);
    if (typeof d2 === 'function') disposers.push(d2);
  };

  if (typeof hostCtx.inject === 'function') {
    const disposeWebInject = hostCtx.inject(['webServer'], (webCtx) => {
      mountWebRoutes(webCtx);
    });
    if (typeof disposeWebInject === 'function') disposers.push(disposeWebInject);
  } else {
    mountWebRoutes(hostCtx);
  }

  const cleanup = () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Ignore individual listener disposal errors on shutdown
      }
    }
  };

  if (typeof hostCtx.effect === 'function') {
    hostCtx.effect(() => cleanup);
  } else {
    hostCtx.on('dispose', cleanup);
  }
}

export { LiveStatusTracker, DEFAULT_HUD_CONFIG } from './tracker.ts';
export {
  translateToolActivity,
  translatePhaseHeadline,
  extractLatestThoughtSnippet,
  translateThoughtBufferToCuteZh,
} from './translator.ts';
export type * from './types.ts';
