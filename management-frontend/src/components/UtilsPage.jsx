import React, { useState } from 'react';
import ColorDotShowcase from './ColorDotShowcase';

function UtilsPage() {
  const [activeTab, setActiveTab] = useState('colordot');

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Utilities</div>
        <div className="actions">
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`btn ${activeTab === 'colordot' ? 'primary' : ''}`}
              onClick={() => setActiveTab('colordot')}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: activeTab === 'colordot' ? 'var(--primary)' : 'transparent',
                color: activeTab === 'colordot' ? '#fff' : 'var(--text)',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '13px',
              }}
            >
              ColorDot
            </button>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px' }}>
        {activeTab === 'colordot' && (
          <>
            <div style={{ marginBottom: '24px' }}>
              <h2 style={{ marginTop: 0, marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>
                ColorDot Component
              </h2>
              <p style={{ color: 'var(--muted)', fontSize: '14px', marginBottom: '8px' }}>
                A versatile, glowing color dot component seeded from any string ID. Used throughout the management console to visually distinguish entities like agents, tasks, API keys, and more.
              </p>
              <div style={{ background: 'var(--code-bg)', padding: '12px', borderRadius: '6px', fontSize: '12px', fontFamily: 'monospace', overflow: 'auto' }}>
                <div style={{ color: 'var(--muted)', marginBottom: '8px' }}>Basic Usage:</div>
                <code style={{ color: 'var(--text)' }}>
                  {`import ColorDot from './ColorDot';\n\n// Default circle\n<ColorDot seed="agent-123" />\n\n// Custom variant and size\n<ColorDot seed="task-456" variant="diamond" size={14} />`}
                </code>
              </div>
            </div>

            <ColorDotShowcase />

            <div style={{ marginTop: '32px', padding: '16px', background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>
                Props Reference
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '12px', fontSize: '12px' }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '4px' }}>seed (required)</div>
                  <div style={{ color: 'var(--muted)' }}>String ID to derive color from (e.g., agent UID, task ID)</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '4px' }}>variant</div>
                  <div style={{ color: 'var(--muted)' }}>Visual style: 'circle' (default), 'square', or any Lucide icon name</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '4px' }}>size</div>
                  <div style={{ color: 'var(--muted)' }}>Dot size in pixels (default: 12)</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '4px' }}>title</div>
                  <div style={{ color: 'var(--muted)' }}>Tooltip text (falls back to seed)</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '4px' }}>style</div>
                  <div style={{ color: 'var(--muted)' }}>Additional inline CSS styles</div>
                </div>
              </div>
            </div>

            <div style={{ marginTop: '24px', padding: '16px', background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>
                Features
              </h3>
              <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px', color: 'var(--muted)', lineHeight: '1.8' }}>
                <li><strong style={{ color: 'var(--text)' }}>Deterministic Colors:</strong> Same seed always produces the same color</li>
                <li><strong style={{ color: 'var(--text)' }}>Glowing Effect:</strong> All variants use box-shadow or filter for glow</li>
                <li><strong style={{ color: 'var(--text)' }}>Pulse Animation:</strong> Subtle 2s opacity pulse on all styles</li>
                <li><strong style={{ color: 'var(--text)' }}>Vibrant Colors:</strong> 65% saturation ensures great visibility</li>
                <li><strong style={{ color: 'var(--text)' }}>Icon Support:</strong> 9 Lucide icons with automatic sizing</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default UtilsPage;
