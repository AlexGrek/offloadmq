import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PALETTE = {
  light: {
    text: 'var(--text)',
    muted: 'var(--muted)',
    link: 'var(--primary, #3b82f6)',
    codeBg: 'var(--code-bg)',
    border: 'var(--border)',
  },
  dark: {
    text: '#f3f4f6',
    muted: '#9ca3af',
    link: '#93c5fd',
    codeBg: '#27272a',
    border: '#3f3f46',
  },
};

function makeComponents(p) {
  return {
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: p.link, textDecoration: 'underline' }}
      >
        {children}
      </a>
    ),
    p: ({ children }) => <p style={{ margin: '0 0 0.65em 0', color: p.text }}>{children}</p>,
    h1: ({ children }) => (
      <h1 style={{ fontSize: '1.35em', margin: '0.6em 0 0.4em', color: p.text, fontWeight: 700 }}>{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 style={{ fontSize: '1.2em', margin: '0.6em 0 0.35em', color: p.text, fontWeight: 700 }}>{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 style={{ fontSize: '1.08em', margin: '0.5em 0 0.3em', color: p.text, fontWeight: 600 }}>{children}</h3>
    ),
    ul: ({ children }) => <ul style={{ margin: '0 0 0.65em 0', paddingLeft: '1.35em', color: p.text }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: '0 0 0.65em 0', paddingLeft: '1.35em', color: p.text }}>{children}</ol>,
    li: ({ children }) => <li style={{ marginBottom: '0.25em' }}>{children}</li>,
    blockquote: ({ children }) => (
      <blockquote
        style={{
          margin: '0 0 0.65em 0',
          paddingLeft: '12px',
          borderLeft: `3px solid ${p.border}`,
          color: p.muted,
        }}
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${p.border}`, margin: '12px 0' }} />,
    strong: ({ children }) => <strong style={{ fontWeight: 700, color: p.text }}>{children}</strong>,
    em: ({ children }) => <em style={{ color: p.text }}>{children}</em>,
    table: ({ children }) => (
      <div style={{ overflowX: 'auto', marginBottom: '12px' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px', color: p.text }}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th
        style={{
          border: `1px solid ${p.border}`,
          padding: '6px 8px',
          textAlign: 'left',
          background: p.codeBg,
        }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td style={{ border: `1px solid ${p.border}`, padding: '6px 8px', verticalAlign: 'top' }}>{children}</td>
    ),
    img: ({ src, alt }) => (
      <img
        src={src}
        alt={alt || ''}
        style={{ maxWidth: '100%', height: 'auto', borderRadius: '6px', display: 'block', marginBottom: '8px' }}
      />
    ),
    code: ({ className, children, ...rest }) => {
      const isBlock = typeof className === 'string' && className.includes('language-');
      if (isBlock) {
        return (
          <code
            className={className}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: '13px',
              color: p.text,
            }}
            {...rest}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          style={{
            background: p.codeBg,
            padding: '2px 5px',
            borderRadius: '4px',
            fontSize: '0.9em',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            color: p.text,
          }}
          {...rest}
        >
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre
        style={{
          margin: '0 0 12px 0',
          padding: '12px',
          borderRadius: '6px',
          background: p.codeBg,
          border: `1px solid ${p.border}`,
          overflow: 'auto',
        }}
      >
        {children}
      </pre>
    ),
  };
}

/** Renders model / assistant markdown (GFM) with theme-aware styles for sandbox apps. */
const SandboxMarkdown = ({ children, tone = 'light', style, className }) => {
  const text = typeof children === 'string' ? children : String(children ?? '');
  const palette = PALETTE[tone] || PALETTE.light;
  const components = useMemo(() => makeComponents(PALETTE[tone] || PALETTE.light), [tone]);

  if (!text.trim()) return null;

  return (
    <div
      className={className}
      style={{
        fontSize: '14px',
        lineHeight: 1.55,
        color: palette.text,
        wordBreak: 'break-word',
        ...style,
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

export default SandboxMarkdown;
