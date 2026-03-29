import React from 'react';
import { Eye, Wrench } from 'lucide-react';

// Attrs that should render as icon-only (text hidden, title used as tooltip)
const ICON_ATTRS = {
  vision: <Eye size={12} />,
  tools: <Wrench size={12} />,
};

function getIconEntry(attr) {
  for (const [key, icon] of Object.entries(ICON_ATTRS)) {
    if (attr.includes(key)) return { icon, label: attr };
  }
  return null;
}

const AttributeTag = ({ attr, inline = false }) => {
  const iconEntry = getIconEntry(attr);

  if (inline) {
    return (
      <span
        title={iconEntry ? iconEntry.label : undefined}
        style={{
          fontSize: '9px',
          background: 'var(--glass)',
          border: '1px solid var(--border)',
          borderRadius: '3px',
          padding: iconEntry ? '2px 4px' : '1px 4px',
          color: 'var(--muted)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
        }}
      >
        {iconEntry ? iconEntry.icon : attr}
      </span>
    );
  }

  return (
    <span
      className="attr-tag"
      title={iconEntry ? iconEntry.label : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
    >
      {iconEntry ? iconEntry.icon : attr}
    </span>
  );
};

export default AttributeTag;
