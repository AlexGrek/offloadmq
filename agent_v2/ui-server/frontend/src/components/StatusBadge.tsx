interface Props {
  running: boolean;
}

export function StatusBadge({ running }: Props) {
  const color = running ? "#22c55e" : "#6b7280";
  const label = running ? "Running" : "Stopped";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 12,
        background: running ? "#052e16" : "#1c1c1c",
        color,
        fontSize: 13,
        fontWeight: 600,
        border: `1px solid ${color}`,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}
