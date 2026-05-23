import { useEffect, useRef } from "react";

interface Props {
  logs: string[];
}

export function LogPane({ logs }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div
      ref={ref}
      style={{
        background: "#111",
        border: "1px solid #2a2a2a",
        borderRadius: 8,
        padding: "12px 16px",
        height: 280,
        overflowY: "auto",
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 1.6,
        color: "#a0a0a0",
      }}
    >
      {logs.length === 0 ? (
        <span style={{ color: "#444" }}>No logs yet.</span>
      ) : (
        logs.map((line, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {line}
          </div>
        ))
      )}
    </div>
  );
}
