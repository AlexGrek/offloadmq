import React, { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Save, Trash2, X } from 'lucide-react';
import { sandboxStyles as ss } from '../sandboxStyles';
import { cancelTask, clientFetch, deleteBucket, fmtBytes, statusLabel } from '../sandboxUtils';
import { apiFetch, stripCapabilityAttrs } from '../utils';
import { useCapabilities } from '../hooks/useCapabilities';
import { useTaskPolling } from '../hooks/useTaskPolling';
import TerminalOutput from './TerminalOutput';

// Shell Jobs — exercises the shell.* contract (docs/shell-api.md): shell family,
// workspace substitution, env map, credentials and bucket-backed artifacts.

const PRESETS_KEY = 'shellJobAppPresets';
const TASKS_KEY = 'shellJobAppTaskIds';
const CRED_TYPES = ['value', 'map', 'login_password', 'agent_env', 'agent_file', 'agent_cmd'];
const WORKSPACE_TOKENS = ['${rand}', '${task_id}', '${date}', '${env:HOME}'];

const DEFAULT_FORM = {
  shellCap: '',
  runner: '',
  command: 'echo "hello from $OMQ_SHELL in $PWD"\nmkdir -p out && date > out/when.txt',
  strict: false,
  runtimeSecs: '',
  workspace: 'sandbox/${rand}',
  cleanup: 'auto',
  envRows: [{ k: 'GREETING', v: 'hello' }],
  inheritEnv: true,
  credRows: [],
  artifactsText: 'out/**',
  artifactsWhen: 'on_success',
};

let rowSeq = 0;
const newCred = () => ({
  id: ++rowSeq, name: '', type: 'value', as: 'env', mask: true,
  value: '', values: [{ k: '', v: '' }], login: '', password: '', from: '', path: '', command: '', timeout: '',
});

/** Copy of the form without inline secret values — what presets store. */
function withoutSecrets(form) {
  return {
    ...form,
    credRows: form.credRows.map((c) => ({
      ...c,
      value: '',
      password: '',
      values: c.values.map((r) => ({ k: r.k, v: '' })),
    })),
  };
}

function credentialPayload(c) {
  const base = { name: c.name.trim(), type: c.type };
  if (c.as === 'file') base.as = 'file';
  if (!c.mask) base.mask = false;
  switch (c.type) {
    case 'value': return { ...base, value: c.value };
    case 'map': return {
      ...base,
      values: Object.fromEntries(c.values.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v])),
    };
    case 'login_password': return { ...base, login: c.login, password: c.password };
    case 'agent_env': return c.from.trim() ? { ...base, from: c.from.trim() } : base;
    case 'agent_file': return { ...base, path: c.path };
    case 'agent_cmd': return {
      ...base, command: c.command, ...(c.timeout ? { timeout_secs: Number(c.timeout) } : {}),
    };
    default: return base;
  }
}

function buildPayload(form) {
  const payload = { command: form.command };
  if (form.strict) payload.strict = true;
  if (form.workspace.trim()) payload.workspace = form.workspace.trim();
  if (form.cleanup !== 'auto') payload.cleanup = form.cleanup;
  const env = form.envRows.filter((r) => r.k.trim());
  if (env.length) payload.env = Object.fromEntries(env.map((r) => [r.k.trim(), r.v]));
  if (!form.inheritEnv) payload.inherit_env = false;
  const creds = form.credRows.filter((c) => c.name.trim());
  if (creds.length) payload.credentials = creds.map(credentialPayload);
  const artifacts = form.artifactsText.split('\n').map((s) => s.trim()).filter(Boolean);
  if (artifacts.length) {
    payload.artifacts = artifacts;
    if (form.artifactsWhen === 'always') payload.artifacts_when = 'always';
  }
  if (form.runner) payload.runner = form.runner;
  return payload;
}

