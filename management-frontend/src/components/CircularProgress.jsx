import { useState, useEffect } from 'react';

/**
 * Circular progress ring for task polling.
 *
 * When both typicalRuntimeSeconds and createdAt are provided, renders a
 * determinate arc that fills over the estimated duration (orange when overrun).
 * Otherwise renders an indeterminate spinning arc.
 *
 * Props:
 *   typicalRuntimeSeconds  – estimated duration in seconds (number) or null
 *   createdAt              – ISO timestamp of task creation (string) or null
 *   size                   – diameter in px (default 36)
 *   strokeWidth            – ring thickness in px (default 3.5)
 *   color                  – arc color hex/rgb (default '#3b82f6')
 */
const CircularProgress = ({
  typicalRuntimeSeconds = null,
  createdAt = null,
  size = 36,
  strokeWidth = 3.5,
  color = '#3b82f6',
}) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  const isDeterminate = typicalRuntimeSeconds != null && createdAt != null;

  if (isDeterminate) {
    const elapsed = (now - new Date(createdAt).getTime()) / 1000;
    const rawProgress = elapsed / typicalRuntimeSeconds;
    const clampedProgress = Math.min(rawProgress, 1);
    const dashOffset = circumference * (1 - clampedProgress);
    const overrun = rawProgress > 1;
    const arcColor = overrun ? '#f59e0b' : color;
    const displayPct = Math.min(Math.round(rawProgress * 100), 99);
    const fontSize = Math.max(Math.round(size * 0.26), 8);

    return (
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke="var(--border, #e5e7eb)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={arcColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.5s linear' }}
          />
        </svg>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize,
          fontWeight: 700,
          color: arcColor,
          lineHeight: 1,
          userSelect: 'none',
        }}>
          {displayPct}
        </div>
      </div>
    );
  }

  // Indeterminate: spinning arc
  const dashLen = circumference * 0.28;

  return (
    <>
      <style>{`@keyframes cp-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{
        width: size,
        height: size,
        flexShrink: 0,
        animation: 'cp-spin 1s linear infinite',
        transformOrigin: '50% 50%',
      }}>
        <svg width={size} height={size} style={{ display: 'block' }}>
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke="var(--border, #e5e7eb)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${dashLen} ${circumference - dashLen}`}
            strokeLinecap="round"
          />
        </svg>
      </div>
    </>
  );
};

export default CircularProgress;
