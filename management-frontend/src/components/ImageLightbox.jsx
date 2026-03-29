import React, { useEffect, useState } from 'react';

/**
 * Full-screen image lightbox with fade+scale animation.
 *
 * Props:
 *   src      – image URL to show (null/undefined = closed)
 *   alt      – alt text
 *   onClose  – called when the user dismisses the lightbox
 */
const ImageLightbox = ({ src, alt = '', onClose }) => {
  const [visible, setVisible] = useState(false);

  // Trigger enter animation after mount; trigger leave animation before unmount
  useEffect(() => {
    if (src) {
      // Small delay so the initial "hidden" state is painted first
      const t = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(t);
    } else {
      setVisible(false);
    }
  }, [src]);

  useEffect(() => {
    if (!src) return;
    const handleKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: `rgba(0,0,0,${visible ? 0.82 : 0})`,
        transition: 'background-color 0.22s ease',
        cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          borderRadius: '10px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          cursor: 'default',
          transform: visible ? 'scale(1)' : 'scale(0.85)',
          opacity: visible ? 1 : 0,
          transition: 'transform 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.18s ease',
          userSelect: 'none',
        }}
      />
    </div>
  );
};

export default ImageLightbox;
