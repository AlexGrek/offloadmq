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

function computeDefaultName(sysinfo) {
  if (!sysinfo) return ''
  let cpu = (sysinfo.cpuModel || sysinfo.cpuArch || '')
    .replace(/\(R\)/g, '').replace(/\(TM\)/g, '').replace(/ CPU/g, '').trim()
  if (cpu.includes(' @ ')) cpu = cpu.slice(0, cpu.indexOf(' @ '))
  cpu = cpu.replace(/\s+/g, ' ').trim()
  const ramGb = sysinfo.totalMemoryGb ?? 0
  const name = cpu ? `${cpu} ${ramGb}GB` : `${ramGb}GB`
  return name.slice(0, 50)
}

export function ConnectionTab({ state, loadState, run }) {
  const [server, setServer] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [displayName, setDisplayName] = useState('')

  // Sync form values from state
  useEffect(() => {
    setServer(state?.server || '')
    setApiKey(state?.apiKey || '')
    setDisplayName(state?.displayName || '')
  }, [state])

  async function saveConnection(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      fd.append('server', server)
      fd.append('apiKey', apiKey)
      fd.append('displayName', displayName)
      await postForm('/config', fd)
      loadState()
    })
  }

  const namePlaceholder = computeDefaultName(state?.sysinfo) || 'e.g. Apple M3 16GB'

  return (
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
        <label className="block text-xs text-slate-500 mb-1">Display Name</label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value.slice(0, 50))}
          placeholder={namePlaceholder}
          maxLength={50}
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
  )
}
