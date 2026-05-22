import React from 'react';

/**
 * Inline rescale controls for optional input-image pre-processing.
 *
 * Props (all controlled):
 *   enabled          boolean
 *   onEnabledChange  (boolean) => void
 *   mode             'exact' | 'max'
 *   onModeChange     (string) => void
 *   width            number          — exact mode
 *   onWidthChange    (number) => void
 *   height           number          — exact mode
 *   onHeightChange   (number) => void
 *   px               number | ''     — max mode: max pixels per side ('' = unset)
 *   onPxChange       (number | '') => void
 *   mp               number | ''     — max mode: max megapixels total ('' = unset)
 *   onMpChange       (number | '') => void
 *   label            string          — optional, default "Rescale input images"
 *
 * Helper exported from this module:
 *   rescaleDataPrep(enabled, { mode, width, height, px, mp })
 *     → { '*': action } | null
 */

const RescaleWidget = ({
    enabled,
    onEnabledChange,
    mode,
    onModeChange,
    width,
    onWidthChange,
    height,
    onHeightChange,
    px,
    onPxChange,
    mp,
    onMpChange,
    label = 'Rescale input images',
}) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <label style={checkLabel}>
            <input
                type="checkbox"
                checked={enabled}
                onChange={e => onEnabledChange(e.target.checked)}
            />
            {label}
        </label>
        {enabled && (
            <>
                <select value={mode} onChange={e => onModeChange(e.target.value)} style={modeSelect}>
                    <option value="exact">exact</option>
                    <option value="max">max</option>
                </select>
                {mode === 'exact' ? (
                    <>
                        <input
                            type="number" value={width}
                            onChange={e => onWidthChange(Number(e.target.value))}
                            style={numInput} aria-label="Rescale width"
                        />
                        <span style={sep}>×</span>
                        <input
                            type="number" value={height}
                            onChange={e => onHeightChange(Number(e.target.value))}
                            style={numInput} aria-label="Rescale height"
                        />
                    </>
                ) : (
                    <>
                        <span style={fieldLabel}>px</span>
                        <input
                            type="number" value={px}
                            onChange={e => onPxChange(e.target.value === '' ? '' : Number(e.target.value))}
                            placeholder="—" style={numInput} aria-label="Max pixels per side"
                        />
                        <span style={fieldLabel}>mp</span>
                        <input
                            type="number" value={mp} step="0.5"
                            onChange={e => onMpChange(e.target.value === '' ? '' : Number(e.target.value))}
                            placeholder="—" style={numInput} aria-label="Max megapixels"
                        />
                    </>
                )}
            </>
        )}
    </div>
);

export function rescaleDataPrep(enabled, { mode, width, height, px, mp } = {}) {
    if (!enabled) return null;
    if (mode === 'max') {
        const parts = [];
        if (px !== '' && px != null) parts.push(`px=${px}`);
        if (mp !== '' && mp != null) parts.push(`mp=${mp}`);
        if (!parts.length) return null;
        return { '*': `scale/max[${parts.join(',')}]` };
    }
    return { '*': `scale/${width}x${height}` };
}

const checkLabel = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--muted)',
    userSelect: 'none',
};

const modeSelect = {
    padding: '5px 6px',
    fontSize: '12px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--input-bg)',
    color: 'var(--muted)',
    outline: 'none',
    cursor: 'pointer',
};

const numInput = {
    width: '72px',
    padding: '6px 8px',
    fontSize: '13px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    outline: 'none',
    boxSizing: 'border-box',
};

const sep = { color: 'var(--muted)', fontSize: '13px' };
const fieldLabel = { color: 'var(--muted)', fontSize: '12px', fontWeight: 500 };

export default RescaleWidget;
