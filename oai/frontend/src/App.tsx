import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { RequireAuth } from './components/RequireAuth'
import { AppShell } from './components/AppShell'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import LandingPage from './pages/LandingPage'
import DashboardPage from './pages/DashboardPage'
import ChatPage from './pages/ChatPage'
import ImageGenerationPage from './pages/ImageGenerationPage'
import DescribeImagePage from './pages/DescribeImagePage'
import TtsPage from './pages/TtsPage'
import FilesPage from './pages/FilesPage'
import SettingsPage from './pages/SettingsPage'
import ServerConfigPage from './pages/ServerConfigPage'
import ImageWorkerLogsPage from './pages/ImageWorkerLogsPage'
import DiagnosticsPage from './pages/DiagnosticsPage'
import './App.css'

export default function App() {
  return (
    <ThemeProvider>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route
            path="/app"
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="images" element={<ImageGenerationPage />} />
            <Route path="describe" element={<DescribeImagePage />} />
            <Route path="tts" element={<TtsPage />} />
            <Route path="files" element={<FilesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/server" element={<ServerConfigPage />} />
            <Route path="settings/worker-logs" element={<ImageWorkerLogsPage />} />
            <Route path="settings/diagnostics" element={<DiagnosticsPage />} />
          </Route>

          {/* Legacy paths */}
          <Route path="/dashboard" element={<Navigate to="/app/dashboard" replace />} />
          <Route path="/chat" element={<Navigate to="/app/chat" replace />} />
          <Route path="/images" element={<Navigate to="/app/images" replace />} />
          <Route path="/files" element={<Navigate to="/app/files" replace />} />
          <Route path="/settings" element={<Navigate to="/app/settings" replace />} />
          <Route path="/settings/server" element={<Navigate to="/app/settings/server" replace />} />
          <Route path="/settings/worker-logs" element={<Navigate to="/app/settings/worker-logs" replace />} />
          <Route path="/settings/diagnostics" element={<Navigate to="/app/settings/diagnostics" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
    </ThemeProvider>
  )
}
