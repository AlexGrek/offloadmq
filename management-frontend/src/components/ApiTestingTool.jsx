import React, { useCallback, useState } from 'react';

// The main App component for the API testing tool.
const ApiTestingTool = () => {
    // State for form inputs and request parameters
    const [apiKey, setApiKey] = useState('client_secret_key_123');
    const [capability, setCapability] = useState('');
    const [isUrgent, setIsUrgent] = useState(false);
    const [payload, setPayload] = useState('{\n  "prompt": ""\n}');
    const [endpoint, setEndpoint] = useState('/api/task/submit');
    const [log, setLog] = useState('');

    // State for response display and loading status
    const [responseStatus, setResponseStatus] = useState(null);
    const [responseBody, setResponseBody] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const logStr = useCallback((text) => {
        setLog((log) => log + "\n" + text)
    }, []);

    // Function to handle the form submission and API call
    const handleSend = async () => {
        setIsLoading(true);
        setResponseStatus(null);
        setResponseBody('');

        try {
            // Construct the request body from state
            const requestBody = {
                capability: capability,
                urgent: isUrgent,
                payload: JSON.parse(payload),
                apiKey: apiKey
            };

            logStr(`requestBody: ` + JSON.stringify(requestBody, null, 2))
            logStr(`-> ${endpoint}`)

            // Perform the fetch request
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            });

            // Set the response status code
            setResponseStatus(response.status);

            // Get and set the response body, even on failure
            const responseData = await response.text();
            try {
                // Try to parse as JSON for a pretty display
                setResponseBody(JSON.stringify(JSON.parse(responseData), null, 2));
            } catch (error) {
                console.error(error)
                // If parsing fails, display the raw text
                setResponseBody(responseData);
            }
        } catch (error) {
            // Handle network errors or other exceptions
            setResponseStatus('Error');
            setResponseBody(`Request failed: ${error.message}`);
        } finally {
            // Reset loading state
            setIsLoading(false);
        }
    };

    // Inline CSS for the entire application, now with a light theme
    const styles = {
        container: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2rem',
            padding: '2rem',
            backgroundColor: '#f0f2f5',
            borderRadius: '1rem',
            boxShadow: '0 8px 16px rgba(0, 0, 0, 0.1)',
            maxWidth: '1280px',
            width: '100%',
            color: '#1f2937',
        },
        header: {
            fontSize: '2rem',
            fontWeight: 'bold',
            textAlign: 'center',
            color: '#3b82f6',
        },
        mainContent: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2rem',
            width: '100%',
        },
        panel: {
            flex: '1',
            minHeight: '400px',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            backgroundColor: '#ffffff',
            borderRadius: '0.75rem',
            padding: '1.5rem',
            boxShadow: '0 4px 8px rgba(0, 0, 0, 0.05)',
        },
        panelHeader: {
            fontSize: '1.25rem',
            fontWeight: '600',
            color: '#4b5563',
            borderBottom: '1px solid #e5e7eb',
            paddingBottom: '0.5rem',
        },
        input: {
            width: '100%',
            padding: '0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid #d1d5db',
            backgroundColor: '#ffffff',
            color: '#1f2937',
            outline: 'none',
        },
        textArea: {
            width: '100%',
            flex: '1',
            fontFamily: 'monospace',
            padding: '0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid #d1d5db',
            backgroundColor: '#ffffff',
            color: '#1f2937',
            outline: 'none',
            resize: 'vertical',
            minHeight: '200px',
        },
        checkboxContainer: {
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
        },
        checkbox: {
            width: '1.25rem',
            height: '1.25rem',
            borderRadius: '0.25rem',
            accentColor: '#3b82f6',
        },
        button: {
            padding: '0.75rem 1.5rem',
            backgroundColor: '#e5e7eb',
            color: '#1f2937',
            fontWeight: 'bold',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            border: '1px solid #d1d5db',
            outline: 'none',
            transition: 'background-color 0.2s, transform 0.1s',
        },
        buttonHover: {
            backgroundColor: '#d1d5db',
            transform: 'scale(1.02)',
        },
        statusContainer: {
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            marginBottom: '1rem',
        },
        statusLabel: {
            color: '#4b5563',
        },
        statusCode: {
            fontWeight: 'bold',
            padding: '0.25rem 0.75rem',
            borderRadius: '0.5rem',
            backgroundColor: responseStatus === 'Error' || (responseStatus >= 400 && responseStatus < 600) ? '#fca5a5' : (responseStatus >= 200 && responseStatus < 300) ? '#86efac' : '#fcd34d',
            color: '#1f2937'
        },
        loader: {
            border: '4px solid #f3f3f3',
            borderTop: '4px solid #3b82f6',
            borderRadius: '50%',
            width: '24px',
            height: '24px',
            animation: 'spin 1s linear infinite',
        },
        '@keyframes spin': {
            '0%': { transform: 'rotate(0deg)' },
            '100%': { transform: 'rotate(360deg)' },
        },
        responseBodyContainer: {
            flex: '1',
            overflow: 'auto',
        },
        pre: {
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
            fontFamily: 'monospace',
            backgroundColor: '#e5e7eb',
            padding: '1rem',
            borderRadius: '0.5rem',
            border: '1px solid #d1d5db',
            color: '#1f2937'
        },
        select: {
            width: '100%',
            padding: '0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid #d1d5db',
            backgroundColor: '#ffffff',
            color: '#1f2937',
            outline: 'none',
        }
    };

    // Media queries for responsiveness (desktop view)
    if (window.innerWidth >= 768) {
        styles.mainContent.flexDirection = 'row';
    }

    return (
        <div style={styles.container}>
            <h1 style={styles.header}>REST API Tester</h1>
            <div style={styles.mainContent}>
                {/* Request Panel */}
                <div style={styles.panel}>
                    <h2 style={styles.panelHeader}>Request</h2>
                    <label>
                        <span className="block mb-2 text-gray-400">API Key</span>
                        <input
                            type="text"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="Enter API Key"
                            style={styles.input}
                        />
                    </label>
                    <label>
                        <span className="block mb-2 text-gray-400">Endpoint</span>
                        <select
                            value={endpoint}
                            onChange={(e) => setEndpoint(e.target.value)}
                            style={styles.select}
                        >
                            <option value="/api/task/submit">/api/task/submit</option>
                            <option value="/api/task/submit_blocking">/api/task/submit_blocking</option>
                        </select>
                    </label>
                    <label>
                        <span className="block mb-2 text-gray-400">Capability</span>
                        <input
                            type="text"
                            value={capability}
                            onChange={(e) => setCapability(e.target.value)}
                            placeholder="e.g., TTS::kokoro"
                            style={styles.input}
                        />
                    </label>
                    <label style={styles.checkboxContainer}>
                        <input
                            type="checkbox"
                            checked={isUrgent}
                            onChange={(e) => setIsUrgent(e.target.checked)}
                            style={styles.checkbox}
                        />
                        <span className="text-gray-400">Urgent</span>
                    </label>
                    <label style={{ flex: '1', display: 'flex', flexDirection: 'column' }}>
                        <span className="block mb-2 text-gray-400">Payload (JSON)</span>
                        <textarea
                            value={payload}
                            onChange={(e) => setPayload(e.target.value)}
                            placeholder="Enter JSON payload"
                            style={styles.textArea}
                        />
                    </label>
                    <button
                        onClick={handleSend}
                        disabled={isLoading}
                        style={isLoading ? { ...styles.button, opacity: 0.5, cursor: 'not-allowed' } : styles.button}
                    >
                        {isLoading ? (
                            <div style={styles.loader}></div>
                        ) : (
                            'Send'
                        )}
                    </button>
                </div>

                {/* Response Panel */}
                <div style={styles.panel}>
                    <h2 style={styles.panelHeader}>Response</h2>
                    {responseStatus !== null && (
                        <div style={styles.statusContainer}>
                            <span style={styles.statusLabel}>Status Code:</span>
                            <span style={styles.statusCode}>{responseStatus}</span>
                        </div>
                    )}
                    <div style={styles.responseBodyContainer}>
                        <pre style={styles.pre}>
                            {responseBody}
                        </pre>
                    </div>
                </div>

                <pre>{log}</pre>
            </div>
        </div>
    );
};

export default ApiTestingTool;