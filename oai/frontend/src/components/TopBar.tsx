import { Link, useNavigate } from 'react-router-dom'
import { LogOut, Moon, Sun, User } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { Button } from './ui/button'

export function TopBar() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()

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
