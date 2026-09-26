import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../contexts/AuthContext'
import { apps } from '../lib/apps'
import { useMorph } from '../lib/motion'

const MotionLink = motion.create(Link)
/** Gap between consecutive tiles appearing — quick enough that the whole grid lands in well under a second. */
const TILE_STAGGER_S = 0.04

export default function DashboardPage() {
  const { user } = useAuth()
  const morph = useMorph()

  return (
    <main
      className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto overscroll-contain p-6"
      data-testid="dashboard-page"
    >
        <div className="mb-8">
          <h1 className="font-display text-2xl font-bold">
            Welcome back{user?.login ? `, ${user.login}` : ''}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">What would you like to do today?</p>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {apps.map((app, i) => (
            <MotionLink
              key={app.id}
              to={app.href}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={morph.reduced ? { duration: 0 } : { delay: i * TILE_STAGGER_S, duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className={`group flex flex-col gap-3 rounded-2xl border border-border bg-gradient-to-br ${app.gradient} p-5 transition-[box-shadow,border-color] hover:shadow-md hover:border-border/60`}
            >
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${app.iconBg}`}>
                <app.icon className={`h-6 w-6 ${app.iconColor}`} />
              </div>
              <div>
                <p className="font-semibold text-sm">{app.title}</p>
                <p className="text-xs text-muted-foreground">{app.description}</p>
              </div>
            </MotionLink>
          ))}
        </div>
    </main>
  )
}
