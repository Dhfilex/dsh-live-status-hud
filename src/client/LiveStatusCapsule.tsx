import React, { useEffect, useMemo, useState } from 'react';
import type { ActivityPhase, HudPosition, SessionLiveStatus } from '../types.ts';

export interface LiveStatusCapsuleProps {
  status: SessionLiveStatus | null;
  defaultPosition?: HudPosition;
}

const STORAGE_KEY_POS = 'dsh-live-status-hud:position';
const STORAGE_KEY_MINI = 'dsh-live-status-hud:minimized';

const PHASE_COLORS: Record<ActivityPhase, { dot: string; badgeBg: string; badgeText: string; tagZh: string }> = {
  idle: { dot: '#94a3b8', badgeBg: 'rgba(148,163,184,0.16)', badgeText: '#cbd5e1', tagZh: '待命' },
  thinking: { dot: '#38bdf8', badgeBg: 'rgba(56,189,248,0.18)', badgeText: '#7dd3fc', tagZh: '思考中' },
  running_tool: { dot: '#f59e0b', badgeBg: 'rgba(245,158,11,0.20)', badgeText: '#fcd34d', tagZh: '执行工具' },
  waiting_approval: { dot: '#fb923c', badgeBg: 'rgba(251,146,60,0.24)', badgeText: '#fdba74', tagZh: '待审批' },
  streaming: { dot: '#34d399', badgeBg: 'rgba(52,211,153,0.18)', badgeText: '#6ee7b7', tagZh: '输出中' },
  done: { dot: '#22c55e', badgeBg: 'rgba(34,197,94,0.18)', badgeText: '#86efac', tagZh: '已完成' },
  error: { dot: '#f87171', badgeBg: 'rgba(248,113,113,0.22)', badgeText: '#fca5a5', tagZh: '异常' },
};

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function readStorage(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export const LiveStatusCapsule: React.FC<LiveStatusCapsuleProps> = ({
  status,
  defaultPosition = 'top-right',
}) => {
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState<boolean>(() => readStorage(STORAGE_KEY_MINI, '0') === '1');
  const [position, setPosition] = useState<HudPosition>(() => {
    const saved = readStorage(STORAGE_KEY_POS, defaultPosition);
    return saved === 'bottom-right' ? 'bottom-right' : 'top-right';
  });
  const [now, setNow] = useState<number>(() => Date.now());

  const isActive =
    status !== null &&
    (status.phase === 'thinking' ||
      status.phase === 'running_tool' ||
      status.phase === 'waiting_approval' ||
      status.phase === 'streaming');

  // Tick elapsed timer smoothly while active
  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const togglePosition = () => {
    const next: HudPosition = position === 'top-right' ? 'bottom-right' : 'top-right';
    setPosition(next);
    try {
      window.localStorage.setItem(STORAGE_KEY_POS, next);
    } catch {
      // Ignore storage quota errors
    }
  };

  const toggleMinimized = () => {
    const next = !minimized;
    setMinimized(next);
    if (next) setExpanded(false);
    try {
      window.localStorage.setItem(STORAGE_KEY_MINI, next ? '1' : '0');
    } catch {
      // Ignore storage quota errors
    }
  };

  const theme = useMemo(() => {
    return PHASE_COLORS[status?.phase ?? 'idle'];
  }, [status?.phase]);

  if (!status || (status.phase === 'idle' && status.recentSteps.length === 0)) {
    return null;
  }

  const elapsedMs = status.turnStartedAt ? Math.max(0, (isActive ? now : status.updatedAt) - status.turnStartedAt) : 0;
  const anchorStyle: React.CSSProperties =
    position === 'top-right'
      ? { top: 14, right: 18 }
      : { bottom: 18, right: 18 };

  return (
    <div
      style={{
        position: 'fixed',
        ...anchorStyle,
        zIndex: 90,
        pointerEvents: 'none',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
      aria-live="polite"
    >
      <style>{`
        @keyframes dshHudPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.35); opacity: 0.55; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dsh-hud-dot-active { animation: none !important; }
        }
      `}</style>

      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        {/* Main Floating Capsule */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: minimized ? '6px 10px' : '8px 12px',
            borderRadius: 999,
            background: 'rgba(15, 23, 42, 0.88)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: status.isStalled
              ? '1px solid rgba(251, 146, 60, 0.7)'
              : '1px solid rgba(148, 163, 184, 0.25)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
            color: '#f8fafc',
            fontSize: 13,
            lineHeight: 1.2,
            maxWidth: minimized ? 120 : 420,
            userSelect: 'none',
          }}
        >
          <span
            className={isActive ? 'dsh-hud-dot-active' : undefined}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: theme.dot,
              flexShrink: 0,
              animation: isActive ? 'dshHudPulse 1.6s ease-in-out infinite' : undefined,
            }}
          />

          {!minimized && (
            <>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 7px',
                  borderRadius: 999,
                  background: theme.badgeBg,
                  color: theme.badgeText,
                  flexShrink: 0,
                }}
              >
                {status.isStalled ? '耗时较长' : theme.tagZh}
              </span>

              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                aria-label="展开或收起实时执行步骤"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#f8fafc',
                  cursor: 'pointer',
                  padding: 0,
                  textAlign: 'left',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 210,
                  fontSize: 13,
                  fontWeight: 500,
                }}
                title={status.detail ? `${status.headline}\n${status.detail}` : status.headline}
              >
                {status.headline}
              </button>

              <span
                style={{
                  fontSize: 11,
                  color: '#94a3b8',
                  fontVariantNumeric: 'tabular-nums',
                  flexShrink: 0,
                }}
              >
                第{Math.max(1, status.stepCount)}步 · {formatDuration(elapsedMs)}
              </span>
            </>
          )}

          <button
            type="button"
            onClick={toggleMinimized}
            aria-label={minimized ? '展开状态胶囊' : '最小化状态胶囊'}
            title={minimized ? '展开' : '收起为小点'}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {minimized ? '展开' : '—'}
          </button>
        </div>

        {/* Expandable Recent Steps Popover */}
        {expanded && !minimized && (
          <div
            style={{
              width: 340,
              borderRadius: 14,
              background: 'rgba(15, 23, 42, 0.94)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(148, 163, 184, 0.24)',
              boxShadow: '0 14px 32px rgba(0, 0, 0, 0.35)',
              color: '#e2e8f0',
              padding: 12,
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
                paddingBottom: 6,
                borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
              }}
            >
              <span style={{ fontWeight: 600, color: '#f8fafc' }}>
                最近执行轨迹（{status.recentSteps.length}）
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={togglePosition}
                  style={{
                    background: 'rgba(148, 163, 184, 0.14)',
                    border: 'none',
                    borderRadius: 6,
                    color: '#cbd5e1',
                    padding: '2px 7px',
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  {position === 'top-right' ? '移至右下' : '移至右上'}
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {status.recentSteps.length === 0 ? (
              <div style={{ color: '#94a3b8', padding: '6px 0' }}>
                当前尚未触发工具调用，模型正在纯文本思考或输出。
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...status.recentSteps].reverse().map((step) => {
                  const stepMs = (step.endedAt ?? now) - step.startedAt;
                  const icon =
                    step.status === 'running' ? '●' : step.status === 'failed' ? '✕' : '✓';
                  const iconColor =
                    step.status === 'running' ? '#f59e0b' : step.status === 'failed' ? '#f87171' : '#4ade80';
                  return (
                    <li
                      key={step.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 8,
                        background:
                          step.status === 'running'
                            ? 'rgba(245, 158, 11, 0.10)'
                            : 'rgba(30, 41, 59, 0.65)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
                        <span style={{ color: iconColor, fontSize: 11, marginTop: 1 }}>{icon}</span>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              color: '#f1f5f9',
                              fontWeight: 500,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 230,
                            }}
                          >
                            {step.label}
                          </div>
                          {step.detail && (
                            <div
                              style={{
                                color: '#94a3b8',
                                fontSize: 11,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: 230,
                              }}
                            >
                              {step.detail}
                            </div>
                          )}
                        </div>
                      </div>
                      <span
                        style={{
                          color: '#94a3b8',
                          fontSize: 11,
                          fontVariantNumeric: 'tabular-nums',
                          flexShrink: 0,
                        }}
                      >
                        {formatDuration(stepMs)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
