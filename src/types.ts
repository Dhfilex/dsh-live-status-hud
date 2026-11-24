export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'running_tool'
  | 'waiting_approval'
  | 'streaming'
  | 'done'
  | 'error';

export type HudLocale = 'zh-CN' | 'en-US';
export type HudPosition = 'top-right' | 'bottom-right';
export type BubbleTheme = 'whale-comic' | 'glass-hud';
export type WhaleConflictStrategy = 'stack' | 'yield';
export type HudPersona = 'playful' | 'concise';

export interface WhaleAdapterConfig {
  enabled: boolean;
  customSelector?: string;
  conflictStrategy: WhaleConflictStrategy;
}

export interface LiveHudConfig {
  locale: HudLocale;
  persona: HudPersona;
  showThoughtChain: boolean;
  hideWhenIdle: boolean;
  /** Auto-minimize bubble into a tiny 💭 icon after this many ms of idle/done (0 = disable, default: 12000) */
  idleAutoMinimizeMs: number;
  stallThresholdMs: number;
  /** Maximum tool steps retained per run (default: 50) */
  maxRecentSteps: number;
  /** Maximum completed runs archived in history per session (default: 15) */
  maxHistoryRuns: number;
  defaultPosition: HudPosition;
  bubbleTheme: BubbleTheme;
  whaleAdapter: WhaleAdapterConfig;
}

export interface ActivityStep {
  id: string;
  phase: ActivityPhase;
  toolName?: string;
  label: string;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed';
}

export interface CompletedRunRecord {
  id: string;
  finishedAt: number;
  durationMs: number;
  stepCount: number;
  outcome: 'done' | 'error';
  headline: string;
  thoughtSnippetZh?: string;
  thoughtBufferZh: string;
  thoughtBuffer: string;
  steps: ActivityStep[];
}

export interface SessionLiveStatus {
  sessionId: string;
  phase: ActivityPhase;
  headline: string;
  detail?: string;
  thoughtSnippet?: string;
  thoughtSnippetZh?: string;
  thoughtBuffer: string;
  thoughtBufferZh: string;
  stepCount: number;
  activeTools: string[];
  turnStartedAt: number | null;
  phaseStartedAt: number;
  updatedAt: number;
  isStalled: boolean;
  recentSteps: ActivityStep[];
  /** Archived completed runs for this session (newest first) */
  history: CompletedRunRecord[];
}

export interface HudSnapshotResponse {
  status: SessionLiveStatus | null;
  config: Pick<
    LiveHudConfig,
    | 'locale'
    | 'persona'
    | 'showThoughtChain'
    | 'hideWhenIdle'
    | 'idleAutoMinimizeMs'
    | 'stallThresholdMs'
    | 'defaultPosition'
    | 'bubbleTheme'
    | 'whaleAdapter'
  >;
  serverNow: number;
}
