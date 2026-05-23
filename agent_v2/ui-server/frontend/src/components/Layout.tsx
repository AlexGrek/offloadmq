import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import {
  Cpu,
  FileCode,
  Image,
  LayoutDashboard,
  ListChecks,
  Menu,
  Plug,
  ScrollText,
  Settings as Cog,
  Shield,
  Terminal,
  Wrench,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/tasks", label: "Tasks", icon: ListChecks },
  { to: "/connection", label: "Connection", icon: Plug },
  { to: "/capabilities", label: "Capabilities", icon: Shield },
  { to: "/slavemode", label: "Slavemode", icon: Terminal },
  { to: "/custom", label: "Custom caps", icon: FileCode },
  { to: "/comfy", label: "ComfyUI", icon: Image },
  { to: "/system", label: "System", icon: Wrench },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/config", label: "Raw config", icon: FileCode },
  { to: "/settings", label: "Settings", icon: Cog },
];

function currentLabel(pathname: string) {
  const match = NAV.slice()
    .reverse()
    .find((n) => (n.end ? pathname === "/" : pathname.startsWith(n.to)));
  return match?.label ?? "";
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // Close on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const label = currentLabel(location.pathname);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-card sticky top-0 z-40">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <div className="flex items-center gap-2 font-semibold">
            <Cpu className="size-5" />
            <span className="hidden sm:inline">OffloadMQ Agent</span>
            {label && (
              <span className="text-muted-foreground font-normal text-sm sm:before:content-['/'] sm:before:mr-2 sm:before:text-border">
                {label}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm"
          aria-hidden
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={cn(
          "fixed top-14 left-0 z-40 h-[calc(100vh-3.5rem)] w-64 bg-card border-r shadow-xl transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <nav className="flex flex-col gap-0.5 p-3 h-full overflow-y-auto">
          {NAV.map(({ to, label: lbl, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              {lbl}
            </NavLink>
          ))}
        </nav>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
