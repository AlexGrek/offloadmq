import React, { useEffect, useState } from "react";
import { BrowserRouter as Router, Routes, Route, NavLink, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from 'framer-motion';
import './App.css';
import ExpandableDeleteButton from "./components/ExpandableDeleteButton";
import { Brackets, Database, HardDriveDownload, KeySquare, ListChecks, Menu, Moon, ScrollText, SquarePlay, Sun, Zap, Wrench } from "lucide-react";
import AgentsPage from "./components/AgentsPage";
import { TOKEN_KEY, apiFetch } from "./utils";
import ApiKeysPage from "./components/ApiKeysPage";
import TasksPage from "./components/TasksPage";
import ApiTestingTool from "./components/ApiTestingTool";
import SandboxApps from "./components/SandboxApps";
import StoragePage from "./components/StoragePage";
import ServiceLogsPage from "./components/ServiceLogsPage";
import TokenSettings from "./components/TokenSettings";
import BackgroundJobTriggersPage from "./components/BackgroundJobTriggersPage";
import UtilsPage from "./components/UtilsPage";

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
];

// ----- Main App Layout -----
function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("offloadmq-theme") === "dark");
  const [frontendVersion, setFrontendVersion] = useState(null);
  const [serverVersion, setServerVersion] = useState(null);
  const location = useLocation();
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
        <TokenSettings />
        {tokenMissing && <span className="badge warn">No token</span>}
      </header>

      <div className="layout">
        <AnimatePresence initial={false}>
          {navOpen && (
            <motion.aside className="sidebar" initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ type: "spring", stiffness: 150, damping: 18 }}>
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
            </motion.aside>
          )}
        </AnimatePresence>

        <main className="content">
          <AnimatePresence mode="wait">
            <motion.div key={location.pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
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
                <Route path="/" element={<AgentsPage />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

// ----- Main App with Router -----
export default function App() {
  return (
    <Router>
      <AppLayout />
    </Router>
  );
}
