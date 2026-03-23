import React, { useEffect, useState, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, NavLink } from "react-router-dom";
import './App.css';
import ExpandableDeleteButton from "./components/ExpandableDeleteButton";
import { Brackets, Database, HardDriveDownload, KeySquare, ListChecks, Loader2, Menu, Moon, ScrollText, SquarePlay, Sun, Zap, Wrench } from "lucide-react";
import { TOKEN_KEY, apiFetch } from "./utils";

const AgentsPage = React.lazy(() => import("./components/AgentsPage"));
const ApiKeysPage = React.lazy(() => import("./components/ApiKeysPage"));
const TasksPage = React.lazy(() => import("./components/TasksPage"));
const ApiTestingTool = React.lazy(() => import("./components/ApiTestingTool"));
const SandboxApps = React.lazy(() => import("./components/SandboxApps"));
const StoragePage = React.lazy(() => import("./components/StoragePage"));
const ServiceLogsPage = React.lazy(() => import("./components/ServiceLogsPage"));
const BackgroundJobTriggersPage = React.lazy(() => import("./components/BackgroundJobTriggersPage"));
const UtilsPage = React.lazy(() => import("./components/UtilsPage"));
const TokenSettingsPage = React.lazy(() => import("./components/TokenSettingsPage"));

// ----- Route Loader -----
function RouteLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '400px' }}>
      <div style={{ animation: 'spin 1s linear infinite' }}>
        <Loader2 size={32} color="var(--primary)" />
      </div>
    </div>
  );
}

// ----- Navigation Config -----
const routes = [
  { path: "/agents", label: "Agents", icon: <HardDriveDownload /> },
  { path: "/api-keys", label: "API keys", icon: <KeySquare /> },
  { path: "/tasks", label: "Tasks", icon: <ListChecks /> },
  { path: "/storage", label: "Storage", icon: <Database /> },
  { path: "/sandbox", label: "Sandbox", icon: <SquarePlay /> },
  { path: "/service-logs", label: "Service Logs", icon: <ScrollText /> },
  { path: "/bg-triggers", label: "BG Triggers", icon: <Zap /> },
  { path: "/utils", label: "Utils", icon: <Wrench /> },
  { path: "/json", label: "JSON", icon: <Brackets /> },
  { path: "/token", label: "Token", icon: <KeySquare /> },
];

// ----- Main App Layout -----
function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("offloadmq-theme") === "dark");
  const [frontendVersion, setFrontendVersion] = useState(null);
  const [serverVersion, setServerVersion] = useState(null);
const tokenMissing = !(localStorage.getItem(TOKEN_KEY) || "");

  useEffect(() => {
    fetch('/version').then(r => r.json()).then(d => setFrontendVersion(d.version)).catch(() => {});
    apiFetch('/management/version').then(d => setServerVersion(d.version)).catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("offloadmq-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    const onResize = () => { if (window.innerWidth > 900) setNavOpen(true); };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => { if (window.innerWidth > 900) setNavOpen(true); }, []);

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon" onClick={() => setNavOpen(s => !s)} aria-label="Toggle menu"><Menu /></button>
        <div className="brand">Offload MQ Management Console</div>
        <div className="spacer" />
        {(frontendVersion || serverVersion) && (() => {
          const mismatch = frontendVersion && serverVersion && frontendVersion !== serverVersion;
          const color = mismatch ? 'var(--danger)' : 'var(--muted)';
          return (
            <span style={{ fontSize: '11px', color, marginRight: '8px', fontFamily: 'monospace' }} title={mismatch ? 'Version mismatch between frontend and server' : undefined}>
              ui:{frontendVersion ?? '…'} srv:{serverVersion ?? '…'}
            </span>
          );
        })()}
        <button className="theme-toggle" onClick={() => setDark(d => !d)} aria-label="Toggle theme">
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        {tokenMissing && <span className="badge warn">No token</span>}
      </header>

      <div className="layout">
        {navOpen && (
          <aside className="sidebar">
            <nav>
              {routes.map(r => (
                <NavLink
                  key={r.path}
                  to={r.path}
                  onClick={() => { if (window.innerWidth < 900) setNavOpen(false); }}
                  className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
                >
                  <span className="icon-wrap">{r.icon}</span>
                  <span>{r.label}</span>
                </NavLink>
              ))}
            </nav>
          </aside>
        )}

        <main className="content">
          <Suspense fallback={<RouteLoader />}>
            <div className="route-container">
              <Routes>
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/api-keys" element={<ApiKeysPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/storage" element={<StoragePage />} />
                <Route path="/sandbox" element={<SandboxApps />} />
                <Route path="/service-logs" element={<ServiceLogsPage />} />
                <Route path="/bg-triggers" element={<BackgroundJobTriggersPage />} />
                <Route path="/utils" element={<UtilsPage />} />
                <Route path="/json" element={<ApiTestingTool />} />
                <Route path="/token" element={<TokenSettingsPage />} />
                <Route path="/" element={<AgentsPage />} />
              </Routes>
            </div>
          </Suspense>
        </main>
      </div>
    </div>
  );
}

// ----- Main App with Router -----
export default function App() {
  return (
    <Router basename="/ui">
      <AppLayout />
    </Router>
  );
}