function KeyValueRows({ rows, onChange, keyPlaceholder, valuePlaceholder, secret }) {
  const update = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div style={styles.rows}>
      {rows.map((r, i) => (
        <div key={i} style={styles.kvRow}>
          <input style={{ ...ss.monoInput, ...styles.kvKey }} value={r.k} placeholder={keyPlaceholder}
            onChange={(e) => update(i, { k: e.target.value })} />
          <input style={{ ...ss.monoInput, ...styles.kvValue }} value={r.v} placeholder={valuePlaceholder}
            type={secret ? 'password' : 'text'} autoComplete="off"
            onChange={(e) => update(i, { v: e.target.value })} />
          <button type="button" style={styles.iconBtn} title="Remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}><X size={14} /></button>
        </div>
      ))}
      <button type="button" style={styles.addBtn} onClick={() => onChange([...rows, { k: '', v: '' }])}>
        <Plus size={14} /> Add
      </button>
    </div>
  );
}

function CredentialRow({ cred, onChange, onRemove }) {
  const set = (patch) => onChange({ ...cred, ...patch });
  const text = (key, placeholder, extra = {}) => (
    <input style={{ ...ss.monoInput, ...styles.grow }} value={cred[key]} placeholder={placeholder}
      autoComplete="off" onChange={(e) => set({ [key]: e.target.value })} {...extra} />
  );
  return (
    <div style={styles.credCard}>
      <div style={styles.kvRow}>
        <input style={{ ...ss.monoInput, ...styles.kvKey }} value={cred.name}
          placeholder={cred.type === 'map' ? 'label' : 'VAR_NAME'} onChange={(e) => set({ name: e.target.value })} />
        <select style={ss.input} value={cred.type} onChange={(e) => set({ type: e.target.value })}>
          {CRED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={ss.input} value={cred.as} onChange={(e) => set({ as: e.target.value })}
          title="env: the variable holds the value; file: it holds a path to a 0600 file">
          <option value="env">as env</option>
          <option value="file">as file</option>
        </select>
        <label style={styles.checkLabel}>
          <input type="checkbox" checked={cred.mask} onChange={(e) => set({ mask: e.target.checked })} /> mask
        </label>
        <button type="button" style={styles.iconBtn} title="Remove credential" onClick={onRemove}><X size={14} /></button>
      </div>
      <div style={styles.kvRow}>
        {cred.type === 'value' && text('value', 'secret value', { type: 'password' })}
        {cred.type === 'login_password' && <>
          {text('login', 'login')}
          {text('password', 'password', { type: 'password' })}
        </>}
        {cred.type === 'agent_env' && text('from', `agent variable (default: ${cred.name || 'name'})`)}
        {cred.type === 'agent_file' && text('path', '~/.secrets/token — read on the agent host')}
        {cred.type === 'agent_cmd' && <>
          {text('command', 'command run on the agent; stdout is the value')}
          <input style={{ ...ss.monoInput, width: '90px' }} value={cred.timeout} placeholder="30 s"
            onChange={(e) => set({ timeout: e.target.value.replace(/\D/g, '') })} />
        </>}
      </div>
      {cred.type === 'map' && (
        <KeyValueRows rows={cred.values} onChange={(values) => set({ values })}
          keyPlaceholder="VAR" valuePlaceholder="secret" secret />
      )}
    </div>
  );
}

const ShellJobApp = ({ apiKey, addDevEntry }) => {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [inputFiles, setInputFiles] = useState([]);
  const [agents, setAgents] = useState([]);
  const [presets, setPresets] = useState({});
  const [presetName, setPresetName] = useState('');
  const [taskIds, setTaskIds] = useState([]);

  const [currentTask, setCurrentTask] = useState(null);
  const [log, setLog] = useState('');
  const [result, setResult] = useState(null); // { status, output }
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pollingStatus, setPollingStatus] = useState('');
  const [outputBucket, setOutputBucket] = useState(null);

  const [capabilities] = useCapabilities('shell.', { setError });
  const shellCaps = useMemo(
    () => [...new Set(capabilities.map(stripCapabilityAttrs))].sort(),
    [capabilities],
  );
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!form.shellCap && shellCaps.length) {
      set({ shellCap: shellCaps.includes('shell.any') ? 'shell.any' : shellCaps[0] });
    }
  }, [shellCaps]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      setPresets(JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}') || {});
      setTaskIds(JSON.parse(localStorage.getItem(TASKS_KEY) || '[]') || []);
    } catch (e) {
      console.error('Failed to parse Shell Jobs data from localStorage', e);
    }
    apiFetch('/management/agents/list/online')
      .then((data) => setAgents(Array.isArray(data) ? data : []))
      .catch(() => setAgents([]));
  }, []);

  const pinnable = agents.filter((a) =>
    (a.capabilities || []).some((c) => stripCapabilityAttrs(c) === form.shellCap));

  useTaskPolling({
    currentTask,
    apiKey,
    addDevEntry,
    onResult: (data) => {
      setIsLoading(false);
      setResult({ status: data.status, output: data.output });
      if (data.log) setLog(data.log);
      setPollingStatus('');
      setCurrentTask(null);
    },
    onError: (msg) => {
      setIsLoading(false);
      setError(msg);
      setPollingStatus('');
      setCurrentTask(null);
    },
    onLog: setLog,
    onStatus: (status) => setPollingStatus(statusLabel(status)),
  });

  const handleSubmit = async () => {
    if (!form.shellCap) { setError('No shell.* capability is online.'); return; }
    if (!form.command.trim()) { setError('Command is empty.'); return; }
    setIsLoading(true);
    setResult(null);
    setError(null);
    setLog('');
    setPollingStatus('Preparing...');
    let inputBucket = null;
    let outBucket = null;
    try {
      const payload = buildPayload(form);
      if (inputFiles.length) {
        setPollingStatus(`Uploading ${inputFiles.length} input file(s)...`);
        const created = await clientFetch('/api/storage/bucket/create?rm_after_task=true', apiKey,
          { method: 'POST', _label: 'Create input bucket' }, addDevEntry);
        inputBucket = created.bucket_uid;
        for (const file of inputFiles) {
          const fd = new FormData();
          fd.append('file', file, file.name);
          await clientFetch(`/api/storage/bucket/${inputBucket}/upload`, apiKey,
            { method: 'POST', body: fd, _label: `Upload ${file.name}` }, addDevEntry);
        }
      }
      if (payload.artifacts) {
        const created = await clientFetch('/api/storage/bucket/create', apiKey,
          { method: 'POST', _label: 'Create output bucket' }, addDevEntry);
        outBucket = created.bucket_uid;
      }

      const body = { capability: form.shellCap, urgent: false, payload, apiKey };
      if (form.runtimeSecs) body.runtimeSecs = Number(form.runtimeSecs);
      if (inputBucket) body.file_bucket = [inputBucket];
      if (outBucket) body.output_bucket = outBucket;

      setPollingStatus('Submitting task...');
      const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      addDevEntry?.({ label: 'Submit shell job', method: 'POST', url: '/api/task/submit', request: body, response: data });
      if (!data.id?.id || !data.id?.cap) {
        throw new Error(data.error?.message || 'Unexpected response from submit endpoint.');
      }
      setOutputBucket(outBucket);
      const entry = `${data.id.cap}/${data.id.id}`;
      const next = [entry, ...taskIds.filter((t) => t !== entry)].slice(0, 50);
      setTaskIds(next);
      localStorage.setItem(TASKS_KEY, JSON.stringify(next));
      setCurrentTask({ id: data.id.id, capability: data.id.cap });
    } catch (err) {
      await deleteBucket(inputBucket, apiKey);
      await deleteBucket(outBucket, apiKey);
      setError(err.message);
      setIsLoading(false);
      setPollingStatus('');
    }
  };

  const handleCancel = async () => {
    if (!currentTask) return;
    const { id, capability } = currentTask;
    setPollingStatus('Cancelling...');
    await cancelTask(capability, id, apiKey, addDevEntry);
    // Keep polling: the final poll carries the partial output of the cancelled job.
  };

  const reattach = (entry) => {
    const idx = entry.indexOf('/');
    setResult(null);
    setError(null);
    setLog('');
    setOutputBucket(null);
    setIsLoading(true);
    setCurrentTask({ capability: entry.slice(0, idx), id: entry.slice(idx + 1) });
  };

  const downloadArtifact = async (a) => {
    const url = `/api/storage/bucket/${a.bucket_uid}/file/${a.file_uid}`;
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
      addDevEntry?.({ label: `Download ${a.path}`, method: 'GET', url, request: null,
        response: { status: res.status, size: res.headers.get('content-length') } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blobUrl = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = a.path.split('/').pop();
      link.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    }
  };

  const dropOutputBucket = async () => {
    await deleteBucket(outputBucket, apiKey);
    addDevEntry?.({ label: 'Delete output bucket', method: 'DELETE', url: `/api/storage/bucket/${outputBucket}`, request: null, response: {} });
    setOutputBucket(null);
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = { ...presets, [name]: withoutSecrets(form) };
    setPresets(next);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
  };
  const loadPreset = (name) => {
    const p = presets[name];
    if (!p) return;
    setPresetName(name);
    setForm({ ...DEFAULT_FORM, ...p, credRows: (p.credRows || []).map((c) => ({ ...newCred(), ...c, id: ++rowSeq })) });
  };
  const deletePreset = () => {
    const next = { ...presets };
    delete next[presetName];
    setPresets(next);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
    setPresetName('');
  };

  const out = result?.output;
  const hasInlineSecrets = form.credRows.some((c) => ['value', 'map', 'login_password'].includes(c.type));

  return (
    <div style={ss.content}>
      <div style={ss.form}>
        <div style={styles.presetBar}>
          <select style={ss.input} value={presets[presetName] ? presetName : ''} onChange={(e) => loadPreset(e.target.value)}>
            <option value="">Presets…</option>
            {Object.keys(presets).sort().map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input style={{ ...ss.input, ...styles.grow }} value={presetName} placeholder="preset name"
            onChange={(e) => setPresetName(e.target.value)} />
          <button type="button" style={styles.addBtn} onClick={savePreset} title="Save the form (inline secret values are not saved)">
            <Save size={14} /> Save
          </button>
          {presets[presetName] && (
            <button type="button" style={styles.iconBtn} onClick={deletePreset} title="Delete preset"><Trash2 size={14} /></button>
          )}
        </div>

        <div style={ss.rowWrap}>
          <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
            <label style={ss.label}>Shell</label>
            <select style={ss.input} value={form.shellCap} onChange={(e) => set({ shellCap: e.target.value, runner: '' })}>
              {shellCaps.length === 0 && <option value="">no shell.* online</option>}
              {shellCaps.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
            <label style={ss.label}>Agent</label>
            <select style={ss.input} value={form.runner} onChange={(e) => set({ runner: e.target.value })}>
              <option value="">any agent with {form.shellCap || 'the shell'}</option>
              {pinnable.map((a) => (
                <option key={a.uid} value={a.uid}>
                  {a.displayName || a.uidShort} · {a.systemInfo?.os}/{a.systemInfo?.cpuArch} · {a.uidShort}
                </option>
              ))}
            </select>
          </div>
          <div style={{ ...ss.formGroup, flex: '0 1 120px' }}>
            <label style={ss.label}>Timeout (s)</label>
            <input style={ss.inputInDimensionField} value={form.runtimeSecs} placeholder="600"
              onChange={(e) => set({ runtimeSecs: e.target.value.replace(/\D/g, '') })} />
          </div>
        </div>

        <div style={ss.formGroup}>
          <div style={ss.labelRow}>
            <label style={{ ...ss.label, marginBottom: 0 }}>Command</label>
            <label style={styles.checkLabel}>
              <input type="checkbox" checked={form.strict} onChange={(e) => set({ strict: e.target.checked })} />
              strict (set -euo pipefail / $ErrorActionPreference)
            </label>
          </div>
          <textarea style={{ ...ss.textarea, fontFamily: 'monospace', minHeight: '110px' }} value={form.command}
            onChange={(e) => set({ command: e.target.value })} spellCheck={false} />
        </div>

        <div style={ss.formGroup}>
          <label style={ss.label}>Workspace</label>
          <div style={styles.kvRow}>
            <input style={{ ...ss.monoInput, ...styles.grow }} value={form.workspace}
              placeholder="empty = fresh per-task directory; relative = under the agent's workspace root"
              onChange={(e) => set({ workspace: e.target.value })} />
            <select style={ss.input} value={form.cleanup} onChange={(e) => set({ cleanup: e.target.value })}
              title="auto: delete when the path contains ${rand} or is the default; never deletes a directory the task did not create">
              {['auto', 'always', 'on_success', 'never'].map((m) => <option key={m} value={m}>cleanup: {m}</option>)}
            </select>
          </div>
          <div style={styles.chips}>
            {WORKSPACE_TOKENS.map((t) => (
              <button type="button" key={t} style={styles.chip} onClick={() => set({ workspace: form.workspace + t })}>{t}</button>
            ))}
          </div>
        </div>

        <div style={ss.formGroup}>
          <div style={ss.labelRow}>
            <label style={{ ...ss.label, marginBottom: 0 }}>Environment</label>
            <label style={styles.checkLabel}>
              <input type="checkbox" checked={form.inheritEnv} onChange={(e) => set({ inheritEnv: e.target.checked })} />
              inherit agent environment
            </label>
          </div>
          <KeyValueRows rows={form.envRows} onChange={(envRows) => set({ envRows })}
            keyPlaceholder="NAME" valuePlaceholder="value — may use ${env:PATH}, ${rand}" />
        </div>

        <div style={ss.formGroup}>
          <label style={ss.label}>Credentials</label>
          <div style={styles.rows}>
            {form.credRows.map((c) => (
              <CredentialRow key={c.id} cred={c}
                onChange={(next) => set({ credRows: form.credRows.map((x) => (x.id === c.id ? next : x)) })}
                onRemove={() => set({ credRows: form.credRows.filter((x) => x.id !== c.id) })} />
            ))}
            <button type="button" style={styles.addBtn} onClick={() => set({ credRows: [...form.credRows, newCred()] })}>
              <Plus size={14} /> Add credential
            </button>
            {hasInlineSecrets && (
              <div style={styles.hint}>
                Inline values (value, map, login_password) are stored in plain form in the task payload and
                shown in task lists. The agent masks them in output only.
              </div>
            )}
          </div>
        </div>

        <div style={ss.rowWrap}>
          <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
            <label style={ss.label}>Input files → workspace</label>
            <input type="file" multiple onChange={(e) => setInputFiles([...e.target.files])} />
            {inputFiles.length > 0 && (
              <div style={styles.hint}>{inputFiles.map((f) => `${f.name} (${fmtBytes(f.size)})`).join(', ')}</div>
            )}
          </div>
          <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
            <div style={ss.labelRow}>
              <label style={{ ...ss.label, marginBottom: 0 }}>Artifacts (globs, one per line)</label>
              <select style={ss.input} value={form.artifactsWhen} onChange={(e) => set({ artifactsWhen: e.target.value })}>
                <option value="on_success">on success</option>
                <option value="always">always</option>
              </select>
            </div>
            <textarea style={{ ...ss.textarea, fontFamily: 'monospace' }} rows={2} value={form.artifactsText}
              placeholder="dist/**&#10;reports/*.xml" onChange={(e) => set({ artifactsText: e.target.value })} />
          </div>
        </div>

        <div style={styles.kvRow}>
          <button type="button" style={ss.button} onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? 'Running…' : 'Run'}
          </button>
          {currentTask && (
            <button type="button" style={{ ...ss.button, backgroundColor: 'var(--danger)' }} onClick={handleCancel}>Cancel</button>
          )}
          {pollingStatus && <span style={styles.hint}>{pollingStatus}</span>}
        </div>
      </div>

      {error && <div style={ss.error}>{error}</div>}

      {(log || isLoading) && !out && (
        <div style={ss.responseContainer}>
          <div style={ss.responseLabel}>Live log</div>
          <TerminalOutput response={{ stdout: log || '…' }} style={{ maxHeight: '24em', overflowY: 'auto' }} />
        </div>
      )}

      {out && (
        <div style={ss.responseContainer}>
          <div style={styles.resultHeader}>
            <span style={{ ...styles.badge, background: result.status === 'completed' ? '#16a34a' : result.status === 'cancelled' ? '#d97706' : '#dc2626' }}>
              {result.status}{out.exit_code !== undefined ? ` · exit ${out.exit_code}` : ''}
            </span>
            {out.shell && <span style={styles.hint}>{out.shell} ({out.shell_path})</span>}
            {out.duration_ms !== undefined && <span style={styles.hint}>{(out.duration_ms / 1000).toFixed(1)} s</span>}
            {out.timed_out && <span style={styles.hint}>timed out</span>}
          </div>
          {out.workspace && <div style={styles.hint}>workspace: <code>{out.workspace}</code></div>}
          {(out.stdout_truncated || out.stderr_truncated) && (
            <div style={styles.hint}>Output truncated to the last 256 KiB per stream.</div>
          )}
          {out.error && result.status !== 'completed' && !out.stderr && <div style={ss.error}>{out.error}</div>}
          <TerminalOutput response={{ stdout: out.stdout, stderr: out.stderr }} style={{ maxHeight: '24em', overflowY: 'auto' }} />

          {(out.artifacts?.length > 0 || out.artifacts_missing?.length > 0 || out.artifacts_skipped) && (
            <div style={styles.artifacts}>
              <div style={ss.responseLabel}>Artifacts</div>
              {out.artifacts?.map((a) => (
                <div key={a.file_uid} style={styles.artifactRow}>
                  <code style={styles.grow}>{a.path}</code>
                  <span style={styles.hint}>{fmtBytes(a.size)}</span>
                  <button type="button" style={styles.addBtn} onClick={() => downloadArtifact(a)}><Download size={14} /> Download</button>
                </div>
              ))}
              {out.artifacts_missing?.length > 0 && (
                <div style={styles.hint}>No match: {out.artifacts_missing.join(', ')}</div>
              )}
              {out.artifacts_skipped && <div style={styles.hint}>Skipped: the command failed (artifacts_when = on_success).</div>}
              {outputBucket && (
                <button type="button" style={styles.addBtn} onClick={dropOutputBucket}><Trash2 size={14} /> Delete output bucket</button>
              )}
            </div>
          )}
        </div>
      )}

      {taskIds.length > 0 && (
        <div style={styles.recent}>
          <div style={ss.responseLabel}>Recent tasks</div>
          {taskIds.slice(0, 10).map((t) => (
            <button type="button" key={t} style={styles.recentBtn} onClick={() => reattach(t)} disabled={isLoading}>{t}</button>
          ))}
        </div>
      )}
    </div>
  );
};

const styles = {
  rows: { display: 'flex', flexDirection: 'column', gap: '6px' },
  kvRow: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
  kvKey: { flex: '0 1 180px', minWidth: 0 },
  kvValue: { flex: '1 1 200px', minWidth: 0 },
  grow: { flex: '1 1 200px', minWidth: 0 },
  credCard: {
    display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px',
    border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--glass)',
  },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', padding: '6px', border: '1px solid var(--border)',
    borderRadius: '6px', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
  },
  addBtn: {
    display: 'inline-flex', alignItems: 'center', gap: '4px', alignSelf: 'flex-start', padding: '6px 10px',
    fontSize: '13px', border: '1px solid var(--border)', borderRadius: '6px', background: 'transparent',
    color: 'var(--text)', cursor: 'pointer',
  },
  checkLabel: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--muted)' },
  chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' },
  chip: {
    padding: '2px 8px', fontSize: '12px', fontFamily: 'monospace', border: '1px solid var(--border)',
    borderRadius: '999px', background: 'var(--code-bg)', color: 'var(--text)', cursor: 'pointer',
  },
  hint: { fontSize: '12px', color: 'var(--muted)' },
  presetBar: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
  resultHeader: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' },
  badge: { color: '#fff', fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px' },
  artifacts: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' },
  artifactRow: { display: 'flex', gap: '8px', alignItems: 'center' },
  recent: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '16px' },
  recentBtn: {
    textAlign: 'left', fontFamily: 'monospace', fontSize: '12px', padding: '4px 8px', border: 'none',
    background: 'transparent', color: 'var(--accent)', cursor: 'pointer',
  },
};

export default ShellJobApp;
