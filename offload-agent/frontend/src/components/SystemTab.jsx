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

function UpdatesCard({ currentVersion }) {
  const [checkState, setCheckState] = useState(null) // null | 'checking' | result object
  const [dlState, setDlState] = useState(null)       // null | 'downloading' | result object

  async function checkForUpdate() {
    setCheckState('checking')
    setDlState(null)
    try {
      const r = await fetch('/api/update/check', { headers: JSON_ACCEPT })
      const d = await r.json()
      setCheckState(d)
    } catch (e) {
      setCheckState({ error: String(e.message || e) })
    }
  }

  async function downloadUpdate() {
    setDlState('downloading')
    try {
      const r = await fetch('/api/update/download', { method: 'POST', headers: JSON_ACCEPT })
      const d = await r.json()
      setDlState(d)
    } catch (e) {
      setDlState({ ok: false, error: String(e.message || e) })
    }
  }

  const info = checkState && checkState !== 'checking' ? checkState : null
  const hasUpdate = info && !info.error && info.has_update
  const upToDate = info && !info.error && !info.has_update

  return (
    <div className="bg-slate-800 rounded-lg p-5">
      <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
        Updates
      </h2>

      <div className="text-sm text-slate-400 mb-3">
        Current version:{' '}
        <span className="text-slate-200 font-mono">{currentVersion || 'unknown'}</span>
        {info && !info.error && (
          <span className="ml-3 text-slate-500">
            Latest: <span className="font-mono text-slate-300">{info.latest}</span>
          </span>
        )}
      </div>

      {/* Status line */}
      {checkState === 'checking' && (
        <p className="text-xs text-slate-500 italic mb-3">Checking for updates…</p>
      )}
      {info?.error && (
        <p className="text-xs text-red-400 mb-3">{info.error}</p>
      )}
      {upToDate && (
        <p className="text-xs text-emerald-400 mb-3">You are up to date.</p>
      )}
      {hasUpdate && (
        <div className="mb-3">
          <p className="text-xs text-amber-400">
            Update available: <span className="font-mono">{info.latest}</span>
            {info.date ? <span className="text-slate-500 ml-2">({info.date})</span> : null}
          </p>
          {info.notes && (
            <p className="text-xs text-slate-500 mt-1 italic">{info.notes}</p>
          )}
          {info.target_available === false && (
            <p className="text-xs text-slate-500 mt-1">
              No build available for this platform yet.
            </p>
          )}
        </div>
      )}

      {/* Download result */}
      {dlState === 'downloading' && (
        <p className="text-xs text-slate-500 italic mb-3">Downloading… check the agent log for progress.</p>
      )}
      {dlState && dlState !== 'downloading' && (
        <p className={`text-xs mb-3 ${dlState.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {dlState.ok ? dlState.message : dlState.error}
        </p>
      )}

      {/* Buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={checkState === 'checking'}
          onClick={checkForUpdate}
          className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs font-medium hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {checkState === 'checking' ? 'Checking…' : 'Check for Updates'}
        </button>

        {hasUpdate && info.target_available !== false && (
          <button
            type="button"
            disabled={dlState === 'downloading' || (dlState && dlState.ok)}
            onClick={downloadUpdate}
            className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-medium hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {dlState === 'downloading' ? 'Downloading…' : `Download ${info.latest}`}
          </button>
        )}
      </div>
    </div>
  )
}

export function SystemTab({ state, loadState, run }) {
  const [isScanning, setIsScanning] = useState(false)
  const [webuiPort, setWebuiPort] = useState('')

  useEffect(() => {
    setWebuiPort(String(state?.webuiPort || 8080))
  }, [state])

  const cfgExists = state?.cfg_exists
  const si = state?.sysinfo || {}
  const gpu = si.gpu
  const gpuStr = gpu
    ? `${gpu.vendor} ${gpu.model} (${gpu.vramGb ?? 0}GB VRAM)`
    : 'None'

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

  function savePort(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      fd.append('port', webuiPort)
      await postForm('/config/webui-port', fd)
      loadState()
    })
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <UpdatesCard currentVersion={state?.version} />

      <div className="bg-slate-800 rounded-lg p-5">
        <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Web UI Port
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          Port the Web UI listens on. Restart the agent app to apply changes.
        </p>
        <form onSubmit={savePort} className="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="65535"
            value={webuiPort}
            onChange={(e) => setWebuiPort(e.target.value)}
            className="w-28 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:opacity-85"
          >
            Save
          </button>
        </form>
      </div>

      <div className="bg-slate-800 rounded-lg p-5">
        <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
          System
        </h2>
        {state?.scanning ? (
          <p className="text-sm text-slate-500 italic">Scanning...</p>
        ) : Object.keys(si).length === 0 ? (
          <p className="text-sm text-slate-500 italic">No scan data yet</p>
        ) : (
          <div className="text-sm text-slate-400 leading-relaxed">
            <div>
              {si.os} / {si.cpuArch}
            </div>
            <div>RAM: {si.totalMemoryGb ?? 0}GB</div>
            <div>GPU: {gpuStr}</div>
          </div>
        )}
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault()
            run(async () => {
              setIsScanning(true)
              try {
                await postForm('/scan', new FormData())
                await loadState()
              } finally {
                setIsScanning(false)
              }
            })
          }}
        >
          <button
            type="submit"
            disabled={isScanning}
            className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs font-medium hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isScanning ? 'Scanning...' : 'Rescan'}
          </button>
        </form>
      </div>

      <div className="bg-slate-800 rounded-lg p-5">
        <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Service
        </h2>
        {state?.win_startup_available && (
          <>
            <p className="text-sm text-slate-400 mb-2">
              Launch Offload Agent when you log in to Windows.
            </p>
            {cfgExists ? (
              <label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={!!state.win_startup_enabled}
                  onChange={(e) => setWinStartup(e.target.checked)}
                  className="w-[15px] h-[15px] accent-indigo-500"
                />
                Start with Windows
              </label>
            ) : (
              <label className="flex items-center gap-2 text-sm opacity-50 mb-2">
                <input type="checkbox" disabled className="w-[15px] h-[15px]" />
                Start with Windows
                <span className="text-xs text-amber-500">
                  configure server and API key first
                </span>
              </label>
            )}
            <div className="mt-2 mb-4 rounded bg-slate-900 p-3 text-xs font-mono text-slate-400 space-y-1">
              <div>
                <span className="text-slate-500">exe: </span>
                <span className="text-slate-200 break-all">{state.win_startup_exe ?? '—'}</span>
              </div>
              <div>
                <span className="text-slate-500">frozen: </span>
                <span className={state.win_startup_frozen ? 'text-green-400' : 'text-amber-400'}>
                  {String(!!state.win_startup_frozen)}
                </span>
                {!state.win_startup_frozen && (
                  <span className="text-amber-500 ml-2">(running from source — startup still works but exe path will be python.exe)</span>
                )}
              </div>
              <div>
                <span className="text-slate-500">registry value: </span>
                {state.win_startup_value
                  ? <span className="text-green-300 break-all">{state.win_startup_value}</span>
                  : <span className="text-slate-500 italic">not set</span>
                }
              </div>
            </div>
            <hr className="border-slate-700 my-3" />
          </>
        )}
        {state?.mac_startup_available && (
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
        {state?.systemd?.ok ? (
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
            <p className="text-xs text-slate-500 mt-2">{state?.systemd?.reason}</p>
          </>
        )}
      </div>
    </div>
  )
}
