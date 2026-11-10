import { Link, useNavigate } from 'react-router-dom'
import { Activity, LogOut, Moon, Sun, User } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useWorkload } from '../contexts/WorkloadContext'
import { useTheme } from '../contexts/ThemeContext'
import { RandomNamesWidget } from './RandomNamesWidget'
import { TopApps } from './TopApps'
import { Button } from './ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { cn } from '@/lib/utils'

export function TopBar() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const { drawerOpen, toggleDrawer, runningImageJobs, runningDescribeJobs, runningImgUtilsJobs } =
    useProgress()
  const { runningChatTasks } = useWorkload()
  const navigate = useNavigate()

  const runningCount =
    runningChatTasks.length +
    runningImageJobs.length +
    runningDescribeJobs.length +
    runningImgUtilsJobs.length

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
      <div className="flex min-w-0 items-center">
        <Link to="/app/dashboard" className="font-display select-none text-xl font-bold tracking-tight">
          oai
        </Link>
        <TopApps />
      </div>
      <div className="flex items-center gap-1">
        <RandomNamesWidget />
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
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <span className="hidden px-2 text-sm text-muted-foreground sm:block">{user?.login}</span>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/app/settings" aria-label="My Account" title="My Account">
            <User className="h-4 w-4" />
            <span className="ml-1.5 hidden sm:inline">My Account</span>
          </Link>
        </Button>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Sign out" title="Sign out" data-testid="sign-out-button">
              <LogOut className="h-4 w-4" />
              <span className="ml-1.5 hidden sm:inline">Sign out</span>
            </Button>
          </DialogTrigger>
          <DialogContent data-testid="sign-out-dialog">
            <DialogHeader>
              <DialogTitle>Sign out?</DialogTitle>
              <DialogDescription>Are you sure you want to sign out of OAI?</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" className="min-h-11">Cancel</Button>
              </DialogClose>
              <Button className="min-h-11" onClick={handleLogout} data-testid="sign-out-confirm">
                Sign out
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </header>
  )
}
