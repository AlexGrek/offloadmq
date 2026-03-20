import { useRef, useState } from 'react'
import { CodeEditor } from '../CodeEditor'

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

// Script extraction / injection helpers
function extractScript(yaml) {
  // Match "script: |" block scalar and extract its content
  const m = yaml.match(/^script:\s*\|[-+]?\s*\n((?:(?:[ \t]+[^\n]*)?\n)*)/m)
  if (!m) return ''
  const lines = m[1].split('\n')
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^(\s*)/)[1].length)
  const indent = indents.length ? Math.min(...indents) : 2
  return lines
    .map((l) => (l.length >= indent ? l.slice(indent) : l))
    .join('\n')
    .replace(/\n+$/, '')
}

function injectScript(yaml, script) {
  const indented = script
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  const replacement = `script: |\n${indented}\n`
  if (/^script:\s*\|/m.test(yaml)) {
    return yaml.replace(
      /^script:\s*\|[-+]?\s*\n((?:(?:[ \t]+[^\n]*)?\n)*)/m,
      replacement,
    )
  }
  if (/^script:/m.test(yaml)) {
    return yaml.replace(/^script:.*$/m, replacement.trimEnd())
  }
  return yaml.trimEnd() + '\n' + replacement
}

function isShellType(yaml) {
  return /^type:\s*shell/m.test(yaml)
}

