import { Trash2 } from 'lucide-react';
import React, { useState, useEffect } from 'react';
import { sandboxStyles as ss } from '../sandboxStyles';
import { useCapabilities } from '../hooks/useCapabilities';
import { useTaskPolling } from '../hooks/useTaskPolling';
import TerminalOutput from './TerminalOutput';

const PipelineApp = ({ apiKey, addDevEntry }) => {
    const [command, setCommand] = useState('echo "Hello from a non-blocking task"');
    const [history, setHistory] = useState([]);
    const [taskIds, setTaskIds] = useState([]);

    const [response, setResponse] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [pollingStatus, setPollingStatus] = useState('');
    const [currentTask, setCurrentTask] = useState(null);
    const [log, setLog] = useState('');

    const [capabilities] = useCapabilities('shell', { setError });

    // Load history from localStorage
    useEffect(() => {
        try {
            const storedHistory = localStorage.getItem('pipelineAppHistory');
            if (storedHistory) setHistory(JSON.parse(storedHistory));
            const storedTaskIds = localStorage.getItem('pipelineAppTaskIds');
            if (storedTaskIds) setTaskIds(JSON.parse(storedTaskIds) || []);
        } catch (e) {
            console.error("Failed to parse data from localStorage", e);
        }
    }, []);

    useTaskPolling({
        currentTask,
        apiKey,
        addDevEntry,
        onResult: (data) => {
            setIsLoading(false);
            setResponse(data.output);
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
        onStatus: (status) => setPollingStatus("Status: " + status),
    });

    const escapeCommand = (cmd) => cmd.replace(/'/g, "'\"'\"'");

    const handleSubmit = async () => {
        setIsLoading(true);
        setResponse(null);
        setError(null);
        setPollingStatus('Submitting task...');
        setCurrentTask(null);

        if (command) {
            const newHistory = [command, ...history.filter(h => h !== command)].slice(0, 20);
            setHistory(newHistory);
            localStorage.setItem('pipelineAppHistory', JSON.stringify(newHistory));
        }

        const escapedCommand = escapeCommand(command);
        const bashCommand = `bash -c '${escapedCommand}'`;

        const payload = {
            capability: "shell.bash",
            urgent: false,
            payload: bashCommand,
            apiKey: apiKey,
        };

        try {
            const res = await fetch('/api/task/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json();
            addDevEntry?.({ label: 'Submit task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

            if (data.error) {
                setError(data.error.message);
                setIsLoading(false);
                setPollingStatus('');
            } else if (data.id && data.id.id && data.id.cap) {
                const taskId = data.id.id;
                const taskCapability = data.id.cap;

                const newTaskIdString = `${taskCapability}/${taskId}`;
                const newTaskIds = [newTaskIdString, ...taskIds].slice(0, 100);
                setTaskIds(newTaskIds);
                localStorage.setItem('pipelineAppTaskIds', JSON.stringify(newTaskIds));

                setCurrentTask({ id: taskId, capability: taskCapability });
            } else {
                setError('Unexpected response format from submit endpoint.');
                setIsLoading(false);
                setPollingStatus('');
            }
        } catch (err) {
            setError(`An error occurred: ${err.message}`);
            setIsLoading(false);
            setPollingStatus('');
        }
    };

    return (
        <div style={ss.content}>
            <div style={ss.form}>
                <div style={ss.formGroup}>
                    <label htmlFor="command" style={ss.label}>Bash Command:</label>
                    <input
                        id="command"
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && !isLoading && handleSubmit()}
                        style={ss.monoInput}
                        placeholder="Enter bash command or select from history..."
                        list="command-history"
                    />
                    <datalist id="command-history">
                        {history.map((cmd, index) => (
                            <option key={index} value={cmd} />
                        ))}
                    </datalist>

                    {capabilities.length > 0 && (
                        <p style={{ lineHeight: 'normal', marginTop: '4px' }}>
                            Available capabilities: {capabilities.map(cap => (
                                <span key={cap} style={{ marginRight: '8pt', fontSize: 'x-small', color: '#666' }}>
                                    {cap}
                                </span>
                            ))}
                        </p>
                    )}
                </div>

                <button type="button" style={ss.button} disabled={isLoading} onClick={handleSubmit}>
                    {isLoading ? (pollingStatus.startsWith('Polling') ? 'Polling...' : 'Submitting...') : 'Execute Command'}
                </button>
            </div>

            <div style={ss.responseContainer}>
                {(isLoading || pollingStatus) && <p style={ss.loading}>{pollingStatus || 'Executing command...'}</p>}
                {error && <pre style={ss.error}>{error}</pre>}
                <TerminalOutput response={response} style={{ maxHeight: '24em', overflowY: 'auto' }} />
            </div>

            <div style={ss.form}>
                <TerminalOutput response={log ? { stdout: log } : null} />
            </div>

            {taskIds && taskIds.length > 0 && (
                <div style={styles.taskIdsContainer}>
                    <h4 style={styles.debugLabel}>Submitted Task IDs:</h4>
                    <ul style={styles.taskList}>
                        {taskIds.map(id => <li key={id}>{id}</li>)}
                    </ul>
                    <button style={styles.debugButton} onClick={() => {
                        setTaskIds([]);
                        localStorage.setItem('pipelineAppTaskIds', []);
                    }}><Trash2 /></button>
                </div>
            )}
        </div>
    );
};

const styles = {
    taskIdsContainer: {
        marginTop: '20px',
    },
    taskList: {
        listStyle: 'none',
        padding: '8px 12px',
        margin: 0,
        background: 'var(--code-bg)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        maxHeight: '150px',
        overflowY: 'auto',
        fontSize: '12px',
        fontFamily: 'monospace',
        color: 'var(--text)',
    },
    debugLabel: {
        fontSize: '14px',
        fontWeight: '600',
        color: 'var(--text)',
        margin: '0 0 8px 0',
    },
    debugButton: {
        padding: '6px 12px',
        fontSize: '12px',
        color: 'var(--muted)',
        background: 'var(--glass)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        cursor: 'pointer',
        marginTop: '12px',
    },
};

export default PipelineApp;
