import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { amIAdmin } from '../api/admin'

export function useAdminStatus() {
  const { token } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!token) return
    amIAdmin(token).then(setIsAdmin).finally(() => setSettled(true))
  }, [token])

  // Nothing to wait for without a token.
  return { isAdmin, loading: Boolean(token) && !settled }
}
