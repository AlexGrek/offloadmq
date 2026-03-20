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
    ? `${gpu.vendor} ${gpu.model} (${gpu.vramMb}MB VRAM)`
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
            <div>RAM: {si.totalMemoryMb}MB</div>
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
