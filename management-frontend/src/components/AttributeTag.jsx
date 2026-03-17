import React from 'react';
import { Eye, Wrench } from 'lucide-react';

const AttributeTag = ({ attr, inline = false }) => {
  const getIcon = () => {
    if (attr.includes('vision')) return <Eye size={12} />;
    if (attr.includes('tools')) return <Wrench size={12} />;
    return null;
  };

  const icon = getIcon();

  if (inline) {
    return (
      <span
        style={{
          fontSize: '9px',
          background: 'var(--glass)',
          border: '1px solid var(--border)',
          borderRadius: '3px',
          padding: '1px 4px',
          color: 'var(--muted)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
        }}
      >
        {icon}
        {attr}
      </span>
    );
  }

  return (
    <span className="attr-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      {icon}
      {attr}
    </span>
  );
};

export default AttributeTag;
