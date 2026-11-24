import React from 'react';
import type { ActivityPhase } from '../types.ts';

export interface DefaultMiniCompanionProps {
  phase: ActivityPhase;
  side: 'left' | 'right';
  onToggleSide: () => void;
}

/**
 * Built-in adorable mini whale-spirit companion ("小鲸灵").
 * Shown automatically ONLY when the user has not installed any third-party
 * mascot/pet widget (like DeepSeek-Balance-Whale-Widget or dsh-pet).
 */
export const DefaultMiniCompanion: React.FC<DefaultMiniCompanionProps> = ({
  phase,
  side,
  onToggleSide,
}) => {
  const isWorking = phase === 'thinking' || phase === 'running_tool' || phase === 'streaming';
  const isAlert = phase === 'waiting_approval' || phase === 'error';
  const isDone = phase === 'done';

  return (
    <div
      data-dsh-live-status-hud="companion"
      style={{
        position: 'fixed',
        bottom: 16,
        ...(side === 'left' ? { left: 18 } : { right: 18 }),
        zIndex: 10000,
        pointerEvents: 'auto',
      }}
    >
      <style>{`
        @keyframes dshMiniFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes dshMiniWork {
          0%, 100% { transform: translateY(0px) scale(1); }
          50% { transform: translateY(-5px) scale(1.04, 0.96); }
        }
        @media (prefers-reduced-motion: reduce) {
          .dsh-mini-mascot-svg { animation: none !important; }
        }
      `}</style>
      <button
        type="button"
        onClick={onToggleSide}
        title="小鲸灵（点击切换左下/右下角）"
        aria-label="小鲸灵状态挂件，点击切换停靠边"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          display: 'block',
          transform: side === 'left' ? 'scaleX(-1)' : undefined,
        }}
      >
        <svg
          className="dsh-mini-mascot-svg"
          width="66"
          height="62"
          viewBox="0 0 66 62"
          fill="none"
          style={{
            filter: 'drop-shadow(0 6px 12px rgba(32, 49, 112, 0.24))',
            animation: isWorking
              ? 'dshMiniWork 1.1s ease-in-out infinite'
              : 'dshMiniFloat 2.8s ease-in-out infinite',
          }}
        >
          {/* Tail fin */}
          <path
            d="M54 35 C61 31, 64 25, 62 21 C59 24, 56 26, 53 28 C57 29, 61 33, 63 38 C59 39, 55 38, 52 36 Z"
            fill="#60a5fa"
            stroke="#203170"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          {/* Chubby whale body */}
          <path
            d="M10 34 C10 19, 22 11, 35 12 C48 13, 55 22, 55 34 C55 46, 46 53, 32 53 C18 53, 10 46, 10 34 Z"
            fill={isAlert ? '#fed7aa' : '#93c5fd'}
            stroke="#203170"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
          {/* Belly highlight */}
          <path
            d="M15 41 C20 48, 36 50, 46 44 C38 45, 24 44, 15 41 Z"
            fill="#eff6ff"
          />
          {/* Little water spout / spark on top when working */}
          {isWorking && (
            <path
              d="M32 10 C32 5, 27 3, 25 6 M32 10 C32 5, 37 3, 39 6"
              stroke="#38bdf8"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          )}
          {/* Rosy cheeks */}
          <ellipse cx="18" cy="36" rx="3.4" ry="2" fill="#fda4af" opacity="0.85" />
          <ellipse cx="42" cy="36" rx="3.4" ry="2" fill="#fda4af" opacity="0.85" />

          {/* Expressive eyes */}
          {isDone ? (
            <>
              <path d="M21 31 Q24 27 27 31" stroke="#203170" strokeWidth="2.4" strokeLinecap="round" fill="none" />
              <path d="M33 31 Q36 27 39 31" stroke="#203170" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            </>
          ) : phase === 'error' ? (
            <>
              <path d="M21 28 L26 33 M26 28 L21 33" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M34 28 L39 33 M39 28 L34 33" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle cx="24" cy="30" r="3" fill="#203170" />
              <circle cx="23" cy="29" r="1" fill="#ffffff" />
              <circle cx="36" cy="30" r="3" fill="#203170" />
              <circle cx="35" cy="29" r="1" fill="#ffffff" />
            </>
          )}

          {/* Tiny cute smile */}
          <path
            d={isAlert ? 'M28 36 Q30 34 32 36' : 'M27 35 Q30 38 33 35'}
            stroke="#203170"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
};
