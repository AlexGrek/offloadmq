import { Link, Navigate } from 'react-router-dom'
import { Bot, Sparkles, ScanSearch, ArrowRight, Zap } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '@/components/ui/button'

const features = [
  {
    icon: Bot,
    title: 'LLM Chat',
    description:
      'Converse with state-of-the-art language models in real time. Stream responses, maintain context, and get intelligent answers instantly.',
  },
  {
    icon: Sparkles,
    title: 'Image Generation',
    description:
      'Transform text prompts into stunning visuals using powerful diffusion models running on dedicated GPU nodes.',
  },
  {
    icon: ScanSearch,
    title: 'Image Analysis',
    description:
      'Upload any image and get instant AI-powered insights, captions, and detailed analysis from vision models.',
  },
]

export default function LandingPage() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
      </div>
    )
  }

  if (user) return <Navigate to="/dashboard" replace />

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="font-display text-2xl font-bold tracking-tight">oai</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="text-zinc-400 hover:bg-white/10 hover:text-white"
          >
            <Link to="/login">Sign in</Link>
          </Button>
          <Button
            size="sm"
            asChild
            className="bg-white text-zinc-950 hover:bg-zinc-200 font-semibold"
          >
            <Link to="/register">Get started</Link>
          </Button>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative mx-auto flex max-w-4xl flex-col items-center px-6 pb-28 pt-20 text-center">
        {/* dot grid background */}
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle,rgba(255,255,255,0.055)_1px,transparent_1px)] [background-size:28px_28px]" />

        {/* badge */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-sm text-zinc-300">
          <Zap className="h-3.5 w-3.5 text-yellow-400" />
          Powered by OffloadMQ
        </div>

        <h1 className="mb-6 font-display text-5xl font-extrabold leading-[1.06] tracking-tight sm:text-6xl md:text-7xl">
          <span className="bg-gradient-to-b from-white to-zinc-400 bg-clip-text text-transparent">
            AI that works
          </span>
          <br />
          <span className="bg-gradient-to-b from-white to-zinc-500 bg-clip-text text-transparent">
            for you
          </span>
        </h1>

        <p className="mb-10 max-w-2xl text-lg leading-relaxed text-zinc-400">
          Chat with language models, generate images, and analyze visuals — all through a fast,
          unified interface built on distributed AI infrastructure.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <Button
            size="lg"
            asChild
            className="bg-white font-semibold text-zinc-950 hover:bg-zinc-200"
          >
            <Link to="/register">
              Get started free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            asChild
            className="border-white/20 text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-6 pb-24">
        <div className="grid gap-5 sm:grid-cols-3">
          {features.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="group rounded-2xl border border-white/10 bg-white/5 p-6 transition-colors hover:bg-white/[0.08]"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                <Icon className="h-5 w-5 text-white" />
              </div>
              <h3 className="mb-2 font-display text-lg font-semibold">{title}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 py-8 text-center text-sm text-zinc-600">
        oai &copy; 2025
      </footer>
    </div>
  )
}
