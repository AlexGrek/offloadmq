import { Link } from 'react-router-dom'
import { Activity, Bot, Eye, FolderOpen, GitCompareArrows, ImagePlus, MessageCircleMore, Music, ShieldAlert, Volume2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

const apps = [
  {
    id: 'llm-compare',
    icon: GitCompareArrows,
    title: 'LLM Compare',
    description: 'Run the same prompt on multiple models in parallel',
    href: '/app/llm-compare',
    gradient: 'from-sky-500/20 to-indigo-500/20',
    iconBg: 'bg-sky-500/20',
    iconColor: 'text-sky-400',
  },
  {
    id: 'llm-debate',
    icon: MessageCircleMore,
    title: 'LLM Debate',
    description: 'Two models debate turn by turn with an optional referee',
    href: '/app/llm-debate',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    iconBg: 'bg-emerald-500/20',
    iconColor: 'text-emerald-400',
  },
  {
    id: 'chat',
    icon: Bot,
    title: 'LLM Chat',
    description: 'Chat with AI models',
    href: '/app/chat',
    gradient: 'from-indigo-500/20 to-violet-500/20',
    iconBg: 'bg-indigo-500/20',
    iconColor: 'text-indigo-400',
  },
  {
    id: 'image-generation',
    icon: ImagePlus,
    title: 'Image Generation',
    description: 'Txt2Img and Img2Img with tracked pipeline',
    href: '/app/images',
    gradient: 'from-emerald-500/20 to-cyan-500/20',
    iconBg: 'bg-emerald-500/20',
    iconColor: 'text-emerald-400',
  },
  {
    id: 'describe',
    icon: Eye,
    title: 'Describe Image',
    description: 'Analyze images with vision AI',
    href: '/app/describe',
    gradient: 'from-sky-500/20 to-cyan-500/20',
    iconBg: 'bg-sky-500/20',
    iconColor: 'text-sky-400',
  },
  {
    id: 'nude-detect',
    icon: ShieldAlert,
    title: 'Nude Detector',
    description: 'NSFW detection with NudeNet and tunable threshold',
    href: '/app/nude-detect',
    gradient: 'from-rose-500/20 to-orange-500/20',
    iconBg: 'bg-rose-500/20',
    iconColor: 'text-rose-400',
  },
  {
    id: 'runners',
    icon: Activity,
    title: 'Runners',
    description: 'View active OffloadMQ runner nodes',
    href: '/app/runners',
    gradient: 'from-teal-500/20 to-emerald-500/20',
    iconBg: 'bg-teal-500/20',
    iconColor: 'text-teal-400',
  },
  {
    id: 'music',
    icon: Music,
    title: 'Music Generation',
    description: 'Generate music from style tags and lyrics with txt2music models',
    href: '/app/music',
    gradient: 'from-fuchsia-500/20 to-pink-500/20',
    iconBg: 'bg-fuchsia-500/20',
    iconColor: 'text-fuchsia-400',
  },
  {
    id: 'tts',
    icon: Volume2,
    title: 'Text to Speech',
    description: 'Synthesize text as audio with Kokoro and other TTS models',
    href: '/app/tts',
    gradient: 'from-violet-500/20 to-fuchsia-500/20',
    iconBg: 'bg-violet-500/20',
    iconColor: 'text-violet-400',
  },
  {
    id: 'files',
    icon: FolderOpen,
    title: 'My Files',
    description: 'Browse your uploads and generated files',
    href: '/app/files',
    gradient: 'from-amber-500/20 to-orange-500/20',
    iconBg: 'bg-amber-500/20',
    iconColor: 'text-amber-400',
  },
] as const

export default function DashboardPage() {
  const { user } = useAuth()

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
          {apps.map(app => (
            <Link
              key={app.id}
              to={app.href}
              className={`group flex flex-col gap-3 rounded-2xl border border-border bg-gradient-to-br ${app.gradient} p-5 transition-all hover:shadow-md hover:border-border/60`}
            >
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${app.iconBg}`}>
                <app.icon className={`h-6 w-6 ${app.iconColor}`} />
              </div>
              <div>
                <p className="font-semibold text-sm">{app.title}</p>
                <p className="text-xs text-muted-foreground">{app.description}</p>
              </div>
            </Link>
          ))}
        </div>
    </main>
  )
}
