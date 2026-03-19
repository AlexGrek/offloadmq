import { useCallback, useEffect, useRef, useState } from 'react'

const JSON_ACCEPT = { Accept: 'application/json' }

async function postForm(url, formData) {
  const r = await fetch(url, {
    method: 'POST',
    body: formData,
    headers: JSON_ACCEPT,
  })
  if (!r.ok) throw new Error(r.statusText)
  return r.json()
}

const TABS = [
  { id: 'status', label: 'Status' },
  { id: 'connection', label: 'Connection' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'system', label: 'System' },
  { id: 'comfyui', label: 'ComfyUI' },
]

function TabBar({ active, onChange }) {
  return (
    <div className="flex border-b border-slate-700 mb-6">
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            active === t.id
              ? 'text-indigo-400 border-b-2 border-indigo-400 -mb-px'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Dashboard() {
  const [state, setState] = useState(null)
  const [err, setErr] = useState(null)
  const [running, setRunning] = useState(false)
  const [logLines, setLogLines] = useState([])
  const logRef = useRef(null)
  const [server, setServer] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [comfyuiUrl, setComfyuiUrl] = useState('')
  const [customCap, setCustomCap] = useState('')
  const [selectedCaps, setSelectedCaps] = useState(new Set())
  const [wfName, setWfName] = useState('')
  const [wfTaskType, setWfTaskType] = useState('txt2img')
  const wfFileRef = useRef(null)
  const [activeTab, setActiveTab] = useState('status')

  const loadState = useCallback(async () => {
    try {
      const r = await fetch('/api/state')
      if (!r.ok) throw new Error(r.statusText)
      const d = await r.json()
      setState(d)
      setServer(d.server || '')
      setApiKey(d.apiKey || '')
      setComfyuiUrl(d.comfyui_url || '')
      setSelectedCaps(new Set(d.selected_caps || []))
      setErr(null)
    } catch (e) {
      setErr(String(e.message || e))
    }
  }, [])

  function run(fn) {
    fn().catch((e) => setErr(String(e.message || e)))
  }

  useEffect(() => {
    loadState()
  }, [loadState])

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const [sr, lr] = await Promise.all([
          fetch('/agent/status').then((r) => r.json()),
          fetch('/agent/logs').then((r) => r.json()),
        ])
        setRunning(!!sr.running)
        const lines = lr.lines || []
        const el = logRef.current
        const atBottom =
          el && el.scrollTop + el.clientHeight >= el.scrollHeight - 5
        setLogLines(lines)
        if (atBottom && logRef.current) {
          requestAnimationFrame(() => {
            if (logRef.current)
              logRef.current.scrollTop = logRef.current.scrollHeight
          })
        }
      } catch {
        /* ignore poll errors */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [])

  const cfgExists = state?.cfg_exists
  const allCaps = state?.all_caps || []
  const taskTypes = state?.task_types || []

  async function saveConnection(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      fd.append('server', server)
      fd.append('apiKey', apiKey)
      await postForm('/config', fd)
      loadState()
    })
  }

  async function saveCaps(action) {
    run(async () => {
      const fd = new FormData()
      selectedCaps.forEach((c) => fd.append('caps', c))
      fd.append('action', action)
      if (action === 'add') fd.append('custom_cap', customCap.trim())
      await postForm('/capabilities', fd)
      setCustomCap('')
      loadState()
    })
  }

  function toggleCap(c, on) {
    const next = new Set(selectedCaps)
    if (on) next.add(c)
    else next.delete(c)
    setSelectedCaps(next)
  }

  function setAutostart(on) {
    run(async () => {
      const fd = new FormData()
      if (on) fd.append('autostart', '1')
      await postForm('/config/autostart', fd)
      loadState()
    })
  }

  function setWinStartup(on) {
    run(async () => {
      const fd = new FormData()
      if (on) fd.append('win_startup', '1')
      await postForm('/config/win-startup', fd)
      loadState()
    })
  }

  function setMacStartup(on) {
    run(async () => {
      const fd = new FormData()
      if (on) fd.append('mac_startup', '1')
      await postForm('/config/mac-startup', fd)
      loadState()
    })
  }

  async function saveComfyui(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      fd.append('comfyui_url', comfyuiUrl)
      await postForm('/config/comfyui-url', fd)
      loadState()
    })
  }

  async function addWorkflow(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      fd.append('workflow_name', wfName.trim())
      fd.append('task_type', wfTaskType)
      const f = wfFileRef.current?.files?.[0]
      if (f) fd.append('workflow_file', f)
      await postForm('/workflows/add', fd)
      setWfName('')
      if (wfFileRef.current) wfFileRef.current.value = ''
      loadState()
    })
  }

  function deleteWorkflow(name) {
    if (!window.confirm(`Delete workflow ${name} and all its files?`)) return
    run(async () => {
      const fd = new FormData()
      fd.append('workflow_name', name)
      await postForm('/workflows/delete', fd)
      loadState()
    })
  }

  if (err && !state) {
    return (
      <div className="p-8 text-amber-400">
        <p className="font-semibold">Cannot load dashboard</p>
        <p className="mt-2 text-slate-400 text-sm">{err}</p>
        <p className="mt-4 text-slate-500 text-sm">
          Dev: run web UI on port 8080 and use Vite dev server, or run{' '}
          <code className="text-slate-400">npm run build</code> in frontend/.
        </p>
      </div>
    )
  }

  if (!state) {
    return <div className="p-8 text-slate-500">Loading...</div>
  }

  const si = state.sysinfo || {}
  const gpu = si.gpu
  const gpuStr = gpu
    ? `${gpu.vendor} ${gpu.model} (${gpu.vramMb}MB VRAM)`
    : 'None'

  return (
    <div className="p-8 max-w-[900px] mx-auto">
      <h1 className="text-xl font-bold text-slate-100 mb-6">Offload Agent</h1>

      {err && (
        <div className="mb-4 flex items-start gap-2 bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-md px-4 py-3">
          <span className="flex-1">{err}</span>
          <button
            onClick={() => setErr(null)}
            className="text-red-400 hover:text-red-200 ml-2 leading-none"
          >
            ✕
          </button>
        </div>
      )}

      <TabBar active={activeTab} onChange={setActiveTab} />

      {/* Status tab */}
      <div style={{ display: activeTab === 'status' ? 'block' : 'none' }}>
        <div className="grid grid-cols-1 gap-5">
          <div className="bg-slate-800 rounded-lg p-5">
            <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Agent
            </h2>
            <div className="text-sm mb-3">
              <span
                className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${
                  running ? 'bg-green-500 shadow-[0_0_6px_#22c55e]' : 'bg-slate-600'
                }`}
              />
              {running ? 'Running' : 'Stopped'}
            </div>
            <div className="flex flex-wrap gap-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  run(async () => {
                    await postForm('/agent/start', new FormData())
                    loadState()
                  })
                }}
              >
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-green-600 text-white text-sm font-medium hover:opacity-85"
                >
                  Start
                </button>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  run(async () => {
                    await postForm('/agent/stop', new FormData())
                    loadState()
                  })
                }}
              >
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-red-500 text-white text-sm font-medium hover:opacity-85"
                >
                  Stop
                </button>
              </form>
            </div>
            <div className="mt-3">
              {cfgExists ? (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!state.autostart}
                    onChange={(e) => setAutostart(e.target.checked)}
                    className="w-[15px] h-[15px] accent-indigo-500"
                  />
                  Autostart on launch
                </label>
              ) : (
                <label className="flex items-center gap-2 text-sm opacity-50 cursor-not-allowed">
                  <input type="checkbox" disabled className="w-[15px] h-[15px]" />
                  Autostart on launch
                  <span className="text-xs text-amber-500 ml-1">config not found</span>
                </label>
              )}
            </div>
          </div>

          <div className="bg-slate-800 rounded-lg p-5">
            <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Log
            </h2>
            <div
              ref={logRef}
              className="bg-slate-900 border border-slate-600 rounded p-3 font-mono text-xs h-60 overflow-y-auto whitespace-pre-wrap text-slate-400"
            >
              {logLines.length ? logLines.join('\n') : '-'}
            </div>
          </div>
        </div>
      </div>

      {/* Connection tab */}
      <div style={{ display: activeTab === 'connection' ? 'block' : 'none' }}>
        <div className="bg-slate-800 rounded-lg p-5">
          <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Connection
          </h2>
          <form onSubmit={saveConnection}>
            <label className="block text-xs text-slate-500 mb-1">Server URL</label>
            <input
              type="text"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="http://localhost:3069"
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 mb-3 focus:outline-none focus:border-indigo-500"
            />
            <label className="block text-xs text-slate-500 mb-1">API Key</label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ak_live_..."
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 mb-3 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="submit"
                className="px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:opacity-85"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => loadState()}
                className="px-3 py-1.5 rounded-md border border-slate-600 text-slate-500 text-xs hover:border-indigo-500 hover:text-slate-200"
              >
                Load from disk
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Capabilities tab */}
      <div style={{ display: activeTab === 'capabilities' ? 'block' : 'none' }}>
        <div className="bg-slate-800 rounded-lg p-5">
          <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Capabilities
          </h2>
          <div className="space-y-1 mb-4">
            {allCaps.map((c) => (
              <label
                key={c}
                className="flex items-center gap-2 text-sm cursor-pointer py-1"
              >
                <input
                  type="checkbox"
                  checked={selectedCaps.has(c)}
                  onChange={(e) => toggleCap(c, e.target.checked)}
                  className="w-[15px] h-[15px] accent-indigo-500"
                />
                {c}
              </label>
            ))}
          </div>
          <hr className="border-slate-700 my-3" />
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={customCap}
              onChange={(e) => setCustomCap(e.target.value)}
              placeholder="Add capability"
              className="flex-1 min-w-[120px] bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => saveCaps('add')}
              className="px-3 py-2 rounded-md bg-indigo-500 text-white text-xs font-medium hover:opacity-85"
            >
              Add
            </button>
          </div>
          <button
            type="button"
            onClick={() => saveCaps('save')}
            className="mt-3 px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:opacity-85"
          >
            Save selection
          </button>
        </div>
      </div>

      {/* System tab */}
      <div style={{ display: activeTab === 'system' ? 'block' : 'none' }}>
        <div className="grid grid-cols-1 gap-5">
          <div className="bg-slate-800 rounded-lg p-5">
            <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
              System
            </h2>
            {state.scanning ? (
              <p className="text-sm text-slate-500 italic">Scanning...</p>
            ) : Object.keys(si).length === 0 ? (
              <p className="text-sm text-slate-500 italic">No scan data yet</p>
            ) : (
              <div className="text-sm text-slate-400 leading-relaxed">
                <div>
                  {si.os} / {si.cpuArch}
                </div>
                <div>RAM: {si.totalMemoryMb}MB</div>
                <div>GPU: {gpuStr}</div>
              </div>
            )}
            <form
              className="mt-3"
              onSubmit={(e) => {
                e.preventDefault()
                run(async () => {
                  await postForm('/scan', new FormData())
                  loadState()
                })
              }}
            >
              <button
                type="submit"
                className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs font-medium hover:opacity-85"
              >
                Rescan
              </button>
            </form>
          </div>

          <div className="bg-slate-800 rounded-lg p-5">
            <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Service
            </h2>
            {state.win_startup_available && (
              <>
                <p className="text-sm text-slate-400 mb-2">
                  Launch Offload Agent when you log in to Windows.
                </p>
                {cfgExists ? (
                  <label className="flex items-center gap-2 text-sm cursor-pointer mb-4">
                    <input
                      type="checkbox"
                      checked={!!state.win_startup_enabled}
                      onChange={(e) => setWinStartup(e.target.checked)}
                      className="w-[15px] h-[15px] accent-indigo-500"
                    />
                    Start with Windows
                  </label>
                ) : (
                  <label className="flex items-center gap-2 text-sm opacity-50 mb-4">
                    <input type="checkbox" disabled className="w-[15px] h-[15px]" />
                    Start with Windows
                    <span className="text-xs text-amber-500">
                      configure server and API key first
                    </span>
                  </label>
                )}
                <hr className="border-slate-700 my-3" />
              </>
            )}
            {state.mac_startup_available && (
              <>
                <p className="text-sm text-slate-400 mb-2">
                  Launch Offload Agent when you log in to macOS.
                </p>
                {cfgExists ? (
                  <label className="flex items-center gap-2 text-sm cursor-pointer mb-4">
                    <input
                      type="checkbox"
                      checked={!!state.mac_startup_enabled}
                      onChange={(e) => setMacStartup(e.target.checked)}
                      className="w-[15px] h-[15px] accent-indigo-500"
                    />
                    Start with macOS
                  </label>
                ) : (
                  <label className="flex items-center gap-2 text-sm opacity-50 mb-4">
                    <input type="checkbox" disabled className="w-[15px] h-[15px]" />
                    Start with macOS
                    <span className="text-xs text-amber-500">
                      configure server and API key first
                    </span>
                  </label>
                )}
                <hr className="border-slate-700 my-3" />
              </>
            )}
            <p className="text-sm text-slate-400 mb-2">
              Install as a systemd service that autostarts with the system.
            </p>
            {state.systemd?.ok ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  run(async () => {
                    await postForm('/install/systemd', new FormData())
                    loadState()
                  })
                }}
              >
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs font-medium hover:opacity-85"
                >
                  Install systemd service
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  disabled
                  className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs opacity-40 cursor-not-allowed"
                >
                  Install systemd service
                </button>
                <p className="text-xs text-slate-500 mt-2">{state.systemd?.reason}</p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ComfyUI tab */}
      <div style={{ display: activeTab === 'comfyui' ? 'block' : 'none' }}>
        <div className="bg-slate-800 rounded-lg p-5">
          <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
            ImgGen / ComfyUI
          </h2>
          <form onSubmit={saveComfyui}>
            <label className="block text-xs text-slate-500 mb-1">ComfyUI URL</label>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={comfyuiUrl}
                onChange={(e) => setComfyuiUrl(e.target.value)}
                placeholder="http://127.0.0.1:8188"
                className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm min-w-[200px]"
              />
              <button
                type="submit"
                className="px-3 py-2 rounded-md bg-indigo-500 text-white text-xs hover:opacity-85"
              >
                Save
              </button>
            </div>
          </form>
          <hr className="border-slate-700 my-4" />
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">
            Workflows
          </h3>
          {(state.workflows || []).length === 0 ? (
            <p className="text-sm text-slate-500 mb-4">
              No workflows found in{' '}
              <code className="text-slate-400">{state.workflows_dir}</code>
            </p>
          ) : (
            <div className="mb-4 space-y-0">
              {(state.workflows || []).map((wf) => (
                <div
                  key={wf.name}
                  className="flex flex-wrap items-center gap-2 py-1.5 border-b border-slate-900 text-sm"
                >
                  <span className="font-medium text-slate-200 min-w-[140px] break-all">
                    {wf.name}
                  </span>
                  <span className="flex-1 text-slate-500 text-xs">
                    {wf.task_types?.length
                      ? wf.task_types.join(', ')
                      : 'no task files yet'}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteWorkflow(wf.name)}
                    className="px-2 py-1 rounded bg-red-500 text-white text-xs hover:opacity-85"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
          <hr className="border-slate-700 my-4" />
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">
            Add Workflow
          </h3>
          <form onSubmit={addWorkflow}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Workflow name (must match ComfyUI workflow name exactly)
                </label>
                <input
                  type="text"
                  value={wfName}
                  onChange={(e) => setWfName(e.target.value)}
                  placeholder="wan-2.1-outpaint"
                  className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Task type</label>
                <select
                  value={wfTaskType}
                  onChange={(e) => setWfTaskType(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                >
                  {taskTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label className="block text-xs text-slate-500 mt-2 mb-1">
              ComfyUI workflow JSON (exported via Save then API Format in ComfyUI)
            </label>
            <input
              ref={wfFileRef}
              type="file"
              accept=".json"
              className="w-full text-xs text-slate-400 bg-slate-900 border border-slate-600 rounded px-2 py-1"
            />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <button
                type="submit"
                className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs hover:opacity-85"
              >
                Add
              </button>
              <span className="text-xs text-slate-500">
                A starter{' '}
                <code className="text-slate-400">params.json</code> mapping will be
                generated automatically.
              </span>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
