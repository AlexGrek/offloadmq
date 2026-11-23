import { useId, useRef, useState } from 'react';
import { runSlavemodeAndPoll } from './slavemodeApi';
import './ComfyManagerModal.css';

const PROCESS_ACTIONS = [
    ['status', 'Refresh status'],
    ['start', 'Start'],
    ['stop', 'Stop'],
    ['restart', 'Restart'],
];

function workflowRef({ name, namespace }) {
    return namespace ? `${namespace}.${name}` : name;
}

function downloadBundles(bundles) {
    const single = bundles.length === 1;
    const value = single ? bundles[0] : bundles;
    const stem = single ? workflowRef(value) : 'comfy-workflows';
    const safeStem = stem?.replace(/[^a-z0-9._-]/gi, '_').replace(/^\.+/, '') || 'comfy-workflows';
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeStem}.omqwf.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readBundles(file) {
    const contents = await file.text();
    let value;
    try {
        value = JSON.parse(contents);
    } catch {
        throw new Error(`${file.name} contains invalid JSON.`);
    }
    const bundles = Array.isArray(value) ? value : [value];
    if (!bundles.length || bundles.some(bundle => !bundle || typeof bundle !== 'object' || Array.isArray(bundle))) {
        throw new Error(`${file.name} must contain a workflow bundle or an array of bundles.`);
    }
    return bundles;
}

