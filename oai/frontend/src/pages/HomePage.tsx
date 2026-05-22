import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function HomePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid="home-card">
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Signed in as</p>
            <p className="font-semibold" data-testid="user-login">{user?.login}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">User ID</p>
            <p className="font-mono text-xs text-muted-foreground" data-testid="user-id">{user?.id}</p>
          </div>
          <Button
            className="w-full"
            onClick={() => navigate('/app/chat')}
          >
            Open Chat
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={handleLogout}
            data-testid="logout-button"
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
