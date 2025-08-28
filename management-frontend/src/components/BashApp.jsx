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
                {response && <pre style={styles.response}>{JSON.stringify(response, null, 2)}</pre>}
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