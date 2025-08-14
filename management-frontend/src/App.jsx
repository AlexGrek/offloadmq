import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {Trash} from "lucide-react";
import './App.css';

// ----- Utility: API fetch with Authorization header from LocalStorage -----
const TOKEN_KEY = "offload-mq-mgmt-token";

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", headers.get("Content-Type") || "application/json");
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ""}`);
  }
  // try to parse json; if empty, return null
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return null;
}

// ----- Icons (inline SVG) -----
const Icon = {
  menu: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" {...p}><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  ),
  refresh: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}><path d="M20 12a8 8 0 1 1-2.343-5.657" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M20 4v6h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  ),
  trash: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}><path d="M3 6h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 6v14a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6" stroke="currentColor" strokeWidth="2"/><path d="M10 6V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="2"/></svg>
  ),
  key: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}><path d="M21 10l-6 6h-3l-2 2H7v-3l2-2v-3l6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="16" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
  ),
  settings: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" stroke="currentColor" strokeWidth="2" fill="none"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 6.04 3.4l.06.06A1.65 1.65 0 0 0 7.92 3a1.65 1.65 0 0 0 1-1.51V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
  ),
  check: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}><path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>
  ),
  x: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  ),
};

// ----- Formatting helpers -----
const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return iso;
  }
};

const Chip = ({ children }) => (
  <span className="chip">{children}</span>
);

const Banner = ({ children, kind = "info" }) => (
  <div className={`banner ${kind}`}>{children}</div>
);

// ----- Agents Page -----
function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [expanded, setExpanded] = useState({}); // uid -> bool

  const load = async () => {
    setLoading(true); setError("");
    try {
      const url = onlineOnly ? "/management/agents/list/online" : "/management/agents/list";
      const data = await apiFetch(url);
      setAgents(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [onlineOnly]);

  const toggle = (uid) => setExpanded((s) => ({ ...s, [uid]: !s[uid] }));

  const onDelete = async (uid) => {
    if (!confirm("Delete this agent?")) return;
    try {
      await apiFetch(`/management/agents/delete/${encodeURIComponent(uid)}`, { method: "POST" });
      await load();
    } catch (e) {
      alert(`Failed to delete: ${e.message}`);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Agents</div>
        <div className="actions">
          <label className="toggle">
            <input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} />
            <span>Online only</span>
          </label>
          <button className="btn" onClick={load}><Icon.refresh /> <span>Refresh</span></button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : (
        <ul className="list">
          {agents.map((a) => {
            const isOpen = !!expanded[a.uid];
            return (
              <li key={a.uid} className="card">
                <div className="row" onClick={() => toggle(a.uid)} aria-expanded={isOpen}>
                  <div className="row-main">
                    <div className="row-title">{a.uidShort || a.uid}</div>
                    <div className="row-sub">
                      <Chip>Tier {a.tier}</Chip>
                      <Chip>Capacity {a.capacity}</Chip>
                      <Chip>{(a.capabilities||[]).length} caps</Chip>
                      <Chip>{a.lastContact ? "Seen " + new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((new Date(a.lastContact)-Date.now())/60000), "minute") : "Never"}</Chip>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="btn danger" onClick={(e)=>{e.stopPropagation(); onDelete(a.uid);}} title="Delete"><Trash/></button>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div className="expand" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 120, damping: 18 }}>
                      <div className="grid">
                        <div>
                          <div className="kv"><span>UID:</span><code>{a.uid}</code></div>
                          <div className="kv"><span>Registered:</span><b>{fmtDate(a.registeredAt)}</b></div>
                          <div className="kv"><span>Last contact:</span><b>{fmtDate(a.lastContact)}</b></div>
                          <div className="kv"><span>Personal token:</span><code>{a.personalLoginToken}</code></div>
                        </div>
                        <div>
                          <div className="section-title">System</div>
                          <div className="kv"><span>OS:</span><b>{a.systemInfo?.os}</b></div>
                          <div className="kv"><span>Client:</span><b>{a.systemInfo?.client}</b></div>
                          <div className="kv"><span>Runtime:</span><b>{a.systemInfo?.runtime}</b></div>
                          <div className="kv"><span>CPU Arch:</span><b>{a.systemInfo?.cpuArch}</b></div>
                          <div className="kv"><span>Total RAM:</span><b>{a.systemInfo?.totalMemoryMb} MB</b></div>
                        </div>
                        <div>
                          <div className="section-title">GPU</div>
                          {a.systemInfo?.gpu ? (
                            <>
                              <div className="kv"><span>Vendor:</span><b>{a.systemInfo.gpu.vendor}</b></div>
                              <div className="kv"><span>Model:</span><b>{a.systemInfo.gpu.model}</b></div>
                              <div className="kv"><span>VRAM:</span><b>{a.systemInfo.gpu.vramMb} MB</b></div>
                            </>
                          ) : (
                            <div className="muted">No GPU</div>
                          )}
                        </div>
                        <div>
                          <div className="section-title">Capabilities</div>
                          <div className="chips-wrap">{(a.capabilities||[]).map((c,i)=>(<Chip key={i}>{c}</Chip>))}</div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ----- API Keys Page -----
function ApiKeysPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [keyVal, setKeyVal] = useState("");
  const [caps, setCaps] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const data = await apiFetch("/management/client_api_keys/list");
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(()=>{ load(); }, []);

  const onCreate = async (e) => {
    e.preventDefault();
    const capabilities = caps.split(",").map(s=>s.trim()).filter(Boolean);
    try {
      await apiFetch("/management/client_api_keys/update", {
        method: "POST",
        body: JSON.stringify({ key: keyVal, capabilities })
      });
      setKeyVal(""); setCaps("");
      await load();
    } catch (e) { alert(`Failed to create: ${e.message}`); }
  };

  const onRevoke = async (key) => {
    if (!confirm("Revoke this API key?")) return;
    try {
      await apiFetch(`/management/client_api_keys/revoke/${encodeURIComponent(key)}`, { method: "POST" });
      await load();
    } catch (e) { alert(`Failed to revoke: ${e.message}`); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">API Keys</div>
        <div className="actions"><button className="btn" onClick={load}><Icon.refresh/> <span>Refresh</span></button></div>
      </div>

      <form className="card form" onSubmit={onCreate}>
        <div className="form-row">
          <label>Key</label>
          <input value={keyVal} onChange={(e)=>setKeyVal(e.target.value)} placeholder="my-app-key-123" required />
        </div>
        <div className="form-row">
          <label>Capabilities</label>
          <input value={caps} onChange={(e)=>setCaps(e.target.value)} placeholder="capA, capB, capC" />
        </div>
        <div className="form-actions"><button className="btn primary" type="submit"><Icon.key/> <span>Create / Update</span></button></div>
      </form>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : (
        <ul className="list">
          {items.map((it)=> (
            <li key={it.key} className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title mono" title={it.key}>{it.key}</div>
                  <div className="row-sub">
                    <Chip>{it.isPredefined ? "predefined" : "custom"}</Chip>
                    <Chip>{it.isRevoked ? "revoked" : "active"}</Chip>
                    <Chip>created {fmtDate(it.created)}</Chip>
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn danger" onClick={()=>onRevoke(it.key)} disabled={it.isRevoked}>Revoke</button>
                </div>
              </div>
              {(it.capabilities||[]).length>0 && (
                <div className="pad">
                  <div className="section-title">Capabilities</div>
                  <div className="chips-wrap">{it.capabilities.map((c,i)=>(<Chip key={i}>{c}</Chip>))}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----- Settings Page -----
function SettingsPage() {
  const [token, setToken] = useState("");
  useEffect(()=>{ setToken(localStorage.getItem(TOKEN_KEY)||""); }, []);
  const save = () => { localStorage.setItem(TOKEN_KEY, token); alert("Token saved"); };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Settings</div>
      </div>
      <div className="card form">
        <div className="form-row">
          <label>Management Token</label>
          <input value={token} onChange={(e)=>setToken(e.target.value)} placeholder="paste your token here" />
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={save}><Icon.check/> <span>Save</span></button>
        </div>
      </div>
      {!token && (
        <Banner kind="warn">No token set. Go to Settings and paste your token to authorize requests.</Banner>
      )}
    </div>
  );
}

// ----- Dummy Pages -----
const Placeholder = ({ title }) => (
  <div className="page">
    <div className="page-head"><div className="title">{title}</div></div>
    <div className="card">This is a placeholder page. Build your UI here.</div>
  </div>
);

// ----- App Shell -----
const routes = [
  { id: "agents", label: "Agents", icon: <Icon.check/> },
  { id: "api-keys", label: "API keys", icon: <Icon.key/> },
  { id: "tasks", label: "Tasks", icon: <Icon.check/> },
  { id: "sandbox", label: "Sandbox", icon: <Icon.check/> },
];

export default function App() {
  const [route, setRoute] = useState("agents");
  const [navOpen, setNavOpen] = useState(false);
  const tokenMissing = !(localStorage.getItem(TOKEN_KEY)||"");

  useEffect(()=>{
    const onResize = () => { if (window.innerWidth > 900) setNavOpen(true); };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(()=>{ if (window.innerWidth > 900) setNavOpen(true); }, []);

  const Page = useMemo(()=>{
    switch(route){
      case "agents": return <AgentsPage/>;
      case "api-keys": return <ApiKeysPage/>;
      case "tasks": return <Placeholder title="Tasks"/>;
      case "sandbox": return <Placeholder title="Sandbox"/>;
      case "settings": return <SettingsPage/>;
      default: return <AgentsPage/>;
    }
  }, [route]);

  return (
    <div className="app">

      <header className="topbar">
        <button className="icon" onClick={()=>setNavOpen(s=>!s)} aria-label="Toggle menu"><Icon.menu/></button>
        <div className="brand">Offload MQ – Management</div>
        <div className="spacer"/>
        {tokenMissing && <span className="badge warn">No token</span>}
      </header>

      <div className="layout">
        <AnimatePresence initial={false}>
          {navOpen && (
            <motion.aside className="sidebar" initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ type: "spring", stiffness: 150, damping: 18 }}>
              <nav>
                {routes.map(r => (
                  <button key={r.id} className={`nav-item ${route===r.id?"active":""}`} onClick={()=>{ setRoute(r.id); if (window.innerWidth < 900) setNavOpen(false); }}>
                    <span className="icon-wrap">{r.icon}</span>
                    <span>{r.label}</span>
                  </button>
                ))}
              </nav>
              <div className="bottom">
                <button className={`nav-item ${route==="settings"?"active":""}`} onClick={()=>{ setRoute("settings"); if (window.innerWidth < 900) setNavOpen(false); }}>
                  <span className="icon-wrap"><Icon.settings/></span>
                  <span>Settings</span>
                </button>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        <main className="content">
          <AnimatePresence mode="wait">
            <motion.div key={route} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
              {Page}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
