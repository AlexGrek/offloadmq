import React, { useState } from 'react';
import { sandboxStyles as ss } from '../sandboxStyles';
import { useCapabilities } from '../hooks/useCapabilities';
import TerminalOutput from './TerminalOutput';

const BashApp = ({ apiKey, addDevEntry }) => {
    const [command, setCommand] = useState('ls -la');

    const [response, setResponse] = useState(null);
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    const [capabilities] = useCapabilities('shell', { setError });

    const escapeCommand = (cmd) => cmd.replace(/'/g, "'\"'\"'");

    const handleSubmit = async () => {
        setIsLoading(true);
        setResponse(null);
        setError(null);

        const escapedCommand = escapeCommand(command);
        const bashCommand = `bash -c '${escapedCommand}'`;

        const payload = {
            capability: "shell.bash",
            urgent: true,
            payload: bashCommand,
            apiKey: apiKey,
        };

        try {
            const res = await fetch('/api/task/submit_blocking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json();
            addDevEntry?.({ label: 'Execute bash (blocking)', method: 'POST', url: '/api/task/submit_blocking', request: payload, response: data });

            if (data.error) {
                setError(data.error.message);
            } else if (data.result) {
                setResponse(data.result);
            } else {
                setError('Unexpected response format.');
            }
        } catch (err) {
            addDevEntry?.({ label: 'Execute bash (blocking)', method: 'POST', url: '/api/task/submit_blocking', request: payload, response: { error: err.message } });
            setError(`An error occurred: ${err.message}`);
        } finally {
            setIsLoading(false);
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

                <div style={ss.formGroup}>
                    <label style={styles.checkboxContainer}>
                        <input type="checkbox" checked={true} disabled={true} style={styles.checkbox} />
                        <span style={styles.checkboxLabel}>Urgent (always enabled)</span>
                    </label>
                </div>

                <button type="button" style={ss.greenButton} disabled={isLoading} onClick={handleSubmit}>
                    {isLoading ? 'Executing...' : 'Execute Command'}
                </button>
            </div>

            <div style={ss.responseContainer}>
                {isLoading && <p style={ss.loading}>Executing command...</p>}
                {error && <pre style={ss.error}>{error}</pre>}
                <TerminalOutput response={response} />
            </div>
        </div>
    );
};

const styles = {
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
};

export default BashApp;
