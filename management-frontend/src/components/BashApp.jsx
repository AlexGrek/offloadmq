import React, { useState, useEffect } from 'react';

// Main bash application component
const BashApp = ({ apiKey }) => {
    // State for input field and API response
    const [command, setCommand] = useState('ls -la');

    // State for displaying the response, loading status, and errors
    const [response, setResponse] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isDebug, setIsDebug] = useState(false);
    const [request, setRequest] = useState(null);
    const [capabilities, setCapabilities] = useState([]);

    useEffect(() => {
        const updCaps = async () => {
            setIsLoading(true);
            const payload = { apiKey }; // Use the apiKey passed via props
            try {
                setRequest(JSON.stringify(payload, null, 2));
                // Send the request to the specified endpoint
                const res = await fetch('/api/capabilities/online', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });

                // Parse the JSON response
                const data = await res.json();

                // Handle the response body structure
                if (data.error) {
                    setError(data.error.message);
                } else if (data) {
                    // Filter for shell capabilities
                    setCapabilities(data.filter((cap) => cap.startsWith("shell")));
                } else {
                    setError('Unexpected response format.');
                }
            } catch (err) {
                setError(`An error occurred: ${err.message}`);
            } finally {
                setIsLoading(false);
            }
        }

        updCaps();
    }, [apiKey]);

    // Function to escape single quotes in the command
    const escapeCommand = (cmd) => {
        return cmd.replace(/'/g, "'\"'\"'");
    };

    // Function to handle the API request
    const handleSubmit = async () => {
        setIsLoading(true);
        setResponse(null);
        setError(null);

        // Escape the command and construct the bash -c payload
        const escapedCommand = escapeCommand(command);
        const bashCommand = `bash -c '${escapedCommand}'`;

        // Construct the dynamic payload
        const payload = {
            capability: "shell::bash",
            urgent: true, // Always true and cannot be changed
            payload: bashCommand,
            apiKey: apiKey, // Use the apiKey passed via props
        };

        try {
            setRequest(JSON.stringify(payload, null, 2));
            // Send the request to the specified endpoint
            const res = await fetch('/api/task/submit_blocking', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            // Parse the JSON response
            const data = await res.json();

            // Handle the response body structure
            if (data.error) {
                setError(data.error.message);
            } else if (data.result) {
                // Set the result as the response
                setResponse(data.result);
            } else {
                setError('Unexpected response format.');
            }
        } catch (err) {
            setError(`An error occurred: ${err.message}`);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={styles.content}>
            <div style={styles.form}>
                <div style={styles.formGroup}>
                    <label htmlFor="command" style={styles.label}>Bash Command:</label>
                    <input
                        id="command"
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && !isLoading && handleSubmit()}
                        style={styles.input}
                        placeholder="Enter bash command..."
                    />
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

                <div style={styles.formGroup}>
                    <label style={styles.checkboxContainer}>
                        <input
                            type="checkbox"
                            checked={true}
                            disabled={true}
                            style={styles.checkbox}
                        />
                        <span style={styles.checkboxLabel}>Urgent (always enabled)</span>
                    </label>
                </div>

                <button type="button" style={styles.button} disabled={isLoading} onClick={handleSubmit}>
                    {isLoading ? 'Executing...' : 'Execute Command'}
                </button>
            </div>

            {/* Response/Error display area */}
            <div style={styles.responseContainer}>
                {isLoading && <p style={styles.loading}>Executing command...</p>}
                {error && <pre style={styles.error}>{error}</pre>}
                {response && (
                    <div style={styles.terminal}>
                        {(() => {
                            try {
                                // Try to parse as JSON
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
                                            {!parsed.stderr && !parsed.stdout && (
                                                <pre style={styles.streamContent}>
                                                    {JSON.stringify(parsed, null, 2)}
                                                </pre>
                                            )}
                                        </>
                                    );
                                } else {
                                    // Not the expected format, show as JSON
                                    return (
                                        <pre style={styles.streamContent}>
                                            {JSON.stringify(parsed, null, 2)}
                                        </pre>
                                    );
                                }
                            } catch (e) {
                                // Not valid JSON, show as raw text
                                return (
                                    <pre style={styles.streamContent}>
                                        {typeof response === 'string' ? response : JSON.stringify(response, null, 2)}
                                    </pre>
                                );
                            }
                        })()}
                    </div>
                )}
            </div>

            {!isDebug && <button style={styles.debugButton} onClick={() => setIsDebug(true)}>Enable debug mode</button>}
            {isDebug && (
                <div style={styles.responseContainer}>
                    <h4 style={styles.debugLabel}>Request Payload:</h4>
                    {request && <pre style={styles.response}>{request}</pre>}
                </div>
            )}
        </div>
    );
};

// Embedded CSS styles
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
        transition: 'border-color 0.2s',
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
        backgroundColor: '#28A745',
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'background-color 0.2s, transform 0.1s',
        alignSelf: 'flex-start',
        WebkitAppearance: 'none',
        MozAppearance: 'none',
        appearance: 'none',
    },
    debugButton: {
        padding: '6px 12px',
        fontSize: '12px',
        fontWeight: '400',
        color: '#666',
        backgroundColor: '#F8F9FA',
        border: '1px solid #D0D0D0',
        borderRadius: '4px',
        cursor: 'pointer',
        marginTop: '12px',
    },
    responseContainer: {
        marginTop: '24px',
        padding: '16px',
        backgroundColor: '#F7F7F7',
        border: '1px solid #E0E0E0',
        borderRadius: '8px',
    },
    debugLabel: {
        fontSize: '14px',
        fontWeight: '600',
        color: '#333',
        margin: '0 0 8px 0',
    },
    loading: {
        color: '#888',
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
        backgroundColor: '#000000',
        padding: '12px',
        borderRadius: '4px',
        border: '1px solid #333',
        fontFamily: 'Consolas, Monaco, "Courier New", monospace',
        fontSize: '13px',
        lineHeight: '1.4',
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
        marginBottom: '4px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
    },
    streamContent: {
        margin: '0',
        padding: '0',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        color: '#FFFFFF',
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

export default BashApp;