export function CustomTab({ state, loadState, run, setActiveTab }) {
  const [capYaml, setCapYaml] = useState('')
  const [capEditorTab, setCapEditorTab] = useState('yaml')
  const [scriptContent, setScriptContent] = useState('')
  const capFileRef = useRef(null)
  const capEditorRef = useRef(null)

  function switchEditorTab(tab) {
    if (tab === 'script' && capEditorTab === 'yaml') {
      setScriptContent(extractScript(capYaml))
    } else if (tab === 'yaml' && capEditorTab === 'script') {
      setCapYaml((prev) => injectScript(prev, scriptContent))
    }
    setCapEditorTab(tab)
  }

  function handleScriptChange(val) {
    setScriptContent(val)
    setCapYaml((prev) => injectScript(prev, val))
  }

  async function saveCustomCap(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      fd.append('yaml', capYaml)
      await postForm('/custom/save', fd)
      setCapYaml('')
      setScriptContent('')
      setCapEditorTab('yaml')
      loadState()
    })
  }

  async function uploadCustomCap(e) {
    e.preventDefault()
    run(async () => {
      const fd = new FormData()
      const f = capFileRef.current?.files?.[0]
      if (f) fd.append('cap_file', f)
      await postForm('/custom/upload', fd)
      if (capFileRef.current) capFileRef.current.value = ''
      loadState()
    })
  }

  function deleteCustomCap(name) {
    if (!window.confirm(`Delete custom cap ${name}?`)) return
    run(async () => {
      const body = JSON.stringify({ name })
      const r = await fetch('/custom/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (!r.ok) throw new Error(r.statusText)
      loadState()
    })
  }

  async function editCustomCap(name) {
    run(async () => {
      const r = await fetch(`/custom/get/${encodeURIComponent(name)}`, {
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) throw new Error(r.statusText)
      const d = await r.json()
      setCapYaml(d.raw || '')
      setCapEditorTab('yaml')
      setActiveTab('custom')
      setTimeout(() => capEditorRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    })
  }

  function loadCapTemplate(type) {
    if (type === 'shell') {
      setCapYaml(`name: my-cap
type: shell
description: Shell script custom cap
script: |
  #!/bin/bash
  set -euo pipefail
  echo "Hello from \${CUSTOM_NAME}"
params:
  - name: name
    type: string
    default: World
timeout: 120
`)
    } else if (type === 'llm') {
      setCapYaml(`name: my-llm-cap
type: llm
description: LLM prompt custom cap
model: mistral:7b
prompt: |
  Answer the following question in {{style}} style:
  {{question}}
system: You are a helpful assistant.
temperature: 0.7
max_tokens: 512
params:
  - name: question
    type: text
  - name: style
    type: string
    default: concise
`)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      {/* Custom Cap Editor */}
      <div className="bg-slate-800 rounded-lg p-5" ref={capEditorRef}>
        <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Custom Cap Editor
        </h2>
        <form onSubmit={saveCustomCap} className="space-y-3 mb-4">
          {/* Editor mode tabs */}
          <div className="flex gap-1 border-b border-slate-700 mb-1">
            <button
              type="button"
              onClick={() => switchEditorTab('yaml')}
              className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                capEditorTab === 'yaml'
                  ? 'text-indigo-400 border-b-2 border-indigo-400 -mb-px bg-slate-900/40'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              YAML
            </button>
            {isShellType(capYaml) && (
              <button
                type="button"
                onClick={() => switchEditorTab('script')}
                className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                  capEditorTab === 'script'
                    ? 'text-indigo-400 border-b-2 border-indigo-400 -mb-px bg-slate-900/40'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Script
              </button>
            )}
          </div>

          {capEditorTab === 'yaml' ? (
            <div>
              {!capYaml.trim() && (
                <div className="absolute pointer-events-none text-slate-600 font-mono text-xs p-3 leading-5">
                  name: my-cap{'\n'}type: shell{'\n'}description: ...
                </div>
              )}
              <CodeEditor
                value={capYaml}
                onChange={setCapYaml}
                language="yaml"
                height="280px"
              />
            </div>
          ) : (
            <div>
              <p className="text-xs text-slate-500 mb-1">
                Bash script — changes sync back to YAML automatically
              </p>
              <CodeEditor
                value={scriptContent}
                onChange={handleScriptChange}
                language="shell"
                height="280px"
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!capYaml.trim()}
              className="px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => loadCapTemplate('shell')}
              className="px-3 py-2 rounded-md border border-slate-600 text-slate-300 text-xs hover:border-indigo-500 hover:text-white"
            >
              Shell template
            </button>
            <button
              type="button"
              onClick={() => loadCapTemplate('llm')}
              className="px-3 py-2 rounded-md border border-slate-600 text-slate-300 text-xs hover:border-indigo-500 hover:text-white"
            >
              LLM template
            </button>
            {capYaml.trim() && (
              <button
                type="button"
                onClick={() => {
                  setCapYaml('')
                  setScriptContent('')
                  setCapEditorTab('yaml')
                }}
                className="px-3 py-2 rounded-md border border-slate-600 text-slate-500 text-xs hover:border-red-600 hover:text-red-400"
              >
                Clear
              </button>
            )}
          </div>
        </form>

        <div className="border-t border-slate-600 pt-4 mt-4">
          <label className="block text-xs font-medium text-slate-400 mb-2">
            Or upload YAML file
          </label>
          <form onSubmit={uploadCustomCap} className="flex gap-2">
            <input
              type="file"
              ref={capFileRef}
              accept=".yaml,.yml"
              className="flex-1 px-3 py-2 rounded-md bg-slate-900 text-slate-200 text-xs border border-slate-600 file:rounded file:border-0 file:bg-indigo-500 file:text-white file:text-xs file:font-medium file:px-2 file:py-1 file:mr-2"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-md bg-slate-700 text-white text-sm font-medium hover:bg-slate-600"
            >
              Upload
            </button>
          </form>
        </div>
      </div>

      {/* Custom caps list */}
      <div className="bg-slate-800 rounded-lg p-5">
        <h2 className="text-[0.72rem] font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Installed custom caps
        </h2>
        {(state?.custom_caps || []).length === 0 ? (
          <p className="text-sm text-slate-500 italic">No custom caps installed</p>
        ) : (
          <div className="space-y-2">
            {(state?.custom_caps || []).map((c) => (
              <div key={c.name} className="bg-slate-700 rounded p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <p className="font-semibold text-slate-200">
                      {c.name}
                      <span className="text-xs font-normal text-slate-500 ml-2 lowercase">
                        {c.type}
                      </span>
                    </p>
                    <p className="text-slate-400 text-xs mt-1">{c.description}</p>
                    <p className="text-slate-500 text-xs mt-2">
                      <code>{c.capability}</code>
                    </p>
                    {c.params && c.params.length > 0 && (
                      <p className="text-slate-500 text-xs mt-1">
                        Params: {c.params.map((p) => p.name).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => editCustomCap(c.name)}
                      className="px-2 py-1 rounded bg-slate-600 text-slate-200 text-xs hover:bg-indigo-700"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteCustomCap(c.name)}
                      className="px-2 py-1 rounded bg-red-900 text-red-200 text-xs hover:bg-red-800"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
