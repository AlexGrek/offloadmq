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

function CapabilitySection({ title, description, capabilities, selected, onToggle, color, optModel }) {
  if (capabilities.length === 0) {
    return null
  }

  const modelLabel = optModel === 'opt-out' ? 'Enabled by default (uncheck to disable)' : 'Disabled by default (check to enable)'

  return (
    <div className="mb-6">
      <h3 className={`text-sm font-semibold ${color} mb-1`}>{title}</h3>
      <p className="text-xs text-slate-500 mb-2">{description}</p>
      <p className="text-xs text-slate-400 italic mb-2">{modelLabel}</p>
      <div className="space-y-1">
        {capabilities.map((cap) => {
          const isSelected = selected.has(cap)
          return (
            <label
              key={cap}
              className="flex items-center gap-2 text-sm cursor-pointer py-1 hover:bg-slate-700/30 px-2 rounded"
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={(e) => onToggle(cap, e.target.checked)}
                className={`w-[15px] h-[15px] ${color.includes('emerald') ? 'accent-emerald-500' : 'accent-amber-500'}`}
              />
              <span className={isSelected ? 'text-slate-200' : 'text-slate-400'}>
                {cap}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

export function CapabilitiesTab({ state, loadState, run }) {
  const [regularDisabled, setRegularDisabled] = useState(new Set())
  const [sensitiveAllowed, setSensitiveAllowed] = useState(new Set())
  const [rescanning, setRescanning] = useState(false)

  // Sync from state
  useEffect(() => {
    const tierCaps = state?.tier_caps
    if (tierCaps) {
      setRegularDisabled(new Set(tierCaps.regular?.disabled || []))
      setSensitiveAllowed(new Set(tierCaps.sensitive?.allowed || []))
    }
  }, [state])

  const tierCaps = state?.tier_caps || { regular: { all: [], disabled: [] }, sensitive: { all: [], allowed: [] } }
  const regularAll = tierCaps.regular?.all || []
  const sensitiveAll = tierCaps.sensitive?.all || []

  // For regular caps, "selected" means NOT disabled (opt-out model)
  const regularEnabled = new Set(regularAll.filter(c => !regularDisabled.has(c)))

  function toggleRegular(cap, shouldEnable) {
    const next = new Set(regularDisabled)
    if (shouldEnable) {
      next.delete(cap) // Enable = remove from disabled list
    } else {
      next.add(cap) // Disable = add to disabled list
    }
    setRegularDisabled(next)
  }

  function toggleSensitive(cap, shouldAllow) {
    const next = new Set(sensitiveAllowed)
    if (shouldAllow) {
      next.add(cap)
    } else {
      next.delete(cap)
    }
    setSensitiveAllowed(next)
  }

  async function saveCaps() {
    run(async () => {
      const fd = new FormData()
      regularDisabled.forEach((c) => fd.append('regular_disabled', c))
      sensitiveAllowed.forEach((c) => fd.append('sensitive_allowed', c))
      fd.append('action', 'save')
      await postForm('/capabilities', fd)
      loadState()
    })
  }

  async function rescanAndRestart() {
    const prevCaps = (state?.tier_caps?.detected_raw || []).slice().sort().join(',')
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
        const newCaps = (newState?.tier_caps?.detected_raw || []).slice().sort().join(',')
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
        Task Capabilities (Tiers 2-3)
      </h2>
      <p className="text-xs text-slate-400 mb-4">
        Configure which task capabilities this agent advertises to the server.
        Tier 2 (Sensitive) requires opt-in. Tier 3 (Regular) is opt-out.
        Slavemode control operations are configured separately.
      </p>

      {/* Regular Capabilities - Opt-out */}
      <CapabilitySection
        title="Regular Capabilities"
        description="Core capabilities like LLM, image generation, TTS, and debug tools. Enabled by default if detected."
        capabilities={regularAll}
        selected={regularEnabled}
        onToggle={toggleRegular}
        color="text-emerald-400"
        optModel="opt-out"
      />

      {/* Sensitive Capabilities - Opt-in */}
      <CapabilitySection
        title="Sensitive Capabilities"
        description="Security-sensitive operations like shell access and Docker. Disabled by default, must be explicitly enabled."
        capabilities={sensitiveAll}
        selected={sensitiveAllowed}
        onToggle={toggleSensitive}
        color="text-amber-400"
        optModel="opt-in"
      />

      {regularAll.length === 0 && sensitiveAll.length === 0 && (
        <div className="text-slate-500 text-sm py-4">
          No capabilities detected. Click "Rescan" to detect available capabilities.
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-slate-700">
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
