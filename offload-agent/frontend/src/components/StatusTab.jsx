import { useEffect, useRef, useState } from 'react'

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

export function StatusTab({ state, loadState, run }) {
  const [running, setRunning] = useState(false)
  const [logLines, setLogLines] = useState([])
  const logRef = useRef(null)

  // Polling interval for agent status and logs
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const [sr, lr] = await Promise.all([
          fetch('/agent/status').then((r) => r.json()),
          fetch('/agent/logs').then((r) => r.json()),
        ])
        setRunning(!!sr.running)
        const lines = lr.lines || []
        setLogLines(lines)
        requestAnimationFrame(() => {
          if (logRef.current)
            logRef.current.scrollTop = logRef.current.scrollHeight
        })
      } catch {
        /* ignore poll errors */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [])

  const cfgExists = state?.cfg_exists

  function setAutostart(on) {
    run(async () => {
      const fd = new FormData()
      if (on) fd.append('autostart', '1')
      await postForm('/config/autostart', fd)
      loadState()
    })
  }

  return (
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
              <span className="text-xs text-amber-500 ml-1">
                config not found
              </span>
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
  )
}
