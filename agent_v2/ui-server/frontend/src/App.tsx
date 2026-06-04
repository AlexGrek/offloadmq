import { Route, Routes } from "react-router";

import { Layout } from "@/components/Layout";
import { CapabilitiesPage } from "@/pages/CapabilitiesPage";
import { ComfyPage } from "@/pages/ComfyPage";
import { KokoroPage } from "@/pages/KokoroPage";
import { ConfigPage } from "@/pages/ConfigPage";
import { ConnectionPage } from "@/pages/ConnectionPage";
import { CustomCapsPage } from "@/pages/CustomCapsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { LogsPage } from "@/pages/LogsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SlavemodePage } from "@/pages/SlavemodePage";
import { SystemPage } from "@/pages/SystemPage";
import { TaskDetailPage } from "@/pages/TaskDetailPage";
import { TasksPage } from "@/pages/TasksPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="connection" element={<ConnectionPage />} />
        <Route path="capabilities" element={<CapabilitiesPage />} />
        <Route path="slavemode" element={<SlavemodePage />} />
        <Route path="custom" element={<CustomCapsPage />} />
        <Route path="comfy" element={<ComfyPage />} />
        <Route path="kokoro" element={<KokoroPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="config" element={<ConfigPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
