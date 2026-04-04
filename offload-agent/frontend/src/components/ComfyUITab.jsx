import { useEffect, useRef, useState } from 'react'
import { ComfyParamMapEditor } from './ComfyParamMapEditor'

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

export function ComfyUITab({ state, loadState, run }) {
  const [comfyuiUrl, setComfyuiUrl] = useState('')
  const [wfName, setWfName] = useState('')
  const [wfTaskType, setWfTaskType] = useState('txt2img')
  const wfFileRef = useRef(null)

  // Sync ComfyUI URL from state
  useEffect(() => {
    setComfyuiUrl(state?.comfyui_url || '')
  }, [state])

  const taskTypes = state?.task_types || []

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

  return (
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
      {(state?.workflows || []).length === 0 ? (
        <p className="text-sm text-slate-500 mb-4">
          No workflows found in{' '}
          <code className="text-slate-400">{state?.workflows_dir}</code>
        </p>
      ) : (
        <div className="mb-4 space-y-0">
          {(state?.workflows || []).map((wf) => (
            <div
              key={wf.name}
              className="flex flex-wrap items-center gap-2 py-1.5 border-b border-slate-900 text-sm"
            >
              <span className="font-medium text-slate-200 min-w-[140px] break-all">
                {wf.name}
              </span>
              <span className="flex-1 text-slate-500 text-xs">
                {wf.task_types?.length ? wf.task_types.join(', ') : 'no task files yet'}
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
      <ComfyParamMapEditor state={state} run={run} />
    </div>
  )
}
