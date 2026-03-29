import React, { useState, useEffect } from 'react';
import { cancelTask } from '../sandboxUtils';
import { stripCapabilityAttrs } from '../utils';
import { sandboxStyles as ss } from '../sandboxStyles';
import { useCapabilities } from '../hooks/useCapabilities';
import { useTaskPolling } from '../hooks/useTaskPolling';
import ModelSelector from './ModelSelector';
import TerminalOutput from './TerminalOutput';
import SandboxMarkdown from './SandboxMarkdown';

const StreamingLLMApp = ({ apiKey, addDevEntry }) => {
    const [command, setCommand] = useState("What is the capital of Ukraine? Describe it with 8 sentences and do not mention it's name.");
    const [history, setHistory] = useState([]);
    const [taskIds, setTaskIds] = useState([]);
    const [model, setModel] = useState('');

    const [response, setResponse] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [pollingStatus, setPollingStatus] = useState('');
    const [currentTask, setCurrentTask] = useState(null);
    const [log, setLog] = useState('');

    const [capabilities] = useCapabilities('llm.', { setModel, setError });

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

    const handleCancel = async () => {
        if (!currentTask) return;
        const { id, capability } = currentTask;
        setCurrentTask(null);
        setIsLoading(false);
        setPollingStatus('Cancelled');
        await cancelTask(capability, id, apiKey, addDevEntry);
    };

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

        const modelllm = stripCapabilityAttrs(`llm.${model}`);

        const ollamaPayload = {
            model: model,
            messages: [
                { role: "system", content: "You are a helpful AI assistant." },
                { role: "user", content: command },
            ],
            stream: true,
        };

        const payload = {
            capability: modelllm,
            urgent: false,
            payload: ollamaPayload,
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
                    <label style={ss.label}>Model:</label>
                    <ModelSelector model={model} setModel={setModel} capabilities={capabilities} />
                </div>

                <div style={ss.formGroup}>
                    <label htmlFor="command" style={ss.label}>Question:</label>
                    <input
                        id="command"
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && !isLoading && handleSubmit()}
                        style={ss.monoInput}
                        placeholder="Question"
                        list="command-history"
                    />
                    <datalist id="command-history">
                        {history.map((cmd, index) => (
                            <option key={index} value={cmd} />
                        ))}
                    </datalist>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="button" style={ss.button} disabled={isLoading} onClick={handleSubmit}>
                        {isLoading ? (pollingStatus.startsWith('Polling') ? 'Polling...' : 'Submitting...') : 'Ask'}
                    </button>
                    {isLoading && currentTask && (
                        <button type="button" style={cancelBtnStyle} onClick={handleCancel}>Cancel</button>
                    )}
                </div>
            </div>

            <div style={ss.responseContainer}>
                {(isLoading || pollingStatus) && <p style={ss.loading}>{pollingStatus || 'Executing command...'}</p>}
                {error && <pre style={ss.error}>{error}</pre>}
                <TerminalOutput
                    response={response}
                    style={{ maxHeight: '24em', overflowY: 'auto', backgroundColor: 'var(--code-bg)' }}
                    contentColor="var(--text)"
                    markdown
                    markdownTone="light"
                />
            </div>

            {log ? (
                <div style={ss.form}>
                    <SandboxMarkdown tone="light" style={{ fontSize: '14px' }}>{log}</SandboxMarkdown>
                </div>
            ) : null}
        </div>
    );
};

const cancelBtnStyle = {
    padding: '8px 16px',
    borderRadius: '6px',
    background: 'var(--danger, #ef4444)',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 500,
};

export default StreamingLLMApp;
