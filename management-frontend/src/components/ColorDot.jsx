import React from 'react';
import {
  Asterisk,
  Bookmark,
  ChevronRight,
  CircleDashed,
  Diamond,
  FlagTriangleRight,
  FishSymbol,
  LaptopMinimal,
  RectangleHorizontal,
} from 'lucide-react';
import { getColorFromId } from '../utils';

/**
 * A generalized glowing color dot component seeded from any string ID.
 * Supports multiple visual styles: circle, square, and various Lucide icons.
 *
 * @param {string} seed - The string to derive color from (e.g., agent UID, task ID, user ID)
 * @param {number} size - Dot size in pixels (default: 12)
 * @param {string} variant - Visual style: 'circle' (default), 'square', 'asterisk', 'bookmark', 'chevrons-right', 'circle-dashed', 'diamond', 'flag-triangle-right', 'fish-symbol', 'laptop-minimal', 'rectangle-horizontal'
 * @param {string} title - Tooltip text (optional)
 * @param {object} style - Additional inline styles (optional)
 */
function ColorDot({ seed, size = 12, variant = 'circle', title, style = {} }) {
  if (!seed) return null;

  const { hex } = getColorFromId(seed);

  const iconProps = {
    size: Math.max(size - 2, 8),
    color: hex,
    strokeWidth: 2,
  };

  const iconMap = {
    asterisk: <Asterisk {...iconProps} />,
    bookmark: <Bookmark {...iconProps} />,
    'chevrons-right': <ChevronRight {...iconProps} />,
    'circle-dashed': <CircleDashed {...iconProps} />,
    diamond: <Diamond {...iconProps} />,
    'flag-triangle-right': <FlagTriangleRight {...iconProps} />,
    'fish-symbol': <FishSymbol {...iconProps} />,
    'laptop-minimal': <LaptopMinimal {...iconProps} />,
    'rectangle-horizontal': <RectangleHorizontal {...iconProps} />,
  };

  const renderIcon = () => {
    if (variant === 'circle') {
      return (
        <div
          style={{
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: '50%',
            backgroundColor: hex,
            boxShadow: `0 0 8px ${hex}, 0 0 16px ${hex}`,
          }}
        />
      );
    }

    if (variant === 'square') {
      return (
        <div
          style={{
            width: `${size}px`,
            height: `${size}px`,
            backgroundColor: hex,
            boxShadow: `0 0 8px ${hex}, 0 0 16px ${hex}`,
          }}
        />
      );
    }

    // Lucide icon variants
    if (iconMap[variant]) {
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: hex,
            filter: `drop-shadow(0 0 8px ${hex}) drop-shadow(0 0 16px ${hex}90)`,
          }}
        >
          {iconMap[variant]}
        </div>
      );
    }

    // Fallback to circle if variant is invalid
    return (
      <div
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '50%',
          backgroundColor: hex,
          boxShadow: `0 0 8px ${hex}, 0 0 16px ${hex}`,
          animation: 'color-dot-pulse 2s ease-in-out infinite',
        }}
      />
    );
  };

  return (
    <>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginRight: size < 14 ? '8px' : '12px',
          ...style,
        }}
        title={title || seed}
      >
        {renderIcon()}
      </div>
    </>
  );
}

export default ColorDot;
