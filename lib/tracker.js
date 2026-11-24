// Compiled Host ESM module for DeepSeek Harness (dsh 0.2.2+)
import {
  extractLatestThoughtSnippet,
  translatePhaseHeadline,
  translateThoughtBufferToCuteZh,
  translateToolActivity,
} from './translator.js';

const MAX_THOUGHT_BUFFER_CHARS = 24000;

function parseToolArgs(data) {
  if (!data || typeof data !== 'object') return {};
  const candidates = [data.arguments, data.args, data.input, data.params, data.toolCall?.arguments];
  for (const raw of candidates) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      const trimmed = raw.trim();
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // Fallback for truncated streaming JSON strings
        const fallback = {};
        for (const k of ['command', 'script', 'path', 'file_path', 'filePath', 'description', 'query', 'pattern', 'content']) {
          const m = trimmed.match(new RegExp(`"${k}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
          if (m) {
            try { fallback[k] = JSON.parse(`"${m[1]}"`); } catch { fallback[k] = m[1]; }
          }
        }
        if (Object.keys(fallback).length > 0) return fallback;
      }
    }
  }
  return data;
}

function clipDetail(text, maxLen = 420) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

function formatRichToolDetail(toolName, args, fallbackDetail) {
  if (!args || typeof args !== 'object') return fallbackDetail || toolName;
  const parts = [];
  const pathVal = args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.filename ?? args.file;
  const cmdVal = args.command ?? args.cmd ?? args.script ?? args.code;
  const descVal = args.description ?? args.summary ?? args.title;
  const cwdVal = args.cwd ?? args.workdir ?? args.directory;
  const queryVal = args.query ?? args.pattern ?? args.search ?? args.keyword ?? args.url;
  const contentVal = args.content ?? args.new_string ?? args.newText ?? args.replacement ?? args.text ?? args.patch ?? args.diff;
  const oldVal = args.old_string ?? args.oldText;

  if (typeof descVal === 'string' && descVal.trim()) parts.push(`说明：${clipDetail(descVal, 120)}`);
  if (typeof pathVal === 'string' && pathVal.trim()) parts.push(`文件：${pathVal.trim()}`);
  if (typeof cwdVal === 'string' && cwdVal.trim()) parts.push(`目录：${cwdVal.trim()}`);
  if (typeof queryVal === 'string' && queryVal.trim()) parts.push(`检索：${clipDetail(queryVal, 140)}`);
  if (typeof cmdVal === 'string' && cmdVal.trim()) parts.push(`命令：\n${clipDetail(cmdVal, 480)}`);
  if (typeof oldVal === 'string' && oldVal.trim()) parts.push(`替换前：\n${clipDetail(oldVal, 160)}`);
  if (typeof contentVal === 'string' && contentVal.trim()) parts.push(`${oldVal ? '替换为' : '内容'}：\n${clipDetail(contentVal, 340)}`);

  if (parts.length > 0) return parts.join('\n');

  // Generic non-empty key preview for any other tools (MCP, etc.)
  const skipKeys = new Set(['callId', 'id', 'name', 'toolName', 'tool', 'type', 'sessionId', 'timestamp']);
  const kv = [];
  for (const [k, v] of Object.entries(args)) {
    if (skipKeys.has(k) || v === undefined || v === null || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s) kv.push(`${k}: ${clipDetail(s, 140)}`);
    if (kv.length >= 4) break;
  }
  if (kv.length > 0) return kv.join('\n');
  return fallbackDetail || toolName;
}

export const DEFAULT_HUD_CONFIG = {
  locale: 'zh-CN',
  persona: 'playful',
  showThoughtChain: true,
  hideWhenIdle: false,
  idleAutoMinimizeMs: 12_000,
  stallThresholdMs: 30_000,
  maxRecentSteps: 50,
  maxHistoryRuns: 15,
  defaultPosition: 'bottom-right',
  bubbleTheme: 'whale-comic',
  whaleAdapter: {
    enabled: true,
    conflictStrategy: 'stack',
  },
  aiSummary: {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 6000,
  },
};

function extractReasoningText(data) {
  if (!data || typeof data !== 'object') return undefined;

  const direct =
    data.reasoning_content ??
    data.reasoning ??
    data.thinking ??
    data.thought ??
    data.reasoningDelta;
  if (typeof direct === 'string' && direct) return direct;

  const delta = data.delta;
  if (delta && typeof delta === 'object') {
    const deltaReasoning =
      delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.thought;
    if (typeof deltaReasoning === 'string' && deltaReasoning) return deltaReasoning;
    if (
      (delta.type === 'reasoning' || delta.type === 'thinking') &&
      typeof delta.text === 'string'
    ) {
      return delta.text;
    }
  }

  const chunk = data.chunk;
  if (chunk && typeof chunk === 'object') {
    const chunkReasoning =
      chunk.reasoning_content ?? chunk.reasoning ?? chunk.thinking ?? chunk.thought;
    if (typeof chunkReasoning === 'string' && chunkReasoning) return chunkReasoning;
    if (
      (chunk.type === 'reasoning' || chunk.type === 'thinking' || chunk.kind === 'reasoning') &&
      typeof (chunk.text ?? chunk.delta) === 'string'
    ) {
      return chunk.text ?? chunk.delta;
    }
  }

  const channel = String(
    data.channel ?? data.partType ?? data.contentType ?? data.kind ?? data.type ?? '',
  ).toLowerCase();
  if (channel.includes('reason') || channel.includes('think')) {
    const text = data.text ?? data.content ?? data.delta ?? (typeof data.chunk === 'string' ? data.chunk : undefined);
    if (typeof text === 'string' && text) return text;
  }

  const contentArr = Array.isArray(data.content)
    ? data.content
    : Array.isArray(data.message?.content)
      ? data.message.content
      : null;

  if (contentArr) {
    const chunks = [];
    for (const part of contentArr) {
      if (part && typeof part === 'object') {
        const pType = String(part.type ?? '').toLowerCase();
        if (pType === 'reasoning' || pType === 'thinking' || pType === 'thought') {
          const t = part.text ?? part.thinking ?? part.reasoning ?? part.content;
          if (typeof t === 'string' && t.trim()) chunks.push(t.trim());
        }
      }
    }
    if (chunks.length > 0) return chunks.join('\n');
  }

  return undefined;
}

export class LiveStatusTracker {
  constructor(config) {
    this.sessions = new Map();
    this.archivedTurnStarts = new Map();
    this.stepSeq = 0;
    this.runSeq = 0;
    this.tlSeq = 0;
    this.rev = 0;
    this.lastAiError = null;
    this.summaryCache = new Map();
    this.dshLlmSummarizer = config?.dshLlmSummarizer || null;
    this.fetchImpl = config?.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.config = {
      ...DEFAULT_HUD_CONFIG,
      ...(config ?? {}),
      whaleAdapter: {
        ...DEFAULT_HUD_CONFIG.whaleAdapter,
        ...(config?.whaleAdapter ?? {}),
      },
      aiSummary: {
        ...DEFAULT_HUD_CONFIG.aiSummary,
        ...(config?.aiSummary ?? {}),
      },
    };
  }

  resolveAiCredentials() {
    const cfg = this.config.aiSummary || {};
    // Security: NEVER read OPENAI_API_KEY and send it to DeepSeek's API endpoint!
    const envKey = typeof process !== 'undefined' && process.env
      ? (process.env.DEEPSEEK_API_KEY || '')
      : '';
    const envBase = typeof process !== 'undefined' && process.env && process.env.DEEPSEEK_BASE_URL
      ? process.env.DEEPSEEK_BASE_URL
      : '';
    const envModel = typeof process !== 'undefined' && process.env ? (process.env.DEEPSEEK_MODEL || '') : '';
    const apiKey = String(cfg.apiKey || envKey || '').trim();
    const rawBase = String(cfg.baseUrl || envBase || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
    const baseUrl = /\/v1$/i.test(rawBase) ? rawBase : `${rawBase}/v1`;
    const model = String(cfg.model || envModel || 'deepseek-chat').trim();
    const timeoutMs = Number(cfg.timeoutMs) > 500 ? Number(cfg.timeoutMs) : 6000;
    return { apiKey, baseUrl, model, timeoutMs, configured: Boolean(apiKey) };
  }

  setAiSummaryEnabled(enabled) {
    this.config.aiSummary.enabled = Boolean(enabled);
    if (!enabled) this.lastAiError = null;
    this.rev += 1;
    for (const s of this.sessions.values()) s.rev = this.rev;
    return this.getAiSummaryPublicState();
  }

  setPersona(persona) {
    if (persona === 'playful' || persona === 'concise' || persona === 'geek') {
      this.config.persona = persona;
      this.rev += 1;
      for (const s of this.sessions.values()) {
        s.headline = translatePhaseHeadline(s.phase, this.config.locale, persona, s.stepCount);
        s.rev = this.rev;
      }
    }
    return this.config.persona;
  }

  setDshLlmSummarizer(fn) {
    this.dshLlmSummarizer = typeof fn === 'function' ? fn : null;
    this.rev += 1;
    for (const s of this.sessions.values()) s.rev = this.rev;
  }

  getAiSummaryPublicState() {
    const creds = this.resolveAiCredentials();
    return {
      enabled: Boolean(this.config.aiSummary?.enabled),
      configured: Boolean(this.dshLlmSummarizer || creds.configured),
      viaDsh: Boolean(this.dshLlmSummarizer),
      model: creds.model,
      lastError: this.lastAiError,
    };
  }

  scheduleAiSummary(state, targetNode, targetStep, toolName, rawCommand, description) {
    if (!this.config.aiSummary?.enabled) return;
    const rawInput = [description, rawCommand].filter(Boolean).join('\n').trim();
    if (!rawInput || rawInput.length < 8) return;

    const cacheKey = `${toolName}:${rawInput.slice(0, 260)}`;
    const cached = this.summaryCache.get(cacheKey);
    if (cached) {
      if (targetNode) targetNode.title = `✨ ${cached}`;
      if (targetStep) targetStep.label = `✨ ${cached}`;
      state.rev = ++this.rev;
      return;
    }

    const creds = this.resolveAiCredentials();
    const useDshLlm = Boolean(this.dshLlmSummarizer);
    if (!useDshLlm && (!creds.configured || !this.fetchImpl)) return;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), creds.timeoutMs) : null;
    const sysPrompt = '把下面终端命令或脚本总结成一句极简中文动作（6到14个字，不要标点引号，直接说在干什么，例如：覆盖客户端脚本到桌面目录）。';
    const userPrompt = `工具: ${toolName}\n${rawInput.slice(0, 600)}`;

    void (async () => {
      try {
        let rawText = '';
        if (useDshLlm) {
          try {
            rawText = String(await this.dshLlmSummarizer(userPrompt, sysPrompt, controller?.signal) || '');
          } catch (dshErr) {
            const hasExplicitCfgKey = Boolean(String(this.config.aiSummary?.apiKey || '').trim());
            if (!hasExplicitCfgKey || !this.fetchImpl) throw dshErr;
          }
        }
        if (!rawText && creds.configured && this.fetchImpl) {
          const resp = await this.fetchImpl(`${creds.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${creds.apiKey}`,
            },
            signal: controller?.signal,
            body: JSON.stringify({
              model: creds.model,
              temperature: 0.2,
              max_tokens: 32,
              messages: [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: userPrompt },
              ],
            }),
          });
          if (!resp || !resp.ok) {
            this.lastAiError = `HTTP ${resp?.status ?? 'ERR'}`;
            state.rev = ++this.rev;
            return;
          }
          const json = await resp.json();
          rawText = String(json?.choices?.[0]?.message?.content || '');
        }
        rawText = rawText.replace(/[\r\n"'「」《》`]/g, '').trim();
        if (!rawText) return;
        this.lastAiError = null;
        const clean = rawText.length > 22 ? `${rawText.slice(0, 21)}…` : rawText;
        this.summaryCache.set(cacheKey, clean);
        if (this.summaryCache.size > 200) {
          const firstKey = this.summaryCache.keys().next().value;
          if (firstKey) this.summaryCache.delete(firstKey);
        }
        if (targetNode) targetNode.title = `✨ ${clean}`;
        if (targetStep) targetStep.label = `✨ ${clean}`;
        if (state.phase === 'running_tool' && state.recentSteps[state.recentSteps.length - 1] === targetStep) {
          state.headline = `✨ ${clean}`;
        }
        state.updatedAt = Date.now();
        state.rev = ++this.rev;
      } catch (err) {
        this.lastAiError = err?.name === 'AbortError' ? '请求超时' : (err?.message ? String(err.message).slice(0, 40) : '网络异常');
        state.rev = ++this.rev;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
  }

  getConfig() {
    return {
      ...this.config,
      whaleAdapter: { ...this.config.whaleAdapter },
      aiSummary: this.getAiSummaryPublicState(),
    };
  }

  ensureSession(sessionId, now) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        phase: 'idle',
        headline: translatePhaseHeadline('idle', this.config.locale, this.config.persona, 0),
        thoughtBuffer: '',
        thoughtBufferZh: '',
        stepCount: 0,
        activeTools: [],
        turnStartedAt: null,
        phaseStartedAt: now,
        updatedAt: now,
        rev: 0,
        isStalled: false,
        recentSteps: [],
        timeline: [],
        phaseDurations: { thinkingMs: 0, toolMs: 0, approvalMs: 0, streamingMs: 0 },
        history: [],
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  pushTimelineNode(state, node) {
    state.timeline.push(node);
    if (state.timeline.length > 80) {
      state.timeline.splice(0, state.timeline.length - 80);
    }
    return node;
  }

  closeRunningTimelineKinds(state, kinds, now, status = 'completed') {
    for (const node of state.timeline) {
      if (node.status === 'running' && kinds.includes(node.kind)) {
        node.status = status;
        node.endedAt = now;
      }
    }
  }

  accumulatePhaseDuration(state, now) {
    if (!state.phaseStartedAt || now <= state.phaseStartedAt) return;
    const delta = Math.min(now - state.phaseStartedAt, 3_600_000);
    if (state.phase === 'thinking') state.phaseDurations.thinkingMs += delta;
    else if (state.phase === 'running_tool') state.phaseDurations.toolMs += delta;
    else if (state.phase === 'waiting_approval') state.phaseDurations.approvalMs += delta;
    else if (state.phase === 'streaming') state.phaseDurations.streamingMs += delta;
  }

  appendThought(state, text, now = Date.now()) {
    if (!text) return;
    if (state.thoughtBuffer.endsWith(text)) return;
    const next = `${state.thoughtBuffer}${text}`;
    state.thoughtBuffer =
      next.length > MAX_THOUGHT_BUFFER_CHARS
        ? next.slice(next.length - MAX_THOUGHT_BUFFER_CHARS)
        : next;
    state.thoughtSnippet = extractLatestThoughtSnippet(state.thoughtBuffer);
    const zh = translateThoughtBufferToCuteZh(state.thoughtBuffer);
    state.thoughtSnippetZh = zh.snippetZh;
    state.thoughtBufferZh = zh.bufferZh;

    // Update or start a chronological 'thought' node on the metro timeline
    const lastNode = state.timeline[state.timeline.length - 1];
    if (lastNode && lastNode.kind === 'thought' && lastNode.status === 'running') {
      lastNode.rawText = `${lastNode.rawText || ''}${text}`.slice(-4000);
      const segZh = translateThoughtBufferToCuteZh(lastNode.rawText);
      lastNode.title = segZh.snippetZh || extractLatestThoughtSnippet(lastNode.rawText) || lastNode.title;
      lastNode.detail = segZh.bufferZh || lastNode.rawText;
    } else {
      this.closeRunningTimelineKinds(state, ['thought'], now);
      const segZh = translateThoughtBufferToCuteZh(text);
      this.pushTimelineNode(state, {
        id: `tl-${++this.tlSeq}`,
        kind: 'thought',
        title: segZh.snippetZh || extractLatestThoughtSnippet(text) || '思考中…',
        detail: segZh.bufferZh || text,
        rawText: text.slice(-4000),
        status: 'running',
        startedAt: now,
        endedAt: null,
      });
    }
  }

  pushStep(state, step) {
    state.recentSteps.push(step);
    if (state.recentSteps.length > this.config.maxRecentSteps) {
      state.recentSteps.splice(0, state.recentSteps.length - this.config.maxRecentSteps);
    }
  }

  archiveCurrentRun(state, now, outcome) {
    const turnKey = state.turnStartedAt ?? 0;
    if (turnKey === 0) return;
    if (state.recentSteps.length === 0 && !state.thoughtBuffer && state.stepCount === 0) return;
    if (this.archivedTurnStarts.get(state.sessionId) === turnKey) return;

    this.archivedTurnStarts.set(state.sessionId, turnKey);
    const record = {
      id: `run-${++this.runSeq}-${now}`,
      finishedAt: now,
      durationMs: Math.max(0, now - turnKey),
      stepCount: Math.max(state.stepCount, state.recentSteps.length),
      outcome,
      headline:
        state.recentSteps.length > 0
          ? state.recentSteps[state.recentSteps.length - 1].label
          : state.thoughtSnippetZh || state.headline,
      thoughtSnippetZh: state.thoughtSnippetZh,
      thoughtBufferZh: state.thoughtBufferZh,
      thoughtBuffer: state.thoughtBuffer,
      steps: state.recentSteps.map((s) => ({ ...s })),
      timeline: state.timeline.map((n) => ({ ...n })),
      phaseDurations: { ...state.phaseDurations },
    };

    state.history.unshift(record);
    if (state.history.length > this.config.maxHistoryRuns) {
      state.history.length = this.config.maxHistoryRuns;
    }
  }

  setPhase(state, phase, now, headline, detail) {
    if (state.phase !== phase) {
      this.accumulatePhaseDuration(state, now);
      state.phase = phase;
      state.phaseStartedAt = now;
    }
    state.headline =
      headline ??
      translatePhaseHeadline(phase, this.config.locale, this.config.persona, state.stepCount);
    state.detail = detail;
    state.updatedAt = now;
    state.rev = ++this.rev;
  }

  handleEvent(input) {
    const now = input.timestamp ?? Date.now();
    const state = this.ensureSession(input.sessionId, now);
    const data = input.data ?? {};
    const type = input.type;

    const reasoningText = extractReasoningText(data);
    if (reasoningText) {
      if (state.turnStartedAt === null || state.phase === 'done' || state.phase === 'idle') {
        if (state.phase === 'done') this.archiveCurrentRun(state, now, 'done');
        state.turnStartedAt = now;
        state.stepCount = Math.max(1, state.stepCount);
      }
      this.appendThought(state, reasoningText, now);
      if (
        state.activeTools.length === 0 &&
        (state.phase === 'idle' || state.phase === 'done' || state.phase === 'thinking')
      ) {
        this.setPhase(state, 'thinking', now, state.phase === 'thinking' ? state.headline : undefined);
      } else {
        state.updatedAt = now;
      }
    }

    switch (type) {
      case 'turn/start':
      case 'step/start': {
        const isBrandNewTurn =
          type === 'turn/start' ||
          state.turnStartedAt === null ||
          state.phase === 'done' ||
          state.phase === 'idle';

        if (isBrandNewTurn) {
          if (state.turnStartedAt !== null && (state.recentSteps.length > 0 || state.thoughtBuffer)) {
            this.archiveCurrentRun(state, now, state.phase === 'error' ? 'error' : 'done');
          }
          state.turnStartedAt = now;
          state.stepCount = 0;
          state.activeTools = [];
          state.recentSteps = [];
          state.timeline = [];
          state.phaseDurations = { thinkingMs: 0, toolMs: 0, approvalMs: 0, streamingMs: 0 };
          state.thoughtBuffer = '';
          state.thoughtBufferZh = '';
          state.thoughtSnippet = undefined;
          state.thoughtSnippetZh = undefined;
        }
        state.stepCount += 1;
        this.setPhase(state, 'thinking', now);
        break;
      }

      case 'agent/status': {
        const rawStatus = String(data.status ?? '').toLowerCase();
        if (rawStatus === 'running' || rawStatus === 'thinking') {
          if (state.turnStartedAt === null || state.phase === 'done') {
            if (state.phase === 'done') this.archiveCurrentRun(state, now, 'done');
            state.turnStartedAt = now;
          }
          if (state.phase === 'idle' || state.phase === 'done') {
            this.setPhase(state, 'thinking', now);
          }
        } else if (rawStatus === 'waiting_approval' || data.pendingInteraction === 'approval') {
          this.setPhase(state, 'waiting_approval', now);
        } else if (rawStatus === 'idle') {
          state.activeTools = [];
          for (const step of state.recentSteps) {
            if (step.status === 'running') {
              step.status = 'completed';
              step.endedAt = now;
            }
          }
          if (state.phase !== 'error') {
            const nextPhase = state.stepCount > 0 || state.recentSteps.length > 0 ? 'done' : 'idle';
            if (nextPhase === 'done') this.archiveCurrentRun(state, now, 'done');
            this.setPhase(state, nextPhase, now);
          }
        } else if (rawStatus === 'error' || rawStatus === 'failed') {
          const msg = typeof data.message === 'string' ? data.message : undefined;
          this.setPhase(state, 'error', now, undefined, msg);
          this.archiveCurrentRun(state, now, 'error');
        }
        break;
      }

      case 'tool/call':
      case 'command/run': {
        if (state.turnStartedAt === null || state.phase === 'done') {
          if (state.phase === 'done') this.archiveCurrentRun(state, now, 'done');
          state.turnStartedAt = now;
          state.stepCount = 0;
          state.recentSteps = [];
        }
        const toolName =
          type === 'command/run'
            ? 'command'
            : String(data.name ?? data.toolName ?? data.tool ?? 'tool');
        const args = parseToolArgs(data);

        state.stepCount += 1;
        const translated = translateToolActivity(
          toolName,
          args,
          this.config.locale,
          this.config.persona,
          state.stepCount,
        );
        const callId = String(data.callId ?? data.id ?? `step-${++this.stepSeq}`);

        const existing = state.recentSteps.find((s) => s.id === callId);
        if (!existing) {
          if (!state.activeTools.includes(toolName)) {
            state.activeTools.push(toolName);
          }
          this.closeRunningTimelineKinds(state, ['thought'], now);
          const newStep = {
            id: callId,
            phase: 'running_tool',
            toolName,
            label: translated.label,
            detail: translated.detail,
            startedAt: now,
            status: 'running',
          };
          this.pushStep(state, newStep);
          const richDetail = formatRichToolDetail(toolName, args, translated.detail);
          newStep.detail = richDetail;
          const newTl = this.pushTimelineNode(state, {
            id: `tool-${callId}`,
            kind: 'tool',
            toolName,
            title: translated.label,
            detail: richDetail,
            status: 'running',
            startedAt: now,
            endedAt: null,
          });
          if (/(^|[_:/-])(bash|pwsh|powershell|zsh|sh|shell|exec|terminal|command|run_command|cmd)($|[_:/-])/.test(toolName.toLowerCase())) {
            const rawCmd = typeof args?.command === 'string' ? args.command : typeof args?.script === 'string' ? args.script : typeof args?.cmd === 'string' ? args.cmd : '';
            const rawDesc = typeof args?.description === 'string' ? args.description : typeof args?.summary === 'string' ? args.summary : '';
            this.scheduleAiSummary(state, newTl, newStep, toolName, rawCmd, rawDesc);
          }
        }

        this.setPhase(state, 'running_tool', now, translated.label, translated.detail);
        break;
      }

      case 'tool/result':
      case 'command/done': {
        const toolName =
          type === 'command/done'
            ? 'command'
            : String(data.name ?? data.toolName ?? data.tool ?? '');
        const callId = data.callId ?? data.id;
        const failed = Boolean(
          data.isError || data.error || (typeof data.exitCode === 'number' && data.exitCode !== 0),
        );

        const targetStep = [...state.recentSteps]
          .reverse()
          .find((s) =>
            callId
              ? s.id === String(callId)
              : (!toolName || s.toolName === toolName) && s.status === 'running',
          );

        if (targetStep) {
          targetStep.endedAt = now;
          targetStep.status = failed ? 'failed' : 'completed';
        }
        const targetTl = [...state.timeline]
          .reverse()
          .find((n) => n.kind === 'tool' && (callId ? n.id === `tool-${callId}` : (!toolName || n.toolName === toolName) && n.status === 'running'));
        if (targetTl) {
          targetTl.endedAt = now;
          targetTl.status = failed ? 'failed' : 'completed';
          const errMsg = typeof data.error === 'string' ? data.error : typeof data.stderr === 'string' && failed ? data.stderr : '';
          if (errMsg && errMsg.trim()) {
            targetTl.detail = `${targetTl.detail ? targetTl.detail + '\n' : ''}错误：${clipDetail(errMsg, 180)}`;
          }
        }

        if (toolName) {
          state.activeTools = state.activeTools.filter((t) => t !== toolName);
        } else if (state.activeTools.length > 0) {
          state.activeTools.pop();
        }

        if (state.activeTools.length === 0) {
          this.setPhase(state, 'thinking', now);
        } else {
          const latestRunning = [...state.recentSteps].reverse().find((s) => s.status === 'running');
          this.setPhase(state, 'running_tool', now, latestRunning?.label, latestRunning?.detail);
        }
        break;
      }

      // Real DSH 0.2.2-rc.3 approval vocabulary: approval/request, approval/asked, approval/decided
      case 'approval/request':
      case 'approval/asked':
      case 'approval/requested':
      case 'interaction/approval': {
        const reason =
          typeof data.reason === 'string'
            ? data.reason
            : typeof data.toolName === 'string'
              ? data.toolName
              : typeof data.summary === 'string'
                ? data.summary
                : undefined;
        this.closeRunningTimelineKinds(state, ['thought'], now);
        this.pushTimelineNode(state, {
          id: `tl-${++this.tlSeq}`,
          kind: 'approval',
          title: reason ? `等待批准：${reason}` : '等待你的操作审批',
          detail: reason || '确认后将继续执行下一步操作',
          status: 'running',
          startedAt: now,
          endedAt: null,
        });
        this.setPhase(state, 'waiting_approval', now, undefined, reason);
        break;
      }

      case 'approval/decided':
      case 'approval/resolved': {
        this.closeRunningTimelineKinds(state, ['approval'], now);
        if (state.phase === 'waiting_approval') {
          this.setPhase(state, state.activeTools.length > 0 ? 'running_tool' : 'thinking', now);
        }
        break;
      }

      // Real DSH 0.2.2-rc.3 live streaming vocabulary: assistant/live-chunk, llm/stream, agent/assistant-stream
      case 'assistant/live-chunk':
      case 'llm/stream':
      case 'agent/assistant-stream': {
        if (reasoningText) {
          if (state.activeTools.length === 0) {
            this.setPhase(state, 'thinking', now, state.phase === 'thinking' ? state.headline : undefined);
          }
          break;
        }
        const kind = String(data.kind ?? data.frame ?? data.type ?? 'chunk').toLowerCase();
        if (kind === 'start' || kind === 'chunk' || kind === 'text' || kind === 'text-delta' || typeof data.text === 'string') {
          if (state.turnStartedAt === null) state.turnStartedAt = now;
          if (state.activeTools.length === 0) {
            this.setPhase(state, 'streaming', now);
          }
        }
        break;
      }

      case 'turn/end': {
        state.activeTools = [];
        for (const step of state.recentSteps) {
          if (step.status === 'running') {
            step.status = data.aborted ? 'failed' : 'completed';
            step.endedAt = now;
          }
        }
        this.closeRunningTimelineKinds(state, ['thought', 'tool', 'approval'], now, data.aborted ? 'failed' : 'completed');
        if (data.error) {
          this.setPhase(state, 'error', now, undefined, String(data.error));
          this.pushTimelineNode(state, { id: `tl-${++this.tlSeq}`, kind: 'error', title: state.headline, detail: String(data.error), status: 'failed', startedAt: now, endedAt: now });
          this.archiveCurrentRun(state, now, 'error');
        } else {
          this.setPhase(state, 'done', now);
          this.pushTimelineNode(state, { id: `tl-${++this.tlSeq}`, kind: 'done', title: state.headline, detail: '', status: 'completed', startedAt: now, endedAt: now });
          this.archiveCurrentRun(state, now, 'done');
        }
        break;
      }

      case 'agent/error': {
        const msg = typeof data.message === 'string' ? data.message : undefined;
        this.closeRunningTimelineKinds(state, ['thought', 'tool', 'approval'], now, 'failed');
        this.setPhase(state, 'error', now, undefined, msg);
        this.pushTimelineNode(state, { id: `tl-${++this.tlSeq}`, kind: 'error', title: state.headline, detail: msg || '', status: 'failed', startedAt: now, endedAt: now });
        this.archiveCurrentRun(state, now, 'error');
        break;
      }

      case 'agent/disposed': {
        state.activeTools = [];
        for (const step of state.recentSteps) {
          if (step.status === 'running') {
            step.status = 'completed';
            step.endedAt = now;
          }
        }
        if (state.phase !== 'error' && (state.stepCount > 0 || state.recentSteps.length > 0)) {
          this.setPhase(state, 'done', now);
          this.archiveCurrentRun(state, now, 'done');
        }
        if (this.sessions.size > 30) {
          const oldestKey = this.sessions.keys().next().value;
          if (oldestKey && oldestKey !== input.sessionId) {
            this.sessions.delete(oldestKey);
          }
        }
        return state;
      }

      default:
        state.updatedAt = now;
        state.rev = ++this.rev;
        break;
    }

    return this.getSnapshot(input.sessionId, now) ?? state;
  }

  getSnapshot(sessionId, now = Date.now()) {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    const activePhases = ['thinking', 'running_tool', 'streaming'];
    const isStalled =
      activePhases.includes(state.phase) &&
      now - state.updatedAt >= this.config.stallThresholdMs;

    const liveDurations = { ...state.phaseDurations };
    if (state.phaseStartedAt && now > state.phaseStartedAt) {
      const delta = Math.min(now - state.phaseStartedAt, 3_600_000);
      if (state.phase === 'thinking') liveDurations.thinkingMs += delta;
      else if (state.phase === 'running_tool') liveDurations.toolMs += delta;
      else if (state.phase === 'waiting_approval') liveDurations.approvalMs += delta;
      else if (state.phase === 'streaming') liveDurations.streamingMs += delta;
    }

    return {
      ...state,
      activeTools: [...state.activeTools],
      recentSteps: state.recentSteps.map((step) => ({ ...step })),
      timeline: state.timeline.map((n) => ({ ...n })),
      phaseDurations: liveDurations,
      history: state.history.map((run) => ({
        ...run,
        steps: run.steps.map((s) => ({ ...s })),
        timeline: Array.isArray(run.timeline) ? run.timeline.map((n) => ({ ...n })) : [],
      })),
      isStalled,
    };
  }

  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
}
