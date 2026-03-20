import { useEffect, useState } from 'react'
import { CodeEditor } from '../CodeEditor'

export function ConfigTab({ loadState, run }) {
  const [jsonText, setJsonText] = useState('')
  const [parseError, setParseError] = useState(null)
  const [saved, setSaved] = useState(false)

  async function fetchConfig() {
    const r = await fetch('/config/raw', { headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(r.statusText)
    const d = await r.json()
    setJsonText(d.json)
  }

  useEffect(() => {
    fetchConfig().catch((e) => setParseError(String(e.message || e)))
  }, [])

  function handleChange(val) {
    setJsonText(val)
    setSaved(false)
    try {
      JSON.parse(val)
      setParseError(null)
    } catch (e) {
      setParseError(e.message)
    }
  }

  function handleSave(e) {
    e.preventDefault()
    run(async () => {
      try {
        JSON.parse(jsonText)
      } catch (e) {
        setParseError(e.message)
        return
      }
      const r = await fetch('/config/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonText,
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || r.statusText)
      }
      setSaved(true)
      loadState()
    })
  }

  function handleReload() {
    run(async () => {
      await fetchConfig()
      setSaved(false)
      setParseError(null)
    })
  }

  return (
    <div className="bg-slate-800 rounded-lg p-5">
      <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
        Config JSON
      </h2>
      <p className="text-xs text-slate-500 mb-3">
        Raw contents of <code>.offload-agent.json</code>. Edit and save — changes take effect immediately (no restart needed for most settings).
      </p>

      <form onSubmit={handleSave} className="space-y-3">
        <CodeEditor
          value={jsonText}
          onChange={handleChange}
          language="json"
          height="380px"
        />

        {parseError && (
          <p className="text-xs text-red-400 font-mono">{parseError}</p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!!parseError}
            className="px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleReload}
            className="px-3 py-1.5 rounded-md border border-slate-600 text-slate-500 text-xs hover:border-indigo-500 hover:text-slate-200"
          >
            Reload from disk
          </button>
          {saved && (
            <span className="text-xs text-emerald-400">Saved</span>
          )}
        </div>
      </form>
    </div>
  )
}
