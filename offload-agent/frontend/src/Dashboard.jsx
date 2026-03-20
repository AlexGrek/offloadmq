import { useCallback, useEffect, useState } from 'react'
import { StatusTab } from './components/StatusTab'
import { ConnectionTab } from './components/ConnectionTab'
import { CapabilitiesTab } from './components/CapabilitiesTab'
import { CustomTab } from './components/CustomTab'
import { SystemTab } from './components/SystemTab'
import { ComfyUITab } from './components/ComfyUITab'
import { ConfigTab } from './components/ConfigTab'

const TABS = [
  { id: 'status', label: 'Status' },
  { id: 'connection', label: 'Connection' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'custom', label: 'Custom' },
  { id: 'system', label: 'System' },
  { id: 'comfyui', label: 'ComfyUI' },
  { id: 'config', label: 'Config' },
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
  const [activeTab, setActiveTab] = useState('status')

  const loadState = useCallback(async () => {
    try {
      const r = await fetch('/api/state')
      if (!r.ok) throw new Error(r.statusText)
      const d = await r.json()
      setState(d)
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
        <StatusTab state={state} loadState={loadState} run={run} />
      </div>

      {/* Connection tab */}
      <div style={{ display: activeTab === 'connection' ? 'block' : 'none' }}>
        <ConnectionTab state={state} loadState={loadState} run={run} />
      </div>

      {/* Capabilities tab */}
      <div style={{ display: activeTab === 'capabilities' ? 'block' : 'none' }}>
        <CapabilitiesTab state={state} loadState={loadState} run={run} />
      </div>

      {/* Custom tab */}
      <div style={{ display: activeTab === 'custom' ? 'block' : 'none' }}>
        <CustomTab
          state={state}
          loadState={loadState}
          run={run}
          setActiveTab={setActiveTab}
        />
      </div>

      {/* System tab */}
      <div style={{ display: activeTab === 'system' ? 'block' : 'none' }}>
        <SystemTab state={state} loadState={loadState} run={run} />
      </div>

      {/* ComfyUI tab */}
      <div style={{ display: activeTab === 'comfyui' ? 'block' : 'none' }}>
        <ComfyUITab state={state} loadState={loadState} run={run} />
      </div>

      {/* Config tab */}
      {activeTab === 'config' && (
        <ConfigTab loadState={loadState} run={run} />
      )}
    </div>
  )
}
