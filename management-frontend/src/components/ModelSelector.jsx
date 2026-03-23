import React, { useState, useEffect, useRef } from 'react';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import AttributeTag from './AttributeTag';

/** Returns model size in billions, or null if not detectable. */
function parseModelSizeB(cap) {
  const attrs = parseCapabilityAttrs(cap);
  for (const attr of attrs) {
    // explicit "size:5Gb" / "size:1.5b"
    const sizeAttr = attr.match(/^size:(\d+(?:\.\d+)?)\s*([gmk])?b?$/i);
    if (sizeAttr) {
      const val = parseFloat(sizeAttr[1]);
      const unit = (sizeAttr[2] || 'g').toLowerCase();
      if (unit === 'g') return val;
      if (unit === 'm') return val / 1000;
      if (unit === 'k') return val / 1_000_000;
    }
    // plain size attr like "7b" or "1.5b"
    const plain = attr.match(/^(\d+(?:\.\d+)?)b$/i);
    if (plain) return parseFloat(plain[1]);
  }
  // fall back to model name: "qwen3:8b", "mistral-7b", etc.
  const base = stripCapabilityAttrs(cap);
  const nameSize = base.match(/[:-](\d+(?:\.\d+)?)b(?:\b|$)/i);
  if (nameSize) return parseFloat(nameSize[1]);
  return null;
}

function sortBySize(caps) {
  return [...caps].sort((a, b) => {
    const sa = parseModelSizeB(a);
    const sb = parseModelSizeB(b);
    if (sa === null && sb === null) return 0;
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sa - sb;
  });
}

const ModelSelector = ({ model, setModel, capabilities = [] }) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [dropdownOpen]);

  const isEmpty = capabilities.length === 0;
  const selectedCap = capabilities.find(cap => stripCapabilityAttrs(cap).replace(/^llm\./, '') === model);
  const selectedAttrs = selectedCap ? parseCapabilityAttrs(selectedCap) : [];

  return (
    <div style={styles.dropdownWrapper} ref={dropdownRef}>
      <button
        style={{
          ...styles.dropdownTrigger,
          borderColor: dropdownOpen ? 'var(--primary)' : 'var(--border)',
          ...(isEmpty ? styles.dropdownTriggerEmpty : {}),
        }}
        onClick={() => setDropdownOpen(!dropdownOpen)}
      >
        {isEmpty ? (
          <span style={styles.emptyTrigger}>
            <span style={styles.emptyDot} />
            <span>No agents online</span>
          </span>
        ) : (
          <span style={styles.triggerContent}>
            <span>{model}</span>
            {selectedAttrs.length > 0 && (
              <span style={styles.triggerAttrs}>
                {selectedAttrs.map(attr => <AttributeTag key={attr} attr={attr} inline={true} />)}
              </span>
            )}
          </span>
        )}
      </button>
      {dropdownOpen && (
        <div style={styles.dropdownMenu}>
          {!isEmpty ? (
            sortBySize(capabilities).map(cap => {
              const modelName = stripCapabilityAttrs(cap).replace(/^llm\./, '');
              const attrs = parseCapabilityAttrs(cap);
              const isSelected = model === modelName;
              return (
                <div
                  key={cap}
                  style={{
                    ...styles.dropdownItem,
                    backgroundColor: isSelected ? 'var(--primary)' : 'transparent',
                    color: isSelected ? '#fff' : 'var(--text)',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--chip-bg)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    setModel(modelName);
                    setDropdownOpen(false);
                  }}
                >
                  <span style={styles.itemContent}>
                    <span>{modelName}</span>
                    {attrs.length > 0 && (
                      <span style={styles.itemAttrs}>
                        {attrs.map(attr => <AttributeTag key={attr} attr={attr} inline={true} />)}
                      </span>
                    )}
                  </span>
                </div>
              );
            })
          ) : (
            <div style={{ ...styles.dropdownItem, ...styles.emptyDropdown }}>
              <div style={styles.emptyIcon}>?</div>
              <div style={styles.emptyTitle}>No models available</div>
              <div style={styles.emptyHint}>Start an agent with LLM capabilities to see models here</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const styles = {
  dropdownWrapper: {
    position: 'relative',
    flex: 1,
  },
  dropdownTrigger: {
    width: '100%',
    padding: '5px 10px',
    fontSize: '13px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    outline: 'none',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.2s ease',
  },
  dropdownMenu: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: '4px',
    background: 'var(--glass-strong)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    zIndex: 1000,
    maxHeight: '200px',
    overflowY: 'auto',
    backdropFilter: 'blur(10px)',
  },
  dropdownItem: {
    padding: '8px 10px',
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    borderBottom: '1px solid rgba(0, 0, 0, 0.05)',
  },
  triggerContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  triggerAttrs: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  itemContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    pointerEvents: 'none',
  },
  itemAttrs: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  dropdownTriggerEmpty: {
    borderStyle: 'dashed',
    opacity: 0.7,
  },
  emptyTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: 'var(--muted)',
    fontStyle: 'italic',
    fontSize: '12px',
  },
  emptyDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: 'var(--muted)',
    flexShrink: 0,
  },
  emptyDropdown: {
    cursor: 'default',
    textAlign: 'center',
    padding: '16px 12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  emptyIcon: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: '2px dashed var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '16px',
    color: 'var(--muted)',
    marginBottom: '4px',
  },
  emptyTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text)',
  },
  emptyHint: {
    fontSize: '11px',
    color: 'var(--muted)',
    lineHeight: 1.4,
  },
};

export default ModelSelector;
