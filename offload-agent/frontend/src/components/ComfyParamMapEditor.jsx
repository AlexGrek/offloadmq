import { useCallback, useMemo, useState } from 'react'

const JSON_ACCEPT = { Accept: 'application/json' }

const CUSTOM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function optValue(opt) {
  return JSON.stringify([opt.node_id, opt.input_name])
}

function parseOptValue(s) {
  if (!s) return null
  try {
    const a = JSON.parse(s)
    if (Array.isArray(a) && a.length === 2 && a[0] !== '' && a[1] !== '') {
      return [String(a[0]), String(a[1])]
    }
  } catch {
    /* ignore */
  }
  return null
}

function pairSelectValue(pair) {
  if (!pair || pair.length < 2) return ''
  const a = String(pair[0] ?? '')
  const b = String(pair[1] ?? '')
  if (!a || !b) return ''
  return JSON.stringify([a, b])
}

function buildParamsForSave(localParams, standardKeys) {
  const allKeys = new Set([...standardKeys, ...Object.keys(localParams)])
  const out = {}
  for (const key of allKeys) {
    const v = localParams[key]
    if (v === null) {
      out[key] = null
      continue
    }
    if (!Array.isArray(v)) {
      out[key] = []
      continue
    }
    out[key] = v
      .filter(
        (p) =>
          Array.isArray(p) &&
          p.length >= 2 &&
          String(p[0]).length > 0 &&
          String(p[1]).length > 0,
      )
      .map((p) => [String(p[0]), String(p[1])])
  }
  return out
}

