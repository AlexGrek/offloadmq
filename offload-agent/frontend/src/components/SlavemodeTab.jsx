import { useEffect, useState } from 'react'

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

export function SlavemodeTab({ state, loadState, run }) {
  const allSlavemodeCaps = state?.slavemode_all_caps || []
  const [allowed, setAllowed] = useState(new Set())

  useEffect(() => {
    setAllowed(new Set(state?.slavemode_allowed || []))
  }, [state])

  function toggle(cap, on) {
    const next = new Set(allowed)
    if (on) next.add(cap)
    else next.delete(cap)
    setAllowed(next)
  }

  async function save() {
    run(async () => {
      const fd = new FormData()
      allowed.forEach((c) => fd.append('caps', c))
      await postForm('/slavemode-caps', fd)
      loadState()
    })
  }

  if (allSlavemodeCaps.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg p-5 text-slate-500 text-sm">
        No slavemode capabilities are defined in this agent build.
      </div>
    )
  }

  return (
    <div className="bg-slate-800 rounded-lg p-5">
      <h2 className="text-[0.72rem] font-semibold text-amber-500/80 uppercase tracking-wider mb-1">
        Slavemode (Tier 1: Control Operations)
      </h2>
      <p className="text-xs text-slate-500 mb-4">
        <strong>Opt-in only.</strong> Allow the server to trigger control operations on this
        agent (capability rescans, config management, etc). These are separate from task capabilities
        and require explicit permission. Changes take effect immediately when saved.
      </p>
      <div className="space-y-1 mb-4">
        {allSlavemodeCaps.map((cap) => (
          <label
            key={cap}
            className="flex items-center gap-2 text-sm cursor-pointer py-1"
          >
            <input
              type="checkbox"
              checked={allowed.has(cap)}
              onChange={(e) => toggle(cap, e.target.checked)}
              className="w-[15px] h-[15px] accent-amber-500"
            />
            <span className={allowed.has(cap) ? 'text-amber-300' : 'text-slate-400'}>
              {cap}
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          className="px-4 py-2 rounded-md bg-amber-600 text-white text-sm font-medium hover:opacity-85"
        >
          Save permissions
        </button>
        <button
          type="button"
          onClick={() => {
            setAllowed(new Set(allSlavemodeCaps))
          }}
          className="px-4 py-2 rounded-md border border-slate-600 text-slate-300 text-sm font-medium hover:border-amber-500 hover:text-white"
        >
          Allow all
        </button>
        <button
          type="button"
          onClick={() => setAllowed(new Set())}
          className="px-4 py-2 rounded-md border border-slate-600 text-slate-400 text-sm font-medium hover:border-red-500 hover:text-red-300"
        >
          Deny all
        </button>
      </div>
    </div>
  )
}