export default function ComfyManagerModal({ agentUid, hasControl, hasExport, hasImport, onDone }) {
    const dialog = useRef(null);
    const titleId = useId();
    const namespaceId = useId();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [process, setProcess] = useState(null);
    const [workflow, setWorkflow] = useState('');
    const [skipped, setSkipped] = useState([]);
    const [bundles, setBundles] = useState([]);
    const [name, setName] = useState('');
    const [namespace, setNamespace] = useState('keep');
    const [overwrite, setOverwrite] = useState(false);

    async function run(operation, task) {
        if (busy) return;
        setBusy(true);
        setError('');
        setMessage(operation);
        try {
            await task();
        } catch (err) {
            setError(err.message);
            setMessage('');
        } finally {
            setBusy(false);
        }
    }

    function control(action) {
        return run('Submitting ComfyUI command…', async () => {
            const timeoutSeconds = action === 'start' || action === 'restart' ? 360 : 60;
            setProcess(null);
            try {
                const status = await runSlavemodeAndPoll('slavemode.comfy-ctrl', agentUid, { action }, {
                    timeoutSeconds, onProgress: setMessage,
                });
                setProcess(status);
                setMessage('');
            } finally {
                if (action !== 'status') onDone?.();
            }
        });
    }

    function exportWorkflows(event) {
        event.preventDefault();
        return run('Requesting workflow export…', async () => {
            setSkipped([]);
            const ref = workflow.trim();
            const result = await runSlavemodeAndPoll('slavemode.comfy-export', agentUid, ref ? { workflow: ref } : {}, {
                onProgress: setMessage,
            });
            if (!Array.isArray(result?.bundles)) throw new Error('Agent returned an invalid workflow export.');
            setSkipped(result.skipped ?? []);
            const count = result.bundles.length;
            if (count) downloadBundles(result.bundles);
            setMessage(count ? `Exported ${count} workflow${count === 1 ? '' : 's'}.` : 'No workflows were exported.');
        });
    }

    function selectFiles(event) {
        const input = event.currentTarget;
        const files = Array.from(input.files);
        setBundles([]);
        setName('');
        setNamespace('keep');
        return run('Reading workflow bundles…', async () => {
            try {
                const selected = (await Promise.all(files.map(readBundles))).flat();
                setBundles(selected);
                setMessage('');
            } catch (err) {
                input.value = '';
                throw err;
            }
        });
    }

    function importWorkflows(event) {
        event.preventDefault();
        if (!bundles.length) return;
        return run('Requesting workflow import…', async () => {
            const payload = { bundles, overwrite };
            if (bundles.length === 1) {
                if (name.trim()) payload.name = name.trim();
                if (namespace !== 'keep') payload.namespace = namespace;
            }
            try {
                const result = await runSlavemodeAndPoll('slavemode.comfy-import', agentUid, payload, {
                    onProgress: setMessage,
                });
                setMessage(`Imported ${result.imported.map(workflowRef).join(', ')}.`);
            } finally {
                // Partial imports also change the agent's workflow inventory.
                onDone?.();
            }
        });
    }

    return (
        <>
            <button type="button" className="btn comfy-slavemode-trigger" onClick={() => {
                dialog.current.showModal();
                if (hasControl && !process) control('status');
            }}>
                ComfyUI
            </button>
            <dialog ref={dialog} className="comfy-slavemode" aria-labelledby={titleId}>
                <header>
                    <h2 id={titleId}>ComfyUI</h2>
                    <button type="button" className="btn" onClick={() => dialog.current.close()}>Close</button>
                </header>
                {hasControl && (
                    <section>
                        <h3>Server</h3>
                        <div className="comfy-slavemode-actions">
                            {PROCESS_ACTIONS.map(([action, label]) => (
                                <button key={action} type="button" className="btn" disabled={busy} onClick={() => control(action)}>
                                    {label}
                                </button>
                            ))}
                        </div>
                        {process && (
                            <>
                                <div>
                                    <strong>{process.state}</strong>
                                    {process.pid != null && <span> · PID {process.pid}</span>}
                                    {process.url && <div>{process.url}</div>}
                                    {process.configProblem && <div>{process.configProblem}</div>}
                                    {process.lastError && <div>{process.lastError}</div>}
                                </div>
                                <details>
                                    <summary>Process details</summary>
                                    <pre>{JSON.stringify(process, null, 2)}</pre>
                                </details>
                            </>
                        )}
                    </section>
                )}
                {hasExport && (
                    <section>
                        <h3>Export workflows</h3>
                        <form onSubmit={exportWorkflows}>
                            <label>
                                Workflow reference (optional)
                                <input value={workflow} onChange={e => setWorkflow(e.target.value)} placeholder="All workflows" disabled={busy} />
                            </label>
                            <button className="btn" type="submit" disabled={busy}>Download bundles</button>
                        </form>
                        {skipped.length > 0 && (
                            <div>Skipped workflows
                                <ul>{skipped.map((item, index) => <li key={index}>{item}</li>)}</ul>
                            </div>
                        )}
                    </section>
                )}
                {hasImport && (
                    <section>
                        <h3>Import workflows</h3>
                        <form onSubmit={importWorkflows}>
                            <label>
                                Workflow bundle files
                                <input type="file" accept=".json,application/json" multiple onChange={selectFiles} disabled={busy} />
                            </label>
                            {bundles.length === 1 && (
                                <div className="comfy-slavemode-actions">
                                    <label>
                                        Workflow name (optional)
                                        <input value={name} onChange={e => setName(e.target.value)} disabled={busy} />
                                    </label>
                                    <div className="comfy-slavemode-field">
                                        <label htmlFor={namespaceId}>Namespace</label>
                                        <select id={namespaceId} value={namespace} onChange={e => setNamespace(e.target.value)} disabled={busy}>
                                            <option value="keep">Keep bundle namespace</option>
                                            <option value="">imggen</option>
                                            <option value="img-utils">img-utils</option>
                                            <option value="txt2music">txt2music</option>
                                        </select>
                                    </div>
                                </div>
                            )}
                            <label className="comfy-slavemode-checkbox">
                                <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} disabled={busy} />
                                Overwrite existing task types
                            </label>
                            <button className="btn primary" type="submit" disabled={busy || !bundles.length}>Import bundles</button>
                        </form>
                    </section>
                )}
                <div role="status">{message}</div>
                {error && <div role="alert">{error}</div>}
            </dialog>
        </>
    );
}
