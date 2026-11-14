import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useResetOnChange } from '@/hooks/useResetOnChange'
import { Camera, Loader2, MessageCircle, Plus, UserRound, VenetianMask } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '../contexts/AuthContext'
import { imageThumbnailUrl } from '../api/images'
import {
  EMPTY_PERSONA,
  createPersona,
  deletePersona,
  getPersona,
  getPersonaModelOptions,
  listPersonas,
  personaInputFrom,
  updatePersona,
  type ModelOptions,
  type Persona,
  type PersonaImageRef,
  type PersonaInput,
} from '../api/personas'
import { PersonaProfile } from '../components/personas/PersonaProfile'
import { PersonaPhotos } from '../components/personas/PersonaPhotos'
import { ChatWorkspace } from '../components/chat/ChatWorkspace'
import { SystemPromptBlock } from '../components/chat/SystemPromptBlock'

type Tab = 'profile' | 'chat' | 'photos'
const TABS: { id: Tab; label: string; icon: typeof UserRound }[] = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'photos', label: 'Photos', icon: Camera },
]
const NEW = 'new'

/** `/app/personas/:personaId?/:tab?` — persona list + Profile / Chat / Photos. */
export default function PersonasPage() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const params = useParams()
  const selectedId = params.personaId ?? null
  const tab: Tab = (TABS.some(t => t.id === params.tab) ? params.tab : 'profile') as Tab

  const [personas, setPersonas] = useState<Persona[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [detail, setDetail] = useState<Persona | null>(null)
  const [draft, setDraft] = useState<PersonaInput>(EMPTY_PERSONA)
  const [faceRefs, setFaceRefs] = useState<Record<string, PersonaImageRef>>({})
  const [options, setOptions] = useState<ModelOptions | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const go = useCallback(
    (id: string | null, t: Tab = 'profile') => navigate(id ? `/app/personas/${id}/${t}` : '/app/personas'),
    [navigate],
  )

  const reloadList = useCallback(() => {
    if (!token) return
    listPersonas(token)
      .then(setPersonas)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoadingList(false))
  }, [token])

  useEffect(reloadList, [reloadList])
  useEffect(() => {
    if (token) getPersonaModelOptions(token).then(setOptions).catch(console.error)
  }, [token])

  // Open the first persona (or the new form) when none is selected.
  useEffect(() => {
    if (loadingList || selectedId) return
    navigate(personas[0] ? `/app/personas/${personas[0].id}/profile` : `/app/personas/${NEW}`, { replace: true })
  }, [loadingList, selectedId, personas, navigate])

  // Switching persona: show what the list already knows, then load the detail.
  useResetOnChange(selectedId, id => {
    setError(null)
    if (id === NEW) {
      setDetail(null)
      setDraft(EMPTY_PERSONA)
      return
    }
    const listed = personas.find(p => p.id === id)
    if (listed) {
      setDetail(listed)
      setDraft(personaInputFrom(listed))
    }
  })
  useEffect(() => {
    if (!token || !selectedId || selectedId === NEW) return
    let cancelled = false
    getPersona(token, selectedId)
      .then(p => {
        if (cancelled) return
        setDetail(p)
        setDraft(personaInputFrom(p))
      })
      .catch(e => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [token, selectedId])

  const allFaceRefs = useMemo(() => {
    const refs: Record<string, PersonaImageRef> = { ...faceRefs }
    for (const f of detail?.faces ?? []) refs[f.image_id] = f
    return refs
  }, [faceRefs, detail])

  const dirty = useMemo(
    () => !detail || JSON.stringify(personaInputFrom(detail)) !== JSON.stringify(draft),
    [detail, draft],
  )

  async function save() {
    if (!token) return
    setSaving(true)
    setError(null)
    try {
      if (detail) {
        await updatePersona(token, detail.id, draft)
        const fresh = await getPersona(token, detail.id)
        setDetail(fresh)
        setDraft(personaInputFrom(fresh))
        reloadList()
      } else {
        const created = await createPersona(token, draft)
        reloadList()
        go(created.id)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!token || !detail) return
    if (!window.confirm(`Delete ${detail.name}? Its chats and photo history go too; generated images stay in your library.`)) return
    try {
      await deletePersona(token, detail.id)
      setPersonas(prev => prev.filter(p => p.id !== detail.id))
      go(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const chatPersona = useMemo(
    () =>
      detail
        ? {
            id: detail.id,
            name: detail.name,
            renderedSystemPrompt: detail.rendered_system_prompt,
            defaultModel: detail.effective?.llm?.capability ?? detail.llm_capability,
            emptyState: (
              <div className="flex flex-col gap-4" data-testid="persona-chat-empty">
                <div className="flex items-center gap-3">
                  <Avatar token={token} persona={detail} className="size-12" />
                  <div>
                    <p className="font-display text-lg font-semibold">{detail.name}</p>
                    <p className="text-sm text-muted-foreground">Say hello — the persona answers in character.</p>
                  </div>
                </div>
                <SystemPromptBlock content={detail.rendered_system_prompt} />
              </div>
            ),
          }
        : null,
    [detail, token],
  )

  if (!token) return null
  const isNew = selectedId === NEW

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="personas-page">
      {/* Persona list: sidebar on md+, chip row on phones. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border md:flex" data-testid="personas-sidebar">
        <div className="shrink-0 p-3">
          <button
            type="button"
            onClick={() => go(NEW)}
            className={cn(
              'flex min-h-10 w-full items-center gap-2 rounded-full px-3 text-sm font-medium transition-colors',
              isNew ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70',
            )}
            data-testid="persona-new"
          >
            <Plus className="size-4" /> New persona
          </button>
        </div>
        <ul className="min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain px-2 pb-3">
          {loadingList && <li className="px-2 py-1 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /></li>}
          {personas.map(p => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => go(p.id, tab)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                  p.id === selectedId ? 'bg-muted font-medium' : 'hover:bg-muted/50',
                )}
                data-testid={`persona-item-${p.id}`}
              >
                <Avatar token={token} persona={p} className="size-8" />
                <span className="min-w-0 truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-3 py-2 md:hidden" data-testid="personas-chips">
          <button type="button" onClick={() => go(NEW)} className={cn('shrink-0 rounded-full px-3 py-1.5 text-sm', isNew ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
            <Plus className="inline size-3.5" /> New
          </button>
          {personas.map(p => (
            <button key={p.id} type="button" onClick={() => go(p.id, tab)} className={cn('shrink-0 rounded-full px-3 py-1.5 text-sm', p.id === selectedId ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
              {p.name}
            </button>
          ))}
        </div>

        {!isNew && detail && (
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 sm:px-6" data-testid="persona-header">
            <Avatar token={token} persona={detail} className="hidden size-9 sm:block" />
            <h1 className="min-w-0 truncate font-display text-lg font-semibold">{detail.name}</h1>
            <nav className="ml-auto flex gap-1" role="tablist">
              {TABS.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => go(detail.id, t.id)}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors',
                    tab === t.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                  data-testid={`persona-tab-${t.id}`}
                >
                  <t.icon className="size-4" />
                  <span className="hidden sm:inline">{t.label}</span>
                </button>
              ))}
            </nav>
          </div>
        )}

        {tab === 'chat' && chatPersona && !isNew ? (
          <ChatWorkspace key={chatPersona.id} kind="persona" persona={chatPersona} />
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-3xl px-3 py-4 sm:px-6 sm:py-5">
              {isNew && (
                <h1 className="mb-5 flex items-center gap-2 font-display text-xl font-semibold">
                  <VenetianMask className="size-5" /> New persona
                </h1>
              )}
              {tab === 'photos' && detail && !isNew ? (
                <PersonaPhotos token={token} persona={detail} />
              ) : (isNew || detail) ? (
                <PersonaProfile
                  token={token}
                  personaId={detail?.id ?? null}
                  value={draft}
                  onChange={setDraft}
                  faceRefs={allFaceRefs}
                  onFaceRefs={refs => setFaceRefs(prev => ({ ...prev, ...Object.fromEntries(refs.map(r => [r.image_id, r])) }))}
                  options={options}
                  effective={detail?.effective}
                  saving={saving}
                  dirty={dirty}
                  error={error}
                  onSave={() => void save()}
                  onDelete={detail ? () => void remove() : undefined}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{error ?? 'Loading…'}</p>
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  )
}

function Avatar({ token, persona, className }: { token: string | null; persona: Persona; className?: string }) {
  const face = persona.faces[0]
  return face ? (
    <img src={imageThumbnailUrl(face.image_id, token)} alt="" className={cn('shrink-0 rounded-full object-cover', className)} />
  ) : (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground', className)}>
      {persona.name.slice(0, 1).toUpperCase()}
    </span>
  )
}
