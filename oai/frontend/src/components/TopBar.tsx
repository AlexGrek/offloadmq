import { Link, useNavigate } from 'react-router-dom'
import { Activity, LogOut, Moon, Sun, User } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useWorkload } from '../contexts/WorkloadContext'
import { useTheme } from '../contexts/ThemeContext'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'

export function TopBar() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const { drawerOpen, toggleDrawer, runningImageJobs } = useProgress()
  const { runningChatTasks } = useWorkload()
  const navigate = useNavigate()

  const runningCount = runningChatTasks.length + runningImageJobs.length

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
      <Link to="/app/dashboard" className="font-display select-none text-xl font-bold tracking-tight">
        oai
      </Link>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDrawer}
          aria-pressed={drawerOpen}
          aria-label={drawerOpen ? 'Close progress panel' : 'Open progress panel'}
          title={drawerOpen ? 'Progress — click to close' : 'Progress — running jobs across chat and images'}
          data-testid="progress-toggle"
          className={cn(drawerOpen && 'text-violet-600 dark:text-violet-400')}
        >
          <Activity className="h-4 w-4" />
          <span className="ml-1.5 hidden sm:inline">Progress</span>
          {runningCount > 0 && (
            <span className="ml-1.5 rounded-full bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-violet-700 dark:text-violet-300">
              {runningCount}
            </span>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <span className="hidden px-2 text-sm text-muted-foreground sm:block">{user?.login}</span>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/app/settings">
            <User className="h-4 w-4" />
            <span className="ml-1.5 hidden sm:inline">My Account</span>
          </Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          <span className="ml-1.5 hidden sm:inline">Sign out</span>
        </Button>
      </div>
    </header>
  )
}
