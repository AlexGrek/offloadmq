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

export function CapabilitiesTab({ state, loadState, run }) {
  const [selectedCaps, setSelectedCaps] = useState(new Set())
  const [rescanning, setRescanning] = useState(false)

  // Sync selected caps from state
  useEffect(() => {
    setSelectedCaps(new Set(state?.selected_caps || []))
  }, [state])

  const allCaps = state?.all_caps || []

  function toggleCap(c, on) {
    const next = new Set(selectedCaps)
    if (on) next.add(c)
    else next.delete(c)
    setSelectedCaps(next)
  }

  async function saveCaps() {
    run(async () => {
      const fd = new FormData()
      selectedCaps.forEach((c) => fd.append('caps', c))
      fd.append('action', 'save')
      await postForm('/capabilities', fd)
      loadState()
    })
  }

  async function rescanAndRestart() {
    const prevCaps = (state?.all_caps || []).slice().sort().join(',')
    const wasRunning = state?.running
    setRescanning(true)
    try {
      await postForm('/scan', new FormData())
      let newState = null
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const r = await fetch('/api/state')
        newState = await r.json()
        if (!newState.scanning) break
      }
      if (newState) {
        // Update our state snapshot
        const tempState = newState
        const newCaps = (tempState?.all_caps || []).slice().sort().join(',')
        if (newCaps !== prevCaps && wasRunning) {
          await postForm('/agent/stop', new FormData())
          await postForm('/agent/start', new FormData())
        }
      }
      await loadState()
    } catch (e) {
      run(async () => {
        throw e
      })
    } finally {
      setRescanning(false)
    }
  }

  return (
    <div className="bg-slate-800 rounded-lg p-5">
      <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
        Capabilities
      </h2>
      <p className="text-xs text-slate-500 mb-3">
        Regular task capabilities only. Slavemode is configured on the Slavemode tab.
      </p>
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
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={() => saveCaps()}
          className="px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:opacity-85"
        >
          Save selection
        </button>
        <button
          type="button"
          onClick={rescanAndRestart}
          disabled={rescanning}
          className="px-4 py-2 rounded-md border border-slate-600 text-slate-300 text-sm font-medium hover:border-indigo-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {rescanning ? 'Rescanning…' : 'Rescan'}
        </button>
      </div>
    </div>
  )
}
