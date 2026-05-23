import { useEffect, useState } from "react";
import { api, AgentConfig } from "../api";

const DEFAULT_CONFIG: AgentConfig = {
  server: "",
  api_key: "",
  capabilities: [],
  custom_caps: [],
  tier: 1,
  capacity: 4,
  autostart: false,
};

export function ConfigPage() {
  const [cfg, setCfg] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    api.getConfig().then(setCfg).catch(() => {});
  }, []);

  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setCfg((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    await api.saveConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const res = await api.detectCapabilities();
      set("capabilities", res.capabilities);
    } finally {
      setDetecting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "7px 10px",
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 14,
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    color: "#888",
    marginBottom: 4,
  };

  return (
    <div style={{ padding: "32px 24px", maxWidth: 600, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 24px", fontSize: 22, fontWeight: 700, color: "#fff" }}>
        Configuration
      </h1>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label style={labelStyle}>Server URL</label>
          <input
            style={inputStyle}
            value={cfg.server}
            onChange={(e) => set("server", e.target.value)}
            placeholder="http://your-server:3069"
          />
        </div>

        <div>
          <label style={labelStyle}>API Key</label>
          <input
            style={inputStyle}
            type="password"
            value={cfg.api_key}
            onChange={(e) => set("api_key", e.target.value)}
            placeholder="ak_live_..."
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>Tier</label>
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={10}
              value={cfg.tier}
              onChange={(e) => set("tier", Number(e.target.value))}
            />
          </div>
          <div>
            <label style={labelStyle}>Capacity</label>
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={64}
              value={cfg.capacity}
              onChange={(e) => set("capacity", Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>Capabilities</label>
            <button
              onClick={detect}
              disabled={detecting}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid #444",
                background: "#1e1e1e",
                color: "#ccc",
                cursor: "pointer",
              }}
            >
              {detecting ? "Detecting…" : "Auto-detect"}
            </button>
          </div>
          <input
            style={inputStyle}
            value={cfg.capabilities.join(", ")}
            onChange={(e) =>
              set(
                "capabilities",
                e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
              )
            }
            placeholder="debug.echo, llm.mistral, shell.bash"
          />
        </div>

        <div>
          <label style={labelStyle}>Custom Capabilities</label>
          <input
            style={inputStyle}
            value={cfg.custom_caps.join(", ")}
            onChange={(e) =>
              set(
                "custom_caps",
                e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
              )
            }
            placeholder="my.custom.cap"
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            id="autostart"
            checked={cfg.autostart}
            onChange={(e) => set("autostart", e.target.checked)}
          />
          <label htmlFor="autostart" style={{ fontSize: 14, color: "#ccc", cursor: "pointer" }}>
            Auto-start agent on launch
          </label>
        </div>

        <button
          onClick={save}
          style={{
            padding: "9px 0",
            borderRadius: 6,
            border: "none",
            background: saved ? "#14532d" : "#1d4ed8",
            color: "#fff",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          {saved ? "Saved!" : "Save"}
        </button>
      </div>
    </div>
  );
}
