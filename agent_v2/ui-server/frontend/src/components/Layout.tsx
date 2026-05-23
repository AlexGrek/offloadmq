import { NavLink, Outlet } from "react-router";
import {
  Cpu,
  LayoutDashboard,
  ListChecks,
  Settings as Cog,
  Plug,
  Shield,
  Terminal,
  Wrench,
  Image,
  FileCode,
  ScrollText,
} from "lucide-react";

import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/tasks", label: "Tasks", icon: ListChecks, end: false },
  { to: "/connection", label: "Connection", icon: Plug, end: false },
  { to: "/capabilities", label: "Capabilities", icon: Shield, end: false },
  { to: "/slavemode", label: "Slavemode", icon: Terminal, end: false },
  { to: "/custom", label: "Custom", icon: FileCode, end: false },
  { to: "/comfy", label: "ComfyUI", icon: Image, end: false },
  { to: "/system", label: "System", icon: Wrench, end: false },
  { to: "/logs", label: "Logs", icon: ScrollText, end: false },
  { to: "/config", label: "Raw config", icon: FileCode, end: false },
  { to: "/settings", label: "Settings", icon: Cog, end: false },
];

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <div className="flex shrink-0 items-center gap-2 font-semibold">
            <Cpu className="size-5" />
            <span>OffloadMQ Agent</span>
          </div>
          <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )
                }
              >
                <Icon className="size-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
