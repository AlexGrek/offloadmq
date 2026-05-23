import { useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { ConfigPage } from "./pages/ConfigPage";

type Tab = "dashboard" | "config";

const NAV: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "config", label: "Config" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "0 20px",
          background: "#161616",
          borderBottom: "1px solid #222",
          height: 48,
        }}
      >
        <span
          style={{
            fontWeight: 700,
            fontSize: 14,
            color: "#fff",
            marginRight: 20,
            letterSpacing: "0.02em",
          }}
        >
          OffloadMQ
        </span>
        {NAV.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              background: tab === id ? "#1e293b" : "transparent",
              color: tab === id ? "#fff" : "#888",
              fontWeight: 500,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <main style={{ flex: 1 }}>
        {tab === "dashboard" && <Dashboard />}
        {tab === "config" && <ConfigPage />}
      </main>
    </div>
  );
}
