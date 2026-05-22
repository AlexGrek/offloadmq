import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { amIAdmin } from '../api/admin'

export function useAdminStatus() {
  const { token } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) { setLoading(false); return }
    amIAdmin(token).then(setIsAdmin).finally(() => setLoading(false))
  }, [token])

  return { isAdmin, loading }
}
