import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PromptTextarea } from '@/components/PromptTextarea'
import { MarkdownContent } from '@/components/MarkdownContent'
import { CodeEditor } from '@/components/langgraph/CodeEditor'
import { ToolDebugHeaderButton, ToolDebugModal } from '@/components/ToolDebugModal'
import { defaultRequest } from '@/lib/langgraph/defaults'
import { isListedCapability } from '@/lib/capability-picker'
import * as api from '@/api/langgraph'

type Tab = 'main.py' | 'tools.py' | 'pyproject.toml' | 'Resources' | 'Output'
type Role = { role: string; model: string }
type Draft = { request: api.LanggraphRequest; resources: string; output: string; roles: Role[] }
function newDraft(): Draft {
  const request = defaultRequest()
  return { request, resources: '{}', output: JSON.stringify(request.output, null, 2), roles: [] }
}
function fromRequest(request: api.LanggraphRequest): Draft {
  return { request, resources: JSON.stringify(request.resources, null, 2), output: JSON.stringify(request.output, null, 2), roles: Object.entries(request.models).map(([role, model]) => ({ role, model })) }
}
function restore(key: string): Draft {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null
    if (draft && typeof draft.request.main_py === 'string' && typeof draft.request.pyproject === 'string' && Array.isArray(draft.roles)) return draft
  } catch { /* A damaged draft must not prevent opening the app. */ }
  return newDraft()
}
const selectClass = 'min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm'
const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export default function LanggraphPage() {
  const { user } = useAuth()
  return <LanggraphWorkspace key={user?.id ?? 'anonymous'} storageKey={`oai_langgraph_draft_${user?.id}`} />
}
function LanggraphWorkspace({ storageKey }: { storageKey: string }) {
  const { token } = useAuth()
  const [search, setSearch] = useSearchParams()
  const active = search.get('job') ?? 'new'
  const [draft, setDraft] = useState(() => restore(storageKey))
  const [tab, setTab] = useState<Tab>('main.py')
  const [caps, setCaps] = useState<api.RuntimeCapability[]>([])
  const [jobs, setJobs] = useState<api.LanggraphSummary[]>([])
  const [job, setJob] = useState<api.LanggraphJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debug, setDebug] = useState(false)
  const current = useRef(active)
  const latestDraft = useRef(draft)
  useEffect(() => { current.current = active }, [active])
  const request = draft.request
  const update = (patch: Partial<api.LanggraphRequest>) => setDraft(d => ({ ...d, request: { ...d.request, ...patch } }))
  const open = (id: string) => { setError(null); setDebug(false); setSearch(id === 'new' ? {} : { job: id }) }
  const refresh = useCallback(async () => {
    if (!token) return
    const [capabilities, history] = await Promise.all([api.listRuntimeCapabilities(token), api.listLanggraphJobs(token)])
    setCaps(capabilities); setJobs(history)
  }, [token])
  useEffect(() => {
    let disposed = false
    if (token) {
      Promise.all([api.listRuntimeCapabilities(token), api.listLanggraphJobs(token)]).then(([capabilities, history]) => {
        if (disposed) return
        setCaps(capabilities); setJobs(history)
        setDraft(d => d.request.capability ? d : { ...d, request: { ...d.request, capability: capabilities[0]?.base ?? '' } })
      }).catch(e => { if (!disposed) setError(message(e)) })
    }
    return () => { disposed = true }
  }, [token])
  useEffect(() => { latestDraft.current = draft }, [draft])
  useEffect(() => {
    const save = () => {
      try { localStorage.setItem(storageKey, JSON.stringify(latestDraft.current)) } catch { /* Storage may be full or disabled. */ }
    }
    const timer = setTimeout(save, 400)
    window.addEventListener('pagehide', save)
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', save) }
  }, [draft, storageKey])
  useEffect(() => () => {
    try { localStorage.setItem(storageKey, JSON.stringify(latestDraft.current)) } catch { /* Storage may be unavailable. */ }
  }, [storageKey])
  useEffect(() => {
    if (!token || active === 'new') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load(poll = false) {
      try {
        const result = await (poll ? api.pollLanggraphJob(token!, active, controller.signal) : api.getLanggraphJob(token!, active, controller.signal))
        if (controller.signal.aborted) return
        setJob(result)
        setJobs(list => list.map(j => j.job_id === result.job_id ? result : j))
        if (!api.terminal(result.status)) timer = setTimeout(() => void load(true), 3000)
      } catch (e) {
        if (!controller.signal.aborted) { setError(message(e)); timer = setTimeout(() => void load(true), 6000) }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, active])
  const displayedJob = job?.job_id === active ? job : null
  const rolesAvailable = draft.roles.every(r => r.role.trim() && caps.some(c => c.base === `llm-runtime.${r.model}`))
  const ready = isListedCapability(request.capability, caps) && rolesAvailable
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(null)
    try { await work() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function submit() {
    if (!token || !ready) return
    await action(async () => {
      const roles = draft.roles.map(r => r.role.trim())
      if (new Set(roles).size !== roles.length) throw new Error('Model role names must be unique')
      const output = JSON.parse(draft.output)
      if (!output || typeof output !== 'object' || Array.isArray(output) || !Array.isArray(output.files)) throw new Error('Output must be an object with a files array')
      const payload = { ...request, models: Object.fromEntries(draft.roles.map(r => [r.role.trim(), r.model])), resources: JSON.parse(draft.resources), output }
      const result = await api.startLanggraphJob(token, payload)
      open(result.job_id)
      await refresh()
    })
  }
  const edit = () => {
    if (!displayedJob) return
    setDraft(fromRequest(displayedJob.request)); setTab('main.py'); open('new')
  }
  const codeValue = tab === 'main.py' ? request.main_py : tab === 'tools.py' ? request.tools_py : tab === 'pyproject.toml' ? request.pyproject : tab === 'Resources' ? draft.resources : draft.output
  function changeCode(value: string) {
    if (tab === 'main.py') update({ main_py: value })
    else if (tab === 'tools.py') update({ tools_py: value })
    else if (tab === 'pyproject.toml') update({ pyproject: value })
    else setDraft(d => ({ ...d, [tab === 'Resources' ? 'resources' : 'output']: value }))
  }
  return <main className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row" data-testid="langgraph-page">
    <aside className="flex shrink-0 flex-col border-b border-border md:w-60 md:border-r md:border-b-0" aria-label="LangGraph run history">
      <div className="flex shrink-0 items-center gap-2 p-3">
        <Button onClick={() => open('new')} className="min-h-11 flex-1" data-testid="langgraph-new"><Plus className="size-4" />New run</Button>
        <Button variant="ghost" size="icon" aria-label="Refresh models and history" onClick={() => void action(refresh)} disabled={busy}><RefreshCw className="size-4" /></Button>
      </div>
      <div className="flex max-h-28 min-h-0 gap-2 overflow-auto px-3 pb-3 md:max-h-none md:flex-1 md:flex-col" data-testid="langgraph-history">
        {jobs.map(j => <button key={j.job_id} onClick={() => open(j.job_id)} className={`min-w-36 rounded-lg p-3 text-left text-sm md:min-w-0 ${active === j.job_id ? 'bg-muted' : 'bg-muted/30 hover:bg-muted/60'}`}>
          <span className="block truncate">{j.prompt || 'Python run'}</span><span className="block text-xs text-muted-foreground">{j.status} · {j.capability.replace('llm-runtime.', '')}</span>
        </button>)}
        {jobs.length === 0 && <p className="text-xs text-muted-foreground">No runs yet.</p>}
      </div>
    </aside>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-5">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex items-center justify-between gap-3"><div><h1 className="font-display text-2xl font-bold">LangGraph</h1><p className="text-sm text-muted-foreground">Build a Python graph and run it with local LLMs.</p></div>
          {displayedJob && <ToolDebugHeaderButton onClick={() => setDebug(true)} active={!!displayedJob.offload_task_id} disabled={!displayedJob.offload_task_id} />}
        </header>
        {error && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="langgraph-error">{error}</p>}
        {active === 'new' ? <section className="space-y-5" data-testid="langgraph-new-panel">
          <p className="text-sm text-muted-foreground">Python runs with the runner account’s permissions. Only explicitly enabled runtime runners accept these jobs.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">Primary model<select aria-label="Primary model" className={selectClass} value={request.capability} onChange={e => update({ capability: e.target.value })} data-testid="langgraph-model">
              <option value="">Choose a runtime model</option>{request.capability && !isListedCapability(request.capability, caps) && <option value={request.capability} disabled>{request.capability.replace('llm-runtime.', '')} (unavailable)</option>}
              {caps.map(c => <option key={c.base} value={c.base}>{c.base.replace('llm-runtime.', '')}</option>)}
            </select></label>
            <label className="space-y-1 text-sm">Runtime limit (seconds)<Input aria-label="Runtime limit (seconds)" type="number" min={1} max={3600} value={request.runtime_secs} onChange={e => update({ runtime_secs: Number(e.target.value) })} className="min-h-11" /></label>
          </div>
          {caps.length === 0 && <p className="text-sm text-muted-foreground" data-testid="langgraph-no-models">No enabled runtime models are online. Enable LLM runtime and approve each model on a runner, then refresh.</p>}
          <div className="space-y-2">
            <div className="flex items-center justify-between"><span className="text-sm font-medium">Named model roles</span><Button variant="ghost" onClick={() => setDraft(d => ({ ...d, roles: [...d.roles, { role: '', model: caps[0]?.base.replace('llm-runtime.', '') ?? '' }] }))} disabled={draft.roles.length >= 16} className="min-h-11">Add model role</Button></div>
            {draft.roles.map((r, i) => <div key={i} className="flex items-center gap-2">
              <Input aria-label={`Role ${i + 1} name`} placeholder="critic" value={r.role} onChange={e => setDraft(d => ({ ...d, roles: d.roles.map((row, index) => index === i ? { ...row, role: e.target.value } : row) }))} className="min-h-11 min-w-0 flex-1" />
              <select aria-label={`Role ${i + 1} model`} value={r.model} className={`${selectClass} min-w-0 flex-1`} onChange={e => setDraft(d => ({ ...d, roles: d.roles.map((row, index) => index === i ? { ...row, model: e.target.value } : row) }))}>
                <option value="">Choose model</option>{r.model && !caps.some(c => c.base === `llm-runtime.${r.model}`) && <option value={r.model} disabled>{r.model} (unavailable)</option>}{caps.map(c => <option key={c.base} value={c.base.replace('llm-runtime.', '')}>{c.base.replace('llm-runtime.', '')}</option>)}
              </select>
              <Button variant="ghost" size="icon" aria-label={`Remove role ${i + 1}`} onClick={() => setDraft(d => ({ ...d, roles: d.roles.filter((_, index) => index !== i) }))}><Trash2 className="size-4" /></Button>
            </div>)}
            {draft.roles.length > 0 && <p className="text-xs text-muted-foreground">All selected models must be enabled on the same runner. Use local_llm("role") in main.py.</p>}
          </div>
          <div className="space-y-2">
            <div role="tablist" aria-label="Program files" className="flex gap-1 overflow-x-auto">{(['main.py', 'tools.py', 'pyproject.toml', 'Resources', 'Output'] as Tab[]).map(t => <Button key={t} role="tab" aria-selected={tab === t} aria-controls="langgraph-editor-panel" variant={tab === t ? 'secondary' : 'ghost'} onClick={() => setTab(t)} className="min-h-11 shrink-0">{t}</Button>)}</div>
            <div role="tabpanel" id="langgraph-editor-panel" aria-label={tab}><CodeEditor key={tab} value={codeValue} onChange={changeCode} label={`${tab} editor`} language={tab.endsWith('.py') ? 'python' : tab.endsWith('.toml') ? 'toml' : 'json'} /></div>
            <p className="text-xs text-muted-foreground">{tab === 'pyproject.toml' ? 'Dependencies use [project].dependencies. Python 3.11; uv sync refreshes the environment on every run. uv settings, build systems, groups and extras are unsupported.' : tab === 'Resources' ? 'JSON passed to your app as request["resources"].' : tab === 'Output' ? 'Declare a JSON data_file and a files array of relative paths. Your code must write every declared output.' : 'Tab indents; Escape then Tab moves focus out of the editor. The default dummy tool is in tools.py.'}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="space-y-1 text-sm">System prompt<PromptTextarea value={request.system_prompt} onChange={system_prompt => update({ system_prompt })} bucket="langgraph-system" token={token} data-testid="langgraph-system-prompt" rows={5} /></label>
            <label className="space-y-1 text-sm">User prompt<PromptTextarea value={request.user_prompt} onChange={user_prompt => update({ user_prompt })} bucket="langgraph-user" token={token} data-testid="langgraph-user-prompt" rows={5} /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">Allowed tools<select aria-label="Allowed tools" className={selectClass} value={request.allowed_tools === null ? 'all' : request.allowed_tools.length === 0 ? 'none' : 'listed'} onChange={e => update({ allowed_tools: e.target.value === 'all' ? null : e.target.value === 'none' ? [] : ['dummy_tool'] })}><option value="all">All exposed tools</option><option value="none">No tools</option><option value="listed">Named tools only</option></select></label>
            {request.allowed_tools !== null && request.allowed_tools.length > 0 && <label className="space-y-1 text-sm">Tool names (comma-separated)<Input aria-label="Tool names" value={request.allowed_tools.join(', ')} onChange={e => update({ allowed_tools: e.target.value.split(',').map(s => s.trim()) })} className="min-h-11" /></label>}
          </div>
          <div className="flex flex-wrap gap-3"><Button onClick={() => void submit()} disabled={busy || !ready || !request.main_py.trim()} className="min-h-11 w-full sm:w-auto" data-testid="langgraph-run">{busy ? 'Submitting…' : 'Run graph'}</Button><Button variant="ghost" onClick={() => { setDraft(newDraft()); setTab('main.py') }} disabled={busy} className="min-h-11">Reset draft</Button></div>
        </section> : displayedJob ? <section className="space-y-5" data-testid="langgraph-job-detail">
          <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-muted px-3 py-1 text-sm" data-testid="langgraph-status">{displayedJob.status}</span><span className="text-sm text-muted-foreground">{displayedJob.stage ?? displayedJob.capability.replace('llm-runtime.', '')}</span></div>
          {displayedJob.error && <p className="text-sm text-destructive" role="alert">{displayedJob.error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={edit} className="min-h-11">Edit as new run</Button>
            {!api.terminal(displayedJob.status) && <Button variant="outline" disabled={busy} onClick={() => void action(async () => { await api.cancelLanggraphJob(token!, active); const value = await api.pollLanggraphJob(token!, active); if (current.current === active) setJob(value); await refresh() })} className="min-h-11">Cancel run</Button>}
            {['failed', 'canceled'].includes(displayedJob.status) && <Button disabled={busy} onClick={() => void action(async () => { const result = await api.retryLanggraphJob(token!, active); await refresh(); open(result.job_id) })} className="min-h-11">Retry run</Button>}
            <Button variant="ghost" disabled={busy} onClick={() => void action(async () => { const value = await api.pollLanggraphJob(token!, active); if (current.current === active) setJob(value); await refresh() })} className="min-h-11">Poll now</Button>
            {api.terminal(displayedJob.status) && <Button variant="ghost" disabled={busy} onClick={() => void action(async () => { await api.deleteLanggraphJob(token!, active); await refresh(); open('new') })} className="min-h-11">Delete run</Button>}
          </div>
          {displayedJob.result && <div className="space-y-5" data-testid="langgraph-result">
            <div><h2 className="mb-2 font-display text-lg font-semibold">LLM output</h2><MarkdownContent>{String(displayedJob.result.text ?? displayedJob.result.stdout ?? '')}</MarkdownContent></div>
            {(['stdout', 'stderr', 'sync_stdout', 'sync_stderr'] as const).map(field => typeof displayedJob.result?.[field] === 'string' && displayedJob.result[field] !== '' && <details key={field} open={field === 'stderr'}><summary className="cursor-pointer text-sm font-medium">{field}</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">{String(displayedJob.result[field])}</pre></details>)}
            {'data' in displayedJob.result && <div><h2 className="mb-2 font-display text-lg font-semibold">Structured data</h2><pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs" data-testid="langgraph-data">{JSON.stringify(displayedJob.result.data, null, 2)}</pre></div>}
            <p className="text-xs text-muted-foreground">Exit code: {String(displayedJob.result.return_code ?? '—')}</p>
          </div>}
          {displayedJob.artifacts.map((file, i) => <a key={i} href={api.langgraphArtifactUrl(token!, active, i)} download={file.filename} className="block text-sm underline">Download {file.filename} ({file.size_bytes.toLocaleString()} bytes)</a>)}
          <details><summary className="cursor-pointer text-sm font-medium">Saved code and inputs</summary><div className="mt-3 space-y-3">
            <p className="whitespace-pre-wrap text-sm">System: {displayedJob.request.system_prompt}</p><p className="whitespace-pre-wrap text-sm">User: {displayedJob.request.user_prompt}</p>
            <pre className="overflow-auto text-xs">{JSON.stringify({ models: displayedJob.request.models, allowed_tools: displayedJob.request.allowed_tools, resources: displayedJob.request.resources, output: displayedJob.request.output, runtime_secs: displayedJob.request.runtime_secs }, null, 2)}</pre>
            {(['main_py', 'tools_py', 'pyproject'] as const).map(field => <div key={field}><h3 className="mb-1 text-sm font-medium">{field === 'main_py' ? 'main.py' : field === 'tools_py' ? 'tools.py' : 'pyproject.toml'}</h3><CodeEditor value={displayedJob.request[field]} readOnly label={`Saved ${field}`} language={field === 'pyproject' ? 'toml' : 'python'} /></div>)}
          </div></details>
        </section> : <p className="text-sm text-muted-foreground">Loading run…</p>}
      </div>
    </div>
    {displayedJob && <ToolDebugModal open={debug} onOpenChange={setDebug} cap={displayedJob.offload_cap} taskId={displayedJob.offload_task_id} subject={`LangGraph run ${active}`} />}
  </main>
}
