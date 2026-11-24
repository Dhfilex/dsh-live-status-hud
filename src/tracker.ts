import type {
  ActivityPhase,
  ActivityStep,
  CompletedRunRecord,
  LiveHudConfig,
  SessionLiveStatus,
} from './types.ts';
import {
  extractLatestThoughtSnippet,
  translatePhaseHeadline,
  translateThoughtBufferToCuteZh,
  translateToolActivity,
} from './translator.ts';

export interface SessionEventInput {
  sessionId: string;
  type: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

const MAX_THOUGHT_BUFFER_CHARS = 24000;

export const DEFAULT_HUD_CONFIG: LiveHudConfig = {
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
};

function extractReasoningText(data: Record<string, unknown>): string | undefined {
  const direct =
    data.reasoning_content ??
    data.reasoning ??
    data.thinking ??
    data.thought ??
    data.reasoningDelta;
  if (typeof direct === 'string' && direct) return direct;

  const delta = data.delta as Record<string, unknown> | undefined;
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

  const channel = String(data.channel ?? data.partType ?? data.contentType ?? data.kind ?? '').toLowerCase();
  if (channel.includes('reason') || channel.includes('think')) {
    const text = data.text ?? data.content ?? data.chunk;
    if (typeof text === 'string' && text) return text;
  }

  const contentArr = Array.isArray(data.content)
    ? data.content
    : Array.isArray((data.message as Record<string, unknown> | undefined)?.content)
      ? ((data.message as Record<string, unknown>).content as unknown[])
      : null;

  if (contentArr) {
    const chunks: string[] = [];
    for (const part of contentArr) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        const pType = String(p.type ?? '').toLowerCase();
        if (pType === 'reasoning' || pType === 'thinking' || pType === 'thought') {
          const t = p.text ?? p.thinking ?? p.reasoning ?? p.content;
          if (typeof t === 'string' && t.trim()) chunks.push(t.trim());
        }
      }
    }
    if (chunks.length > 0) return chunks.join('\n');
  }

  return undefined;
}

export class LiveStatusTracker {
  private readonly sessions = new Map<string, SessionLiveStatus>();
  private readonly archivedTurnStarts = new Map<string, number>();
  private readonly config: LiveHudConfig;
  private stepSeq = 0;
  private runSeq = 0;

  constructor(config?: Partial<LiveHudConfig>) {
    this.config = {
      ...DEFAULT_HUD_CONFIG,
      ...config,
      whaleAdapter: {
        ...DEFAULT_HUD_CONFIG.whaleAdapter,
        ...(config?.whaleAdapter ?? {}),
      },
    };
  }

  getConfig(): LiveHudConfig {
    return {
      ...this.config,
      whaleAdapter: { ...this.config.whaleAdapter },
    };
  }

