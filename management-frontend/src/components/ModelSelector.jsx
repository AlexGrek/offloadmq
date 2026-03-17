import React, { useState, useEffect, useRef } from 'react';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import AttributeTag from './AttributeTag';

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

  const selectedCap = capabilities.find(cap => stripCapabilityAttrs(cap).replace(/^llm\./, '') === model);
  const selectedAttrs = selectedCap ? parseCapabilityAttrs(selectedCap) : [];

  return (
    <div style={styles.dropdownWrapper} ref={dropdownRef}>
      <button
        style={{
          ...styles.dropdownTrigger,
          borderColor: dropdownOpen ? 'var(--primary)' : 'var(--border)',
        }}
        onClick={() => setDropdownOpen(!dropdownOpen)}
      >
        <span style={styles.triggerContent}>
          <span>{model}</span>
          {selectedAttrs.length > 0 && (
            <span style={styles.triggerAttrs}>
              {selectedAttrs.map(attr => <AttributeTag key={attr} attr={attr} inline={true} />)}
            </span>
          )}
        </span>
      </button>
      {dropdownOpen && (
        <div style={styles.dropdownMenu}>
          {capabilities.length > 0 ? (
            capabilities.map(cap => {
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
            <div style={styles.dropdownItem}>No models available</div>
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
};

export default ModelSelector;
