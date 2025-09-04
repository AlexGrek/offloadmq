import { Trash2 } from 'lucide-react';
import React, { useState, useEffect, useRef } from 'react';

// Main pipeline application component
const StreamingLLMApp = ({ apiKey }) => {
    // State for input field, history, and task IDs
    const [command, setCommand] = useState("What is the capital of Ukraine? Describe it with 8 sentences and do not mention it's name.");
    const [history, setHistory] = useState([]);
    const [taskIds, setTaskIds] = useState([]);
    const [model, setModel] = useState('dolphin-mistral');

    // State for displaying the response, loading status, errors, and current task being polled
    const [response, setResponse] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [pollingStatus, setPollingStatus] = useState('');
    const [currentTask, setCurrentTask] = useState(null); // {id, capability}

    // State for debugging
    const [isDebug, setIsDebug] = useState(false);
    const [request, setRequest] = useState(null);
    const [capabilities, setCapabilities] = useState([]);
    const [log, setLog] = useState('');

    // Ref to hold the interval ID for polling
    const pollIntervalRef = useRef(null);

    // Effect to load data from localStorage on initial render
    useEffect(() => {
        try {
            const storedHistory = localStorage.getItem('pipelineAppHistory');
            if (storedHistory) {
                setHistory(JSON.parse(storedHistory));
            }
            const storedTaskIds = localStorage.getItem('pipelineAppTaskIds');
            if (storedTaskIds) {
                setTaskIds(JSON.parse(storedTaskIds) || []);
            }
        } catch (e) {
            console.error("Failed to parse data from localStorage", e);
        }
    }, []);


    // Effect to fetch available capabilities
    useEffect(() => {
        const fetchCapabilities = async () => {
            const payload = { apiKey };
            try {
                const res = await fetch('/api/capabilities/online', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await res.json();
                if (data.error) {
                    setError(data.error.message);
                } else if (Array.isArray(data)) {
                    setCapabilities(data.filter((cap) => cap.startsWith("LLM")));
                } else {
                    setError('Unexpected capabilities response format.');
                }
            } catch (err) {
                setError(`An error occurred while fetching capabilities: ${err.message}`);
            }
        };

        fetchCapabilities();
    }, [apiKey]);

    // Effect to handle polling when a new task is submitted
    useEffect(() => {
        // Clear any existing interval when the component unmounts or a new task is set
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
        }

        if (!currentTask) {
            return;
        }

        const poll = async () => {
            setPollingStatus(`Polling for result of task ${currentTask.capability}/${currentTask.id}...`);
            try {
                // **CHANGED**: Send a POST request with the API key in the body for polling.
                const payload = { apiKey: apiKey };
                const res = await fetch(`/api/task/poll/${encodeURIComponent(currentTask.capability)}/${currentTask.id}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });
                const data = await res.json();

                // Check for a final result or an error to stop polling
                if (data.output) {
                    setIsLoading(false);
                    setResponse(data.output);
                    setPollingStatus('');
                    setCurrentTask(null); // Stop polling
                } else if (data.error) {
                    setIsLoading(false);
                    setError(data.error.message);
                    setPollingStatus('');
                    setCurrentTask(null); // Stop polling
                }
                if (data.log) {
                    setLog(data.log)
                }
                setPollingStatus("Status: " + data.status)
                // If neither result nor error, we are still pending, so the interval continues.

            } catch (err) {
                setIsLoading(false);
                setError(`Polling failed: ${err.message}`);
                setPollingStatus('');
                setCurrentTask(null); // Stop polling on network error
            }
        };

        // Start polling immediately and then on an interval
        poll();
        pollIntervalRef.current = setInterval(poll, 2000); // Poll every 3 seconds

        // Cleanup function to clear interval
        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
            }
        };
    }, [currentTask, apiKey]);

    // Function to handle the API request submission
    const handleSubmit = async () => {
        setIsLoading(true);
        setResponse(null);
        setError(null);
        setPollingStatus('Submitting task...');
        setCurrentTask(null); // Stop any previous polling

        // Update command history
        if (command) {
            const newHistory = [command, ...history.filter(h => h !== command)].slice(0, 20);
            setHistory(newHistory);
            localStorage.setItem('pipelineAppHistory', JSON.stringify(newHistory));
        }

        const modelllm = `LLM::${model}`

        const ollamaPayload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a helpful AI assistant."
                },
                {
                    "role": "user",
                    "content": command
                }
            ],
            "stream": true
        }

        const payload = {
            capability: modelllm,
            urgent: false,
            payload: ollamaPayload,
            apiKey: apiKey,
        };

        try {
            setRequest(JSON.stringify(payload, null, 2));
            const res = await fetch('/api/task/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json();

            if (data.error) {
                setError(data.error.message);
                setIsLoading(false);
                setPollingStatus('');
                // **CHANGED**: Handle the nested response structure: data.id.id and data.id.cap
            } else if (data.id && data.id.id && data.id.cap) {
                const taskId = data.id.id;
                const taskCapability = data.id.cap;

                // Store new task ID
                const newTaskIdString = `${taskCapability}/${taskId}`;
                const newTaskIds = [newTaskIdString, ...taskIds].slice(0, 100); // Store last 100 IDs
                setTaskIds(newTaskIds);
                localStorage.setItem('pipelineAppTaskIds', JSON.stringify(newTaskIds));

                // Start polling by setting the current task
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
        <div style={styles.content}>
            <div style={styles.form}>
                <div style={styles.formGroup}>
                    <label htmlFor="model" style={styles.label}>Model:</label>
                    <input
                        id="model"
                        type="text"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        style={styles.input}
                    />
                    <p style={{ lineHeight: 'normal' }}>{capabilities.map(cap => {
                        let strip = cap.replaceAll("LLM::", "");
                        return <a key={cap} style={{ marginRight: '8pt', display: 'inline', fontSize: 'x-small' }} href="#" onClick={() => setModel(strip)}>{strip}</a>
                    })}
                    </p>
                </div>

                <div style={styles.formGroup}>
                    <label htmlFor="command" style={styles.label}>Question:</label>
                    <input
                        id="command"
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && !isLoading && handleSubmit()}
                        style={styles.input}
                        placeholder="Question"
                        list="command-history"
                    />
                    <datalist id="command-history">
                        {history.map((cmd, index) => (
                            <option key={index} value={cmd} />
                        ))}
                    </datalist>
                </div>

                <button type="button" style={styles.button} disabled={isLoading} onClick={handleSubmit}>
                    {isLoading ? (pollingStatus.startsWith('Polling') ? 'Polling...' : 'Submitting...') : 'Ask'}
                </button>
            </div>

            {/* Response/Error display area */}
            <div style={styles.responseContainer}>
                {(isLoading || pollingStatus) && <p style={styles.loading}>{pollingStatus || 'Executing command...'}</p>}
                {error && <pre style={styles.error}>{error}</pre>}
                {response && (
                    <div style={styles.terminal}>
                        {(() => {
                            try {
                                const parsed = typeof response === 'string' ? JSON.parse(response) : response;
                                if (parsed && typeof parsed === 'object' && ('stderr' in parsed || 'stdout' in parsed)) {
                                    return (
                                        <>
                                            {parsed.stderr && (
                                                <div style={styles.stderr}>
                                                    <div style={styles.streamLabel}>stderr:</div>
                                                    <pre style={{ ...styles.streamContent, color: '#FF6B6B' }}>{parsed.stderr}</pre>
                                                </div>
                                            )}
                                            {parsed.stdout && (
                                                <div style={styles.stdout}>
                                                    <div style={styles.streamLabel}>stdout:</div>
                                                    <pre style={styles.streamContent}>{parsed.stdout}</pre>
                                                </div>
                                            )}
                                            {!parsed.stderr && !parsed.stdout && <pre style={styles.streamContent}>{JSON.stringify(parsed, null, 2)}</pre>}
                                        </>
                                    );
                                } else {
                                    return <pre style={styles.streamContent}>{JSON.stringify(parsed, null, 2)}</pre>;
                                }
                            } catch (e) {
                                return <pre style={styles.streamContent}>{typeof response === 'string' ? response : JSON.stringify(response, null, 2)}</pre>;
                            }
                        })()}
                    </div>
                )}
            </div>

            <div style={styles.form}>
                <div>
                    <p>{log}</p>
                </div>
            </div>
        </div>
    );
};

// --- Styles (mostly unchanged) ---
const styles = {
    content: {
        padding: '4px',
        backgroundColor: '#FFFFFF',
    },
    form: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
    },
    formGroup: {
        display: 'flex',
        flexDirection: 'column',
    },
    label: {
        fontSize: '14px',
        fontWeight: '600',
        color: '#333',
        marginBottom: '6px',
    },
    input: {
        padding: '8px 12px',
        fontSize: '14px',
        border: '1px solid #D0D0D0',
        borderRadius: '6px',
        outline: 'none',
        fontFamily: 'monospace',
    },
    checkboxContainer: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'not-allowed',
    },
    checkbox: {
        cursor: 'not-allowed',
    },
    checkboxLabel: {
        fontSize: '14px',
        color: '#666',
        cursor: 'not-allowed',
    },
    button: {
        padding: '10px 16px',
        fontSize: '14px',
        fontWeight: '600',
        color: '#FFF',
        backgroundColor: '#007BFF', // Changed color to distinguish from bash app
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        alignSelf: 'flex-start',
    },
    debugButton: {
        padding: '6px 12px',
        fontSize: '12px',
        color: '#666',
        backgroundColor: '#F8F9FA',
        border: '1px solid #D0D0D0',
        borderRadius: '4px',
        cursor: 'pointer',
        marginTop: '12px',
    },
    responseContainer: {
        display: 'none',
        marginTop: '24px',
        padding: '16px',
        backgroundColor: '#F7F7F7',
        border: '1px solid #E0E0E0',
        borderRadius: '8px',
    },
    taskIdsContainer: {
        marginTop: '20px',
    },
    taskList: {
        listStyle: 'none',
        padding: '8px 12px',
        margin: 0,
        backgroundColor: '#FFFFFF',
        border: '1px solid #E0E0E0',
        borderRadius: '4px',
        maxHeight: '150px',
        overflowY: 'auto',
        fontSize: '12px',
        fontFamily: 'monospace',
        color: '#333',
    },
    debugLabel: {
        fontSize: '14px',
        fontWeight: '600',
        color: '#333',
        margin: '0 0 8px 0',
    },
    loading: {
        color: '#555',
        fontStyle: 'italic',
    },
    response: {
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        fontSize: '12px',
        color: '#222',
        margin: '0',
        fontFamily: 'monospace',
        backgroundColor: '#FFFFFF',
        padding: '8px',
        border: '1px solid #E0E0E0',
        borderRadius: '4px',
    },
    terminal: {
        backgroundColor: 'whitesmoke',
        padding: '12px',
        borderRadius: '4px',
        border: '1px solid #333',
        fontFamily: 'Consolas, Monaco, "Courier New", monospace',
        fontSize: '13px',
        maxHeight: '24em',
        overflowY: 'auto'
    },
    stderr: {
        marginBottom: '8px',
    },
    stdout: {
        marginBottom: '8px',
    },
    streamLabel: {
        color: '#888',
        fontSize: '11px',
        textTransform: 'uppercase',
    },
    streamContent: {
        margin: '0',
        padding: '0',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        fontFamily: 'inherit',
        color: 'black',
    },
    error: {
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        fontSize: '12px',
        color: '#D9534F',
        margin: '0',
        fontFamily: 'monospace',
        backgroundColor: '#FFF5F5',
        padding: '8px',
        border: '1px solid #F5C6CB',
        borderRadius: '4px',
    },
};

export default StreamingLLMApp;