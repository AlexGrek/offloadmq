import React, { useEffect, useMemo, useCallback, useState } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import './App.css';
import ExpandableDeleteButton from "./components/ExpandableDeleteButton";
import { Brackets, HardDriveDownload, KeySquare, ListChecks, Menu, Settings2, SquarePlay } from "lucide-react";
import AgentsPage from "./components/AgentsPage";
import { TOKEN_KEY } from "./utils";
import ApiKeysPage from "./components/ApiKeysPage";
import SettingsPage from "./components/SettingsPage";
import TasksPage from "./components/TasksPage";
import ApiTestingTool from "./components/ApiTestingTool";
import SandboxApps from "./components/SandboxApps";

// ----- App Shell -----
const routes = [
  { id: "agents", label: "Agents", icon: <HardDriveDownload /> },
  { id: "api-keys", label: "API keys", icon: <KeySquare /> },
  { id: "tasks", label: "Tasks", icon: <ListChecks /> },
  { id: "sandbox", label: "Sandbox", icon: <SquarePlay /> },
  { id: "json", label: "JSON", icon: <Brackets /> },
];

export default function App() {
  const [route, setRoute] = useState("agents");
  const [navOpen, setNavOpen] = useState(false);
  const tokenMissing = !(localStorage.getItem(TOKEN_KEY) || "");

  useEffect(() => {
    const onResize = () => { if (window.innerWidth > 900) setNavOpen(true); };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => { if (window.innerWidth > 900) setNavOpen(true); }, []);

  const Page = useMemo(() => {
    switch (route) {
      case "agents": return <AgentsPage />;
      case "api-keys": return <ApiKeysPage />;
      case "tasks": return <TasksPage />;
      case "sandbox": return <SandboxApps />;
      case "json": return <ApiTestingTool />;
      case "settings": return <SettingsPage />;
      default: return <AgentsPage />;
    }
  }, [route]);

  return (
    <div className="app">

      <header className="topbar">
        <button className="icon" onClick={() => setNavOpen(s => !s)} aria-label="Toggle menu"><Menu /></button>
        <div className="brand">Offload MQ Management Console</div>
        <div className="spacer" />
        {tokenMissing && <span className="badge warn">No token</span>}
      </header>

      <div className="layout">
        <AnimatePresence initial={false}>
          {navOpen && (
            <motion.aside className="sidebar" initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ type: "spring", stiffness: 150, damping: 18 }}>
              <nav>
                {routes.map(r => (
                  <button key={r.id} className={`nav-item ${route === r.id ? "active" : ""}`} onClick={() => { setRoute(r.id); if (window.innerWidth < 900) setNavOpen(false); }}>
                    <span className="icon-wrap">{r.icon}</span>
                    <span>{r.label}</span>
                  </button>
                ))}
              </nav>
              <div className="bottom">
                <button className={`nav-item ${route === "settings" ? "active" : ""}`} onClick={() => { setRoute("settings"); if (window.innerWidth < 900) setNavOpen(false); }}>
                  <span className="icon-wrap"><Settings2 /></span>
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
