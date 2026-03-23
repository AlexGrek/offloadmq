/**
 * ColorDot Showcase — Visual reference for all available ColorDot variants
 *
 * Usage in components:
 *
 *   import ColorDot from './ColorDot';
 *
 *   // Circle (default)
 *   <ColorDot seed="agent-123" />
 *   <ColorDot seed="agent-123" variant="circle" />
 *
 *   // Square
 *   <ColorDot seed="task-456" variant="square" />
 *
 *   // Lucide icon variants
 *   <ColorDot seed="user-789" variant="asterisk" />
 *   <ColorDot seed="user-789" variant="bookmark" />
 *   <ColorDot seed="user-789" variant="chevrons-right" />
 *   <ColorDot seed="user-789" variant="circle-dashed" />
 *   <ColorDot seed="user-789" variant="diamond" />
 *   <ColorDot seed="user-789" variant="flag-triangle-right" />
 *   <ColorDot seed="user-789" variant="fish-symbol" />
 *   <ColorDot seed="user-789" variant="laptop-minimal" />
 *   <ColorDot seed="user-789" variant="rectangle-horizontal" />
 *
 *   // Custom size
 *   <ColorDot seed="item-id" size={16} />
 *
 *   // With tooltip
 *   <ColorDot seed="item-id" title="Hover over me!" />
 */

import React from 'react';
import ColorDot from './ColorDot';

const VARIANTS = [
  { name: 'circle', label: 'Circle (Default)' },
  { name: 'square', label: 'Square' },
  { name: 'asterisk', label: 'Asterisk' },
  { name: 'bookmark', label: 'Bookmark' },
  { name: 'chevrons-right', label: 'Chevrons Right' },
  { name: 'circle-dashed', label: 'Circle Dashed' },
  { name: 'diamond', label: 'Diamond' },
  { name: 'flag-triangle-right', label: 'Flag Triangle' },
  { name: 'fish-symbol', label: 'Fish Symbol' },
  { name: 'laptop-minimal', label: 'Laptop' },
  { name: 'rectangle-horizontal', label: 'Rectangle' },
];

function ColorDotShowcase() {
  const demoSeeds = [
    'agent-01',
    'task-99',
    'user-id-xyz',
    'api-key-secret',
    'workflow-name',
  ];

  return (
    <div style={{ padding: '24px', background: 'var(--glass)', borderRadius: '12px' }}>
      <h2 style={{ marginTop: 0, marginBottom: '24px', fontSize: '18px', fontWeight: 600 }}>
        ColorDot Variants Showcase
      </h2>

      {demoSeeds.map((seed) => (
        <div key={seed} style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', marginBottom: '12px', textTransform: 'uppercase' }}>
            Seed: {seed}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' }}>
            {VARIANTS.map(({ name, label }) => (
              <div
                key={`${seed}-${name}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '10px',
                  background: 'var(--input-bg)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              >
                <ColorDot seed={seed} variant={name} size={14} title={`${label}\nSeed: ${seed}`} />
                <span style={{ color: 'var(--text)' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ marginTop: '32px', padding: '12px', background: 'var(--code-bg)', borderRadius: '8px', fontSize: '12px', fontFamily: 'monospace' }}>
        <div style={{ color: 'var(--muted)', marginBottom: '8px' }}>Available variants:</div>
        <div style={{ color: 'var(--text)' }}>
          circle | square | asterisk | bookmark | chevrons-right | circle-dashed | diamond | flag-triangle-right | fish-symbol | laptop-minimal | rectangle-horizontal
        </div>
      </div>
    </div>
  );
}

export default ColorDotShowcase;
