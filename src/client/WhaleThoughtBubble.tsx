import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityPhase,
  CompletedRunRecord,
  SessionLiveStatus,
  WhaleConflictStrategy,
} from '../types.ts';
import type { WhaleAnchorState } from './whaleAnchor.ts';

export interface WhaleThoughtBubbleProps {
  status: SessionLiveStatus | null;
  /** Live session running hint from DSH's useSessions() so auto-minimize works even if a turn/end event is missed */
  isSessionRunning?: boolean;
  anchor: WhaleAnchorState;
  fallbackSide?: 'left' | 'right';
  conflictStrategy?: WhaleConflictStrategy;
  showThoughtChain?: boolean;
  hideWhenIdle?: boolean;
  idleAutoMinimizeMs?: number;
  onClearHistory?: () => void;
}

const PHASE_META: Record<ActivityPhase, { badge: string; accent: string; bg: string }> = {
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

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatClock(ts: number): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

export const WhaleThoughtBubble: React.FC<WhaleThoughtBubbleProps> = ({
  status,
  isSessionRunning = false,
  anchor,
  fallbackSide = 'right',
  conflictStrategy = 'stack',
  showThoughtChain = true,
  hideWhenIdle = false,
  idleAutoMinimizeMs = 12_000,
  onClearHistory,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'thought' | 'steps' | 'history'>('thought');
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [showRawEnglish, setShowRawEnglish] = useState(false);
  const [muted, setMuted] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [idleIndex, setIdleIndex] = useState(0);
  const prevActiveRef = useRef<boolean>(false);

  const effectiveStatus: SessionLiveStatus = useMemo(() => {
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

  // Auto-open immediately when a new task starts
  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      setMuted(false);
    }
    prevActiveRef.current = isActive;
  }, [isActive]);

  // Auto-minimize both the expanded drawer and main bubble when idle/done and mouse is not hovering
  useEffect(() => {
    if (idleAutoMinimizeMs <= 0) return;
    if (isActive || muted || isHovering) return;

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
    const timer = window.setInterval(() => {
      setIdleIndex((i) => (i + 1) % IDLE_GREETINGS.length);
    }, 18_000);
    return () => window.clearInterval(timer);
  }, [isIdle, muted]);

  const meta = useMemo(() => PHASE_META[effectiveStatus.phase], [effectiveStatus.phase]);

  if (
    hideWhenIdle &&
    isIdle &&
    effectiveStatus.recentSteps.length === 0 &&
    effectiveStatus.history.length === 0 &&
    !effectiveStatus.thoughtSnippet
  ) {
    return null;
  }

  if (conflictStrategy === 'yield' && anchor.widgetBubbleRect) {
    return null;
  }

  const elapsedMs = effectiveStatus.turnStartedAt
    ? Math.max(0, (isActive ? now : effectiveStatus.updatedAt) - effectiveStatus.turnStartedAt)
    : 0;

  const bubbleWidth = 276;
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 720;

  const isLeft = anchor.found ? anchor.isLeftFlipped : fallbackSide === 'left';
  let left = isLeft ? 18 : viewportW - bubbleWidth - 18;
  let bottom = 80;
  let dodgingWidgetBubble = false;

  if (anchor.found && anchor.avatarRect) {
    const avatar = anchor.avatarRect;
    const widgetBubble = anchor.widgetBubbleRect;

    if (widgetBubble) {
      dodgingWidgetBubble = true;
      const spaceAbove = widgetBubble.top;
      if (spaceAbove >= 145) {
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
      const idealLeft = isLeft
        ? avatar.left + avatar.width * 0.08
        : avatar.right - bubbleWidth - avatar.width * 0.06;
      left = Math.min(Math.max(12, idealLeft), viewportW - bubbleWidth - 12);
      bottom = Math.min(Math.max(18, viewportH - avatar.top + 4), viewportH - 130);
    }
  }

  const displayHeadline =
    isIdle && (!status || status.headline === '悠闲吐泡泡待命中~' || status.headline === '安安静静陪着你呢~')
      ? IDLE_GREETINGS[idleIndex % IDLE_GREETINGS.length]
      : effectiveStatus.headline;

  const displayThoughtSnippet = effectiveStatus.thoughtSnippetZh || effectiveStatus.thoughtSnippet;
  const displayThoughtBody = showRawEnglish
    ? effectiveStatus.thoughtBuffer
    : effectiveStatus.thoughtBufferZh || effectiveStatus.thoughtBuffer;

  const historyList: CompletedRunRecord[] = effectiveStatus.history ?? [];
  const badgeCount =
    effectiveStatus.recentSteps.length > 0
      ? effectiveStatus.recentSteps.length
      : historyList.length;

  // Minimized cute 💭 round badge pinned neatly near the mascot's head
  if (muted) {
    const iconLeft = isLeft
      ? Math.max(14, left + 8)
      : Math.min(viewportW - 48, left + bubbleWidth - 38);
    return (
      <button
        type="button"
        data-dsh-live-status-hud="muted"
        onClick={() => { setIsHovering(false); setMuted(false); }}
        title={
          historyList.length > 0 || effectiveStatus.recentSteps.length > 0
            ? '点我展开查看思考链、干活记录与历史~'
            : '点我展开小鲸鱼状态气泡~'
        }
        style={{
          position: 'fixed',
          left: iconLeft,
          bottom,
          zIndex: 10002,
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
          transition: 'left 220ms ease, bottom 220ms ease',
        }}
      >
        💭
        {badgeCount > 0 && (
          <span
            style={{
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
            }}
          >
            {badgeCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      data-dsh-live-status-hud="bubble"
      style={{
        position: 'fixed',
        left,
        bottom,
        width: bubbleWidth,
        zIndex: 10002,
        pointerEvents: 'none',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        transition: 'left 220ms cubic-bezier(.22,1,.36,1), bottom 220ms cubic-bezier(.22,1,.36,1)',
      }}
      aria-live="polite"
    >
      <style>{`
        @keyframes dshWhaleDotPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.32); opacity: 0.5; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dsh-whale-dot { animation: none !important; }
        }
      `}</style>

      <div
        style={{ pointerEvents: 'auto', position: 'relative' }}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {expanded && (
          <div
            style={{
              marginBottom: 8,
              borderRadius: 18,
              background: '#ffffff',
              border: '2.5px solid #203170',
              boxShadow: '0 10px 26px rgba(32, 49, 112, 0.2)',
              padding: '10px 12px',
              color: '#334155',
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
                paddingBottom: 6,
                borderBottom: '1px dashed rgba(32, 49, 112, 0.2)',
              }}
            >
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {showThoughtChain && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('thought')}
                    style={{
                      background: activeTab === 'thought' ? '#eff6ff' : 'transparent',
                      color: activeTab === 'thought' ? '#203170' : '#64748b',
                      border: activeTab === 'thought' ? '1px solid #bfdbfe' : '1px solid transparent',
                      borderRadius: 999,
                      padding: '2px 7px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    🧠 思考链
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab('steps')}
                  style={{
                    background: activeTab === 'steps' ? '#eff6ff' : 'transparent',
                    color: activeTab === 'steps' ? '#203170' : '#64748b',
                    border: activeTab === 'steps' ? '1px solid #bfdbfe' : '1px solid transparent',
                    borderRadius: 999,
                    padding: '2px 7px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  🛠️ 干活 ({effectiveStatus.recentSteps.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('history')}
                  style={{
                    background: activeTab === 'history' ? '#eff6ff' : 'transparent',
                    color: activeTab === 'history' ? '#203170' : '#64748b',
                    border: activeTab === 'history' ? '1px solid #bfdbfe' : '1px solid transparent',
                    borderRadius: 999,
                    padding: '2px 7px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  📜 历史 ({historyList.length})
                </button>
              </div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            </div>

            {activeTab === 'thought' && showThoughtChain ? (
              <div>
                <div
                  style={{
                    maxHeight: 150,
                    overflowY: 'auto',
                    background: '#f8fafc',
                    borderRadius: 10,
                    padding: '8px 10px',
                    fontSize: 11.5,
                    lineHeight: 1.55,
                    color: '#334155',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {displayThoughtBody
                    ? displayThoughtBody
                    : '现在正悠闲待命呢，等发新任务我就把模型的思考过程翻译成中文直播给你看~'}
                </div>
                {effectiveStatus.thoughtBuffer &&
                  effectiveStatus.thoughtBufferZh &&
                  effectiveStatus.thoughtBuffer !== effectiveStatus.thoughtBufferZh && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 5 }}>
                      <button
                        type="button"
                        onClick={() => setShowRawEnglish((v) => !v)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#64748b',
                          fontSize: 10.5,
                          cursor: 'pointer',
                          padding: 0,
                          textDecoration: 'underline',
                        }}
                      >
                        {showRawEnglish ? '切回可爱中文版' : '偷看英文原文'}
                      </button>
                    </div>
                  )}
              </div>
            ) : activeTab === 'steps' ? (
              effectiveStatus.recentSteps.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: 11 }}>
                  本轮还没有工具调用记录（可点右侧「📜 历史」查看之前完成的任务）。
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                    maxHeight: 160,
                    overflowY: 'auto',
                  }}
                >
                  {[...effectiveStatus.recentSteps].reverse().map((step) => {
                    const stepMs = (step.endedAt ?? now) - step.startedAt;
                    const mark =
                      step.status === 'running' ? '●' : step.status === 'failed' ? '✕' : '✓';
                    const markColor =
                      step.status === 'running'
                        ? '#d97706'
                        : step.status === 'failed'
                          ? '#dc2626'
                          : '#16a34a';
                    return (
                      <li
                        key={step.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 6,
                          fontSize: 11,
                          alignItems: 'center',
                        }}
                      >
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: '#1e293b',
                          }}
                          title={step.detail || step.label}
                        >
                          <span style={{ color: markColor, marginRight: 4 }}>{mark}</span>
                          {step.label}
                        </span>
                        <span style={{ color: '#64748b', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                          {formatDuration(stepMs)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : (
              <div>
                {historyList.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: 11 }}>
                    还没有已归档的历史任务，跑完一轮任务就会自动存在这里（刷新页面也不丢哦~）。
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 170, overflowY: 'auto' }}>
                    {historyList.map((run) => {
                      const isOpen = expandedHistoryId === run.id;
                      return (
                        <div
                          key={run.id}
                          style={{
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 10,
                            padding: '6px 8px',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedHistoryId(isOpen ? null : run.id)}
                            style={{
                              width: '100%',
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              textAlign: 'left',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11.5,
                                fontWeight: 700,
                                color: '#203170',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {run.outcome === 'error' ? '😵 ' : '✨ '}
                              {run.headline}
                            </span>
                            <span style={{ fontSize: 10.5, color: '#64748b', flexShrink: 0 }}>
                              {formatClock(run.finishedAt)} · {run.steps.length}步
                            </span>
                          </button>

                          {isOpen && (
                            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #cbd5e1' }}>
                              {run.thoughtBufferZh && (
                                <div style={{ fontSize: 11, color: '#475569', marginBottom: 5, whiteSpace: 'pre-wrap' }}>
                                  🧠 {run.thoughtBufferZh}
                                </div>
                              )}
                              {run.steps.map((s) => (
                                <div key={s.id} style={{ fontSize: 10.5, color: '#334155', marginTop: 2 }}>
                                  {s.status === 'failed' ? '✕ ' : '✓ '}
                                  {s.label}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {historyList.length > 0 && onClearHistory && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                    <button
                      type="button"
                      onClick={onClearHistory}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#94a3b8',
                        fontSize: 10.5,
                        cursor: 'pointer',
                        padding: 0,
                        textDecoration: 'underline',
                      }}
                    >
                      清空本会话历史
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Main Comic Thought Bubble */}
        <div
          style={{
            position: 'relative',
            background: '#ffffff',
            border: `3px solid ${effectiveStatus.isStalled ? '#ea580c' : '#203170'}`,
            borderRadius: '26px',
            padding: '10px 14px 11px',
            boxShadow: '0 8px 20px rgba(32, 49, 112, 0.18)',
            color: '#203170',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              marginBottom: 4,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 999,
                background: meta.bg,
                color: meta.accent,
              }}
            >
              <span
                className={isActive ? 'dsh-whale-dot' : undefined}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: meta.accent,
                  animation: isActive ? 'dshWhaleDotPulse 1.5s ease-in-out infinite' : undefined,
                }}
              />
              {effectiveStatus.isStalled ? '🐢 有点硬核' : meta.badge}
            </span>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {(!isIdle || effectiveStatus.stepCount > 0) && (
                <span
                  style={{
                    fontSize: 11,
                    color: '#536ba9',
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  第{Math.max(1, effectiveStatus.stepCount)}步 · {formatDuration(elapsedMs)}
                </span>
              )}
              <button
                type="button"
                onClick={() => setMuted(true)}
                aria-label="收起状态气泡"
                title="收起为 💭 小圆标"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                —
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              width: '100%',
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              color: '#203170',
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1.4,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={effectiveStatus.detail ? `${displayHeadline}\n${effectiveStatus.detail}` : displayHeadline}
          >
            {displayHeadline}
          </button>

          {showThoughtChain && displayThoughtSnippet && (
            <button
              type="button"
              onClick={() => {
                setActiveTab('thought');
                setExpanded(true);
              }}
              style={{
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
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              title="点击展开完整中文思考链"
            >
              💭 {displayThoughtSnippet}
            </button>
          )}

          {!displayThoughtSnippet && effectiveStatus.detail && (
            <div
              style={{
                marginTop: 3,
                fontSize: 11,
                color: '#536ba9',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {effectiveStatus.detail}
            </div>
          )}
        </div>

        {!dodgingWidgetBubble && (
          <div style={{ position: 'relative', height: 18, pointerEvents: 'none' }}>
            <span
              style={{
                position: 'absolute',
                top: 2,
                ...(isLeft ? { left: 42 } : { right: 42 }),
                width: 12,
                height: 9,
                borderRadius: '50%',
                background: '#ffffff',
                border: `2.5px solid ${effectiveStatus.isStalled ? '#ea580c' : '#203170'}`,
              }}
            />
            <span
              style={{
                position: 'absolute',
                top: 12,
                ...(isLeft ? { left: 30 } : { right: 30 }),
                width: 7,
                height: 6,
                borderRadius: '50%',
                background: '#ffffff',
                border: `2px solid ${effectiveStatus.isStalled ? '#ea580c' : '#203170'}`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