  private ensureSession(sessionId: string, now: number): SessionLiveStatus {
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
        isStalled: false,
        recentSteps: [],
        history: [],
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private appendThought(state: SessionLiveStatus, text: string): void {
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
  }

  private pushStep(state: SessionLiveStatus, step: ActivityStep): void {
    state.recentSteps.push(step);
    if (state.recentSteps.length > this.config.maxRecentSteps) {
      state.recentSteps.splice(0, state.recentSteps.length - this.config.maxRecentSteps);
    }
  }

  /**
   * Archives the completed turn into `state.history` (deduped by `turnStartedAt`)
   * so history is preserved across turns and never disappears on completion.
   */
  private archiveCurrentRun(state: SessionLiveStatus, now: number, outcome: 'done' | 'error'): void {
    const turnKey = state.turnStartedAt ?? 0;
    if (turnKey === 0) return;
    if (state.recentSteps.length === 0 && !state.thoughtBuffer && state.stepCount === 0) return;
    if (this.archivedTurnStarts.get(state.sessionId) === turnKey) return;

    this.archivedTurnStarts.set(state.sessionId, turnKey);
    const record: CompletedRunRecord = {
      id: `run-${++this.runSeq}-${now}`,
      finishedAt: now,
      durationMs: Math.max(0, now - turnKey),
      stepCount: Math.max(state.stepCount, state.recentSteps.length),
      outcome,
      headline: state.recentSteps.length > 0
        ? state.recentSteps[state.recentSteps.length - 1].label
        : state.thoughtSnippetZh || state.headline,
      thoughtSnippetZh: state.thoughtSnippetZh,
      thoughtBufferZh: state.thoughtBufferZh,
      thoughtBuffer: state.thoughtBuffer,
      steps: state.recentSteps.map((s) => ({ ...s })),
    };

    state.history.unshift(record);
    if (state.history.length > this.config.maxHistoryRuns) {
      state.history.length = this.config.maxHistoryRuns;
    }
  }

  private setPhase(
    state: SessionLiveStatus,
    phase: ActivityPhase,
    now: number,
    headline?: string,
    detail?: string,
  ): void {
    if (state.phase !== phase) {
      state.phase = phase;
      state.phaseStartedAt = now;
    }
    state.headline =
      headline ??
      translatePhaseHeadline(phase, this.config.locale, this.config.persona, state.stepCount);
    state.detail = detail;
    state.updatedAt = now;
  }

  handleEvent(input: SessionEventInput): SessionLiveStatus {
    const now = input.timestamp ?? Date.now();
    const state = this.ensureSession(input.sessionId, now);
    const data = input.data ?? {};
    const type = input.type;

    const reasoningText = extractReasoningText(data);
    if (reasoningText) {
      if (state.turnStartedAt === null || state.phase === 'done' || state.phase === 'idle') {
        if (state.phase === 'done') {
          this.archiveCurrentRun(state, now, 'done');
        }
        state.turnStartedAt = now;
        state.stepCount = Math.max(1, state.stepCount);
      }
      this.appendThought(state, reasoningText);
      if (state.activeTools.length === 0 && (state.phase === 'idle' || state.phase === 'done' || state.phase === 'thinking')) {
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
          // Archive previous run before resetting for the new turn!
          if (state.turnStartedAt !== null && (state.recentSteps.length > 0 || state.thoughtBuffer)) {
            this.archiveCurrentRun(state, now, state.phase === 'error' ? 'error' : 'done');
          }
          state.turnStartedAt = now;
          state.stepCount = 0;
          state.activeTools = [];
          state.recentSteps = [];
          state.thoughtBuffer = '';
          state.thoughtBufferZh = '';
          state.thoughtSnippet = undefined;
          state.thoughtSnippetZh = undefined;
        }
        state.stepCount += 1;
        this.setPhase(state, 'thinking', now);
        break;
      }

      case 'reasoning/delta':
      case 'assistant/reasoning': {
        if (state.turnStartedAt === null) state.turnStartedAt = now;
        if (state.activeTools.length === 0) {
          this.setPhase(state, 'thinking', now, state.phase === 'thinking' ? state.headline : undefined);
        }
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
            if (nextPhase === 'done') {
              this.archiveCurrentRun(state, now, 'done');
            }
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
        const args =
          (typeof data.arguments === 'object' && data.arguments !== null
            ? (data.arguments as Record<string, unknown>)
            : typeof data.args === 'object' && data.args !== null
              ? (data.args as Record<string, unknown>)
              : data) as Record<string, unknown>;

        state.stepCount += 1;
        const translated = translateToolActivity(
          toolName,
          args,
          this.config.locale,
          this.config.persona,
          state.stepCount,
        );
        const callId = String(data.callId ?? data.id ?? `step-${++this.stepSeq}`);

        // Deduplicate repeated tool/call notifications with the same callId
        const existing = state.recentSteps.find((s) => s.id === callId);
        if (!existing) {
          if (!state.activeTools.includes(toolName)) {
            state.activeTools.push(toolName);
          }
          this.pushStep(state, {
            id: callId,
            phase: 'running_tool',
            toolName,
            label: translated.label,
            detail: translated.detail,
            startedAt: now,
            status: 'running',
          });
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
            callId ? s.id === String(callId) : (!toolName || s.toolName === toolName) && s.status === 'running',
          );

        if (targetStep) {
          targetStep.endedAt = now;
          targetStep.status = failed ? 'failed' : 'completed';
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

      case 'approval/request':
      case 'approval/asked':
      case 'approval/requested':
      case 'interaction/approval': {
        const reason =
          typeof data.reason === 'string'
            ? data.reason
            : typeof data.toolName === 'string'
              ? data.toolName
              : undefined;
        this.setPhase(state, 'waiting_approval', now, undefined, reason);
        break;
      }

      case 'approval/decided':
      case 'approval/resolved': {
        if (state.phase === 'waiting_approval') {
          this.setPhase(state, state.activeTools.length > 0 ? 'running_tool' : 'thinking', now);
        }
        break;
      }

      case 'assistant/live-chunk':
      case 'llm/stream':
      case 'agent/assistant-stream': {
        const kind = String(data.kind ?? data.frame ?? 'chunk').toLowerCase();
        if (reasoningText) {
          if (state.activeTools.length === 0) {
            this.setPhase(state, 'thinking', now, state.phase === 'thinking' ? state.headline : undefined);
          }
          break;
        }
        if (kind === 'start' || kind === 'chunk') {
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
        if (data.error) {
          this.setPhase(state, 'error', now, undefined, String(data.error));
          this.archiveCurrentRun(state, now, 'error');
        } else {
          this.setPhase(state, 'done', now);
          this.archiveCurrentRun(state, now, 'done');
        }
        break;
      }

      case 'agent/error': {
        const msg = typeof data.message === 'string' ? data.message : undefined;
        this.setPhase(state, 'error', now, undefined, msg);
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
        break;
    }

    return this.getSnapshot(input.sessionId, now) ?? state;
  }

  getSnapshot(sessionId: string, now = Date.now()): SessionLiveStatus | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    const activePhases: ActivityPhase[] = ['thinking', 'running_tool', 'streaming'];
    const isStalled =
      activePhases.includes(state.phase) &&
      now - state.updatedAt >= this.config.stallThresholdMs;

    return {
      ...state,
      activeTools: [...state.activeTools],
      recentSteps: state.recentSteps.map((step) => ({ ...step })),
      history: state.history.map((run) => ({
        ...run,
        steps: run.steps.map((s) => ({ ...s })),
      })),
      isStalled,
    };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
