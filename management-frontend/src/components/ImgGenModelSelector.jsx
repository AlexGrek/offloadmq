import React, { useState, useEffect, useRef } from 'react';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import AttributeTag from './AttributeTag';

const ImgGenModelSelector = ({ model, setModel, capabilities = [] }) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState(null);
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

  // Defensive checks for capabilities array
  let validCapabilities = [];
  try {
    if (Array.isArray(capabilities)) {
      validCapabilities = capabilities.filter(cap => {
        if (typeof cap !== 'string') return false;
        if (!cap.startsWith('imggen.')) return false;
        return true;
      });
    }
  } catch (e) {
    console.error('Error processing capabilities:', e);
    setError(e.message);
  }

  const isEmpty = validCapabilities.length === 0;

  // For imggen, the model is the workflow name (e.g., "wan-2.1-outpaint")
  let selectedAttrs = [];
  try {
    const selectedCap = validCapabilities.find(cap => {
      try {
        const base = stripCapabilityAttrs(cap);
        const workflow = base.replace(/^imggen\./, '');
        return workflow === model;
      } catch (e) {
        console.warn('Error processing capability:', cap, e);
        return false;
      }
    });
    if (selectedCap) {
      selectedAttrs = parseCapabilityAttrs(selectedCap) || [];
    }
  } catch (e) {
    console.error('Error getting selected attributes:', e);
    setError(e.message);
  }

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
          {error ? (
            <div style={{ ...styles.dropdownItem, ...styles.emptyDropdown }}>
              <div style={styles.errorIcon}>!</div>
              <div style={styles.emptyTitle}>Error loading workflows</div>
              <div style={styles.emptyHint}>{error}</div>
            </div>
          ) : !isEmpty ? (
            validCapabilities.map(cap => {
              try {
                const base = stripCapabilityAttrs(cap);
                const workflowName = base.replace(/^imggen\./, '');
                const attrs = parseCapabilityAttrs(cap) || [];
                const isSelected = model === workflowName;
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
                      try {
                        setModel(workflowName);
                        setDropdownOpen(false);
                      } catch (e) {
                        console.error('Error setting model:', e);
                        setError(e.message);
                      }
                    }}
                  >
                    <span style={styles.itemContent}>
                      <span>{workflowName}</span>
                      {attrs.length > 0 && (
                        <span style={styles.itemAttrs}>
                          {attrs.map(attr => <AttributeTag key={attr} attr={attr} inline={true} />)}
                        </span>
                      )}
                    </span>
                  </div>
                );
              } catch (e) {
                console.warn('Error rendering capability item:', cap, e);
                return null;
              }
            }).filter(Boolean)
          ) : (
            <div style={{ ...styles.dropdownItem, ...styles.emptyDropdown }}>
              <div style={styles.emptyIcon}>?</div>
              <div style={styles.emptyTitle}>No models available</div>
              <div style={styles.emptyHint}>Start an agent with imggen capabilities to see workflows here</div>
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
  errorIcon: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: '2px dashed var(--danger)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '16px',
    color: 'var(--danger)',
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

export default ImgGenModelSelector;
