// Compiled Host ESM entry for DeepSeek Harness (dsh 0.2.2-rc.3+)
// Zero waterfall hooks (never touches tools/pre-execute) -> 100% safe for tool execution!
import { DEFAULT_HUD_CONFIG, LiveStatusTracker } from './tracker.js';

export const name = 'live-status-hud';
export const inject = [];

export const HTTP_PATH_SNAPSHOT = '/dsh-live-status-hud/snapshot';
export const HTTP_PATH_DEBUG = '/dsh-live-status-hud/debug';
export const HTTP_PATH_SETTINGS = '/dsh-live-status-hud/settings';

function asRecord(val) {
  return val && typeof val === 'object' ? val : undefined;
}

function extractSessionId(first, second) {
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

function isLocalAuthorizedRequest(req) {
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

function sendJson(res, payload, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end?.(JSON.stringify(payload));
}

function parseQueryParam(urlStr, key) {
  if (!urlStr) return undefined;
  try {
    const parsed = new URL(urlStr, 'http://127.0.0.1');
    const val = parsed.searchParams.get(key);
    return val && val.trim() ? val.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx, rawConfig) {
  const tracker = new LiveStatusTracker(rawConfig);
  const config = tracker.getConfig();

  let lastActiveSessionId;
  let lastKnownRoute = null;
  const recentRawEventTypes = [];

  const recordDebugType = (label) => {
    recentRawEventTypes.push(label);
    if (recentRawEventTypes.length > 25) recentRawEventTypes.shift();
  };

  const buildSnapshot = (requestedSessionId) => {
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
        persona: tracker.getConfig().persona,
        showThoughtChain: config.showThoughtChain,
        hideWhenIdle: config.hideWhenIdle,
        idleAutoMinimizeMs: config.idleAutoMinimizeMs,
        stallThresholdMs: config.stallThresholdMs,
        defaultPosition: config.defaultPosition,
        bubbleTheme: config.bubbleTheme,
        whaleAdapter: config.whaleAdapter,
        aiSummary: tracker.getAiSummaryPublicState(),
      },
      serverNow,
    };
  };

  const disposers = [];

  // 1. Read-only canonical session events (NEVER touches tools/pre-execute waterfall)
  disposers.push(
    ctx.on('session/event', (arg1, arg2) => {
      const eventObj = asRecord(arg2) ?? asRecord(asRecord(arg1)?.event) ?? asRecord(arg1);
      const sessionId = extractSessionId(arg1, arg2);
      const eventType = String(eventObj?.type ?? '');
      if (!sessionId || !eventType) return;

      lastActiveSessionId = sessionId;
      recordDebugType(`session/event:${eventType}`);

      const eventData = asRecord(eventObj?.data) ?? asRecord(eventObj?.payload) ?? eventObj;
      const routeCandidate =
        (eventData && typeof eventData.provider === 'string' && typeof eventData.model === 'string' && eventData) ||
        (eventData?.provenance && typeof eventData.provenance.provider === 'string' && typeof eventData.provenance.model === 'string' && eventData.provenance) ||
        (eventData?.header && typeof eventData.header.provider === 'string' && typeof eventData.header.model === 'string' && eventData.header) ||
        (eventData?.route && typeof eventData.route.provider === 'string' && typeof eventData.route.model === 'string' && eventData.route);
      if (routeCandidate) {
        lastKnownRoute = { provider: routeCandidate.provider, model: routeCandidate.model };
      }
      tracker.handleEvent({
        sessionId,
        type: eventType,
        data: eventData,
      });
    }),
  );

  // 2. Read-only emit events ONLY (NEVER hook waterfall events like llm/stream, approval/request, tools/pre-execute!)
  for (const eventName of [
    'assistant/live-chunk',
    'agent/assistant-stream',
    'approval/asked',
    'approval/decided',
    'agent/status',
    'agent/error',
    'agent/disposed',
  ]) {
    disposers.push(
      ctx.on(eventName, (arg1, arg2) => {
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

  // 3. Exact HTTP routes with loopback + Origin guard, 304 rev short-circuit, and redacted debug output
  const mountWebRoutes = (webCtx) => {
    const ws = webCtx?.webServer;
    if (!ws || typeof ws.register !== 'function') return;

    const d1 = ws.register({
      kind: 'exact',
      path: HTTP_PATH_SNAPSHOT,
      handler: (req, res) => {
        if (!isLocalAuthorizedRequest(req)) {
          sendJson(res, { ok: false, error: 'Forbidden origin or non-loopback peer' }, 403);
          return;
        }
        const snap = buildSnapshot(parseQueryParam(req?.url, 'sessionId'));
        const clientRev = Number.parseInt(parseQueryParam(req?.url, 'rev') || '', 10);
        const currentRev = snap.status?.rev ?? 0;
        if (Number.isFinite(clientRev) && clientRev > 0 && clientRev === currentRev) {
          res.statusCode = 304;
          res.setHeader?.('Cache-Control', 'no-store');
          res.end?.();
          return;
        }
        sendJson(res, snap);
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
          aiSummary: tracker.getAiSummaryPublicState(),
          lastActiveSessionId: lastActiveSessionId ?? null,
          recentRawEventTypes,
          summary: snap
            ? {
                phase: snap.phase,
                rev: snap.rev ?? 0,
                stepCount: snap.stepCount,
                recentStepsCount: snap.recentSteps.length,
                historyCount: snap.history.length,
                thoughtLength: snap.thoughtBuffer.length,
              }
            : null,
        });
      },
    });
    const d3 = ws.register({
      kind: 'exact',
      path: HTTP_PATH_SETTINGS,
      handler: (req, res) => {
        if (!isLocalAuthorizedRequest(req)) {
          sendJson(res, { ok: false, error: 'Forbidden origin or non-loopback peer' }, 403);
          return;
        }
        const rawFlag = parseQueryParam(req?.url, 'aiSummary');
        if (rawFlag === '1' || rawFlag === 'true' || rawFlag === '0' || rawFlag === 'false') {
          tracker.setAiSummaryEnabled(rawFlag === '1' || rawFlag === 'true');
        }
        const rawPersona = parseQueryParam(req?.url, 'persona');
        if (rawPersona) {
          tracker.setPersona(rawPersona);
        }
        sendJson(res, { ok: true, aiSummary: tracker.getAiSummaryPublicState(), persona: tracker.getConfig().persona });
      },
    });
    if (typeof d1 === 'function') disposers.push(d1);
    if (typeof d2 === 'function') disposers.push(d2);
    if (typeof d3 === 'function') disposers.push(d3);
  };

  // Optional: reuse DSH's own configured ctx.llm channel so AI Summary works out-of-the-box with zero extra API key!
  let agentsSvc = null;
  const mountDshLlm = (llmCtx) => {
    const llm = llmCtx?.llm;
    if (!llm || typeof llm.stream !== 'function') return;
    tracker.setDshLlmSummarizer(async (userPrompt, systemPrompt, signal) => {
      let route = lastKnownRoute;
      // 1. Check live agent handle via agents.get(id) (agents.list() items only carry id in DSH 0.2.2)
      if (!route && agentsSvc) {
        try {
          const candidateIds = [];
          if (lastActiveSessionId) candidateIds.push(lastActiveSessionId);
          if (typeof agentsSvc.list === 'function') {
            for (const item of agentsSvc.list() || []) {
              const id = typeof item === 'string' ? item : (item?.id || item?.sessionId);
              if (id && !candidateIds.includes(id)) candidateIds.push(id);
            }
          }
          for (const id of candidateIds) {
            const handle = typeof agentsSvc.get === 'function' ? agentsSvc.get(id) : null;
            const m = handle?.model;
            if (m && typeof m.provider === 'string' && typeof m.model === 'string') {
              route = { provider: m.provider, model: m.model };
              lastKnownRoute = route;
              break;
            }
          }
        } catch {}
      }
      // 2. Probe llm.listModels(provider) WITH explicit provider argument (DSH 0.2.2 requires provider)
      if (!route && typeof llm.listModels === 'function') {
        const providers = [];
        try {
          if (typeof llm.listProviders === 'function') {
            for (const p of (await llm.listProviders()) || []) {
              const pname = typeof p === 'string' ? p : (p?.provider || p?.id || p?.name);
              if (pname && !providers.includes(pname)) providers.push(pname);
            }
          }
        } catch {}
        for (const fallbackProv of ['deepseek-account', 'deepseek', 'deepseek-official']) {
          if (!providers.includes(fallbackProv)) providers.push(fallbackProv);
        }
        for (const prov of providers) {
          try {
            const models = await llm.listModels(prov);
            if (Array.isArray(models) && models.length > 0) {
              const first = models[0];
              const modelId = typeof first === 'string' ? first : (first?.model || first?.id);
              if (modelId) {
                route = { provider: first?.provider || prov, model: modelId };
                lastKnownRoute = route;
                break;
              }
            }
          } catch {}
        }
      }
      if (!route) throw new Error('未检测到可用模型路由');

      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        maxTokens: 48,
        temperature: 0.2,
        purpose: 'live-status-hud-summary',
        signal,
      });
      let out = '';
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text;
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && !out && typeof chunk.block.text === 'string') {
          out = chunk.block.text;
        } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason?.message || '模型返回异常');
        }
      }
      return out;
    });
  };

  if (typeof ctx.inject === 'function') {
    const disposeWebInject = ctx.inject(['webServer'], (webCtx) => {
      mountWebRoutes(webCtx);
    });
    if (typeof disposeWebInject === 'function') disposers.push(disposeWebInject);
    const disposeAgentsInject = ctx.inject(['agents'], (aCtx) => {
      agentsSvc = aCtx?.agents || null;
      return () => { agentsSvc = null; };
    });
    if (typeof disposeAgentsInject === 'function') disposers.push(disposeAgentsInject);
    const disposeLlmInject = ctx.inject(['llm'], (llmCtx) => {
      mountDshLlm(llmCtx);
      return () => tracker.setDshLlmSummarizer(null);
    });
    if (typeof disposeLlmInject === 'function') disposers.push(disposeLlmInject);
  } else {
    mountWebRoutes(ctx);
    mountDshLlm(ctx);
  }

  const cleanup = () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Ignore cleanup errors on unload
      }
    }
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup);
  } else {
    ctx.on('dispose', cleanup);
  }
}

export { LiveStatusTracker, DEFAULT_HUD_CONFIG } from './tracker.js';
export {
  translateToolActivity,
  translatePhaseHeadline,
  extractLatestThoughtSnippet,
  translateThoughtBufferToCuteZh,
} from './translator.js';
