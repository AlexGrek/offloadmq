import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as authApi from '../api/auth'
import type { User } from '../api/auth'

const TOKEN_KEY = 'oai_token'

interface AuthContextValue {
  user: User | null
  token: string | null
  loading: boolean
  login: (login: string, password: string) => Promise<void>
  register: (login: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(!!localStorage.getItem(TOKEN_KEY))

  const applyToken = useCallback(async (t: string) => {
    localStorage.setItem(TOKEN_KEY, t)
    setToken(t)
    const u = await authApi.me(t)
    setUser(u)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
  }, [])

  // Restore session on mount
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY)
    if (!stored) { setLoading(false); return }
    authApi.me(stored)
      .then(u => { setUser(u); setToken(stored) })
      .catch(logout)
      .finally(() => setLoading(false))
  }, [logout])

  const login = useCallback(async (l: string, p: string) => {
    const res = await authApi.login(l, p)
    await applyToken(res.token)
  }, [applyToken])

  const register = useCallback(async (l: string, p: string) => {
    const res = await authApi.register(l, p)
    await applyToken(res.token)
  }, [applyToken])

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