function FieldRow({
  fieldKey,
  label,
  help,
  locked,
  targets,
  inputOptions,
  onToggleLock,
  onChangeTargets,
}) {
  function setRow(idx, jsonVal) {
    const parsed = parseOptValue(jsonVal)
    const next = targets.map((p, i) => {
      if (i !== idx) return [...p]
      return parsed ? [...parsed] : ['', '']
    })
    onChangeTargets(next)
  }

  function addRow() {
    onChangeTargets([...targets.map((p) => [...p]), ['', '']])
  }

  function removeRow(idx) {
    onChangeTargets(targets.filter((_, i) => i !== idx))
  }

  return (
    <div className="border border-slate-700 rounded-md p-3 mb-3 bg-slate-900/50">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div>
          <div className="text-sm font-medium text-slate-200">{label}</div>
          <div className="text-[0.65rem] text-slate-500 font-mono mt-0.5">{help}</div>
          <div className="text-[0.65rem] text-slate-600 mt-1">
            param key: <code className="text-slate-400">{fieldKey}</code>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={locked}
            onChange={(e) => onToggleLock(e.target.checked)}
          />
          Lock to workflow default (null in params.json)
        </label>
      </div>
      {!locked && (
        <div className="space-y-2">
          {targets.length === 0 ? (
            <p className="text-xs text-slate-500">No targets. Add one or leave empty.</p>
          ) : (
            targets.map((pair, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <select
                  value={pairSelectValue(pair)}
                  onChange={(e) => setRow(idx, e.target.value)}
                  className="flex-1 min-w-[240px] bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
                >
                  <option value="">-- pick node input --</option>
                  {inputOptions.map((opt) => (
                    <option key={optValue(opt)} value={optValue(opt)}>
                      {opt.node_id} {opt.class_type} .{opt.input_name} ({opt.kind}) ={' '}
                      {opt.preview}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs hover:bg-slate-600"
                >
                  Remove
                </button>
              </div>
            ))
          )}
          <button
            type="button"
            onClick={addRow}
            className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs hover:bg-slate-600"
          >
            Add target
          </button>
          <p className="text-[0.65rem] text-slate-500">
            Multiple targets write the same payload value to every listed Comfy input (broadcast).
          </p>
        </div>
      )}
    </div>
  )
}

export function ComfyParamMapEditor({ state, run }) {
  const [wfName, setWfName] = useState('')
  const [taskType, setTaskType] = useState('txt2img')
  const [loadErr, setLoadErr] = useState(null)
  const [saveErr, setSaveErr] = useState(null)
  const [standardFields, setStandardFields] = useState([])
  const [inputOptions, setInputOptions] = useState([])
  const [localParams, setLocalParams] = useState({})

  const standardKeys = useMemo(
    () => standardFields.map((f) => f.key),
    [standardFields],
  )

  const customKeys = useMemo(() => {
    const sk = new Set(standardKeys)
    return Object.keys(localParams).filter((k) => !sk.has(k))
  }, [localParams, standardKeys])

  // wfName stores "namespace::name" so workflows with the same name but different
  // namespaces are distinct entries in the select.
  const selectedWf = useMemo(() => {
    const wflows = state?.workflows || []
    return wflows.find((x) => `${x.namespace}::${x.name}` === wfName) || null
  }, [state?.workflows, wfName])

  const taskTypesForWf = useMemo(() => {
    const tall = state?.task_types
    if (selectedWf?.task_types?.length) return selectedWf.task_types
    return tall || []
  }, [state?.task_types, selectedWf])

  const effectiveTaskType = useMemo(() => {
    if (!taskTypesForWf.length) return taskType
    return taskTypesForWf.includes(taskType) ? taskType : taskTypesForWf[0]
  }, [taskTypesForWf, taskType])

  function onChangeWorkflow(compositeKey) {
    setWfName(compositeKey)
    const wflows = state?.workflows || []
    const tall = state?.task_types || []
    const w = wflows.find((x) => `${x.namespace}::${x.name}` === compositeKey)
    const ts = w?.task_types?.length ? w.task_types : tall
    if (ts.length > 0 && !ts.includes(taskType)) {
      setTaskType(ts[0])
    }
  }

  const loadParamMap = useCallback(async () => {
    setLoadErr(null)
    if (!wfName) {
      setLoadErr('Pick a workflow name.')
      return
    }
    const q = new URLSearchParams({
      workflow_name: selectedWf?.name ?? '',
      task_type: effectiveTaskType,
      namespace: selectedWf?.namespace ?? '',
    })
    const r = await fetch(`/workflows/param-map?${q}`, { headers: JSON_ACCEPT })
    const data = await r.json()
    if (!data.ok) {
      setLoadErr(data.error || r.statusText)
      return
    }
    setStandardFields(data.standard_fields || [])
    setInputOptions(data.input_options || [])
    setLocalParams(JSON.parse(JSON.stringify(data.params || {})))
  }, [wfName, selectedWf, effectiveTaskType])

  function setFieldTargets(key, targets) {
    setLocalParams((p) => ({ ...p, [key]: targets }))
  }

  function toggleFieldLock(key, locked) {
    setLocalParams((p) => {
      if (locked) return { ...p, [key]: null }
      const cur = p[key]
      const next = Array.isArray(cur) && cur.length ? cur : []
      return { ...p, [key]: next }
    })
  }

  async function saveParamMap() {
    setSaveErr(null)
    await run(async () => {
      const params = buildParamsForSave(localParams, standardKeys)
      const r = await fetch('/workflows/param-map', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          workflow_name: selectedWf?.name ?? '',
          namespace: selectedWf?.namespace ?? '',
          task_type: effectiveTaskType,
          params,
        }),
      })
      const data = await r.json()
      if (!data.ok) throw new Error(data.error || r.statusText)
      await loadParamMap()
    })
  }

  async function autodetect() {
    if (
      !window.confirm(
        'Overwrite this task type params.json with auto-detect merged on top of FIXME stubs?',
      )
    ) {
      return
    }
    setSaveErr(null)
    await run(async () => {
      const r = await fetch('/workflows/param-map/autodetect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          workflow_name: selectedWf?.name ?? '',
          namespace: selectedWf?.namespace ?? '',
          task_type: effectiveTaskType,
        }),
      })
      const data = await r.json()
      if (!data.ok) throw new Error(data.error || r.statusText)
      setLocalParams(data.params || {})
    })
  }

  function addCustomField(rawKey) {
    const key = rawKey.trim()
    if (!CUSTOM_KEY_RE.test(key)) {
      setSaveErr('Invalid key: use letters, digits, underscore, dot, hyphen.')
      return
    }
    if (localParams[key] !== undefined) {
      setSaveErr('That key already exists.')
      return
    }
    setSaveErr(null)
    setLocalParams((p) => ({ ...p, [key]: [] }))
  }

  function removeCustomField(key) {
    setLocalParams((p) => {
      const next = { ...p }
      delete next[key]
      return next
    })
  }

  const [newCustomKey, setNewCustomKey] = useState('')

  return (
    <div className="mt-6 pt-4 border-t border-slate-700">
      <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">
        Payload to Comfy node map
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        Map imggen payload fields to Comfy node inputs. Each dropdown shows the node id, class
        type, input name, whether the template value is a literal or a wire, and a short preview
        of the default. Use this when auto-detect missed nodes or used the wrong slot.
      </p>
      <div className="flex flex-wrap gap-2 items-end mb-3">
        <div>
          <label className="block text-[0.65rem] text-slate-500 mb-1">Workflow</label>
          <select
            value={wfName}
            onChange={(e) => onChangeWorkflow(e.target.value)}
            className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 min-w-40"
          >
            <option value="">-- select --</option>
            {(state?.workflows || []).map((w) => {
              const key = `${w.namespace}::${w.name}`
              const label = w.namespace ? `[${w.namespace}] ${w.name}` : w.name
              return (
                <option key={key} value={key}>
                  {label}
                </option>
              )
            })}
          </select>
        </div>
        <div>
          <label className="block text-[0.65rem] text-slate-500 mb-1">Task type</label>
          <select
            value={effectiveTaskType}
            onChange={(e) => setTaskType(e.target.value)}
            className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 min-w-[140px]"
          >
            {taskTypesForWf.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => run(() => loadParamMap())}
          className="px-3 py-1.5 rounded-md bg-slate-600 text-white text-xs hover:opacity-90"
        >
          Load
        </button>
        <button
          type="button"
          onClick={() => run(() => saveParamMap())}
          disabled={!wfName.trim()}
          className="px-3 py-1.5 rounded-md bg-indigo-500 text-white text-xs hover:opacity-90 disabled:opacity-40"
        >
          Save params.json
        </button>
        <button
          type="button"
          onClick={() => run(() => autodetect())}
          disabled={!wfName.trim()}
          className="px-3 py-1.5 rounded-md bg-amber-600 text-white text-xs hover:opacity-90 disabled:opacity-40"
        >
          Re-run auto-detect
        </button>
      </div>
      {loadErr && <p className="text-xs text-red-400 mb-2">{loadErr}</p>}
      {saveErr && <p className="text-xs text-red-400 mb-2">{saveErr}</p>}

      {standardFields.length > 0 && (
        <div className="mb-4">
          <h4 className="text-[0.65rem] font-semibold text-slate-500 uppercase mb-2">
            Standard fields
          </h4>
          {standardFields.map((f) => {
            const v = localParams[f.key]
            const locked = v === null
            const targets = locked || !Array.isArray(v) ? [] : v.map((p) => [...p])
            return (
              <FieldRow
                key={f.key}
                fieldKey={f.key}
                label={f.label}
                help={f.help}
                locked={locked}
                targets={targets}
                inputOptions={inputOptions}
                onToggleLock={(on) => toggleFieldLock(f.key, on)}
                onChangeTargets={(t) => setFieldTargets(f.key, t)}
              />
            )
          })}
        </div>
      )}

      {standardFields.length === 0 && Object.keys(localParams).length > 0 && (
        <p className="text-xs text-amber-500/90 mb-2">
          No standard field list for this task type. Edit custom keys below or pick a standard
          task type.
        </p>
      )}

      {customKeys.length > 0 && (
        <div className="mb-4">
          <h4 className="text-[0.65rem] font-semibold text-slate-500 uppercase mb-2">
            Extra params (secondary_prompts or custom)
          </h4>
          {customKeys.map((key) => {
            const v = localParams[key]
            const locked = v === null
            const targets = locked || !Array.isArray(v) ? [] : v.map((p) => [...p])
            return (
              <div key={key}>
                <FieldRow
                  fieldKey={key}
                  label={key}
                  help="Maps payload.secondary_prompts or matching injection key"
                  locked={locked}
                  targets={targets}
                  inputOptions={inputOptions}
                  onToggleLock={(on) => toggleFieldLock(key, on)}
                  onChangeTargets={(t) => setFieldTargets(key, t)}
                />
                <div className="-mt-2 mb-3">
                  <button
                    type="button"
                    onClick={() => removeCustomField(key)}
                    className="text-xs text-red-400 hover:underline"
                  >
                    Remove field &quot;{key}&quot;
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={newCustomKey}
          onChange={(e) => setNewCustomKey(e.target.value)}
          placeholder="custom_param_key"
          className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 w-48"
        />
        <button
          type="button"
          onClick={() => {
            addCustomField(newCustomKey)
            setNewCustomKey('')
          }}
          className="px-2 py-1.5 rounded bg-slate-600 text-white text-xs hover:opacity-90"
        >
          Add custom param key
        </button>
      </div>
    </div>
  )
}
