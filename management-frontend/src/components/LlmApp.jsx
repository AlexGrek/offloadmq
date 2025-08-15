import React, { useState, useEffect } from 'react';

// Main application component
const LlmApp = ({ apiKey }) => {
  // State for input fields and API response
  const [model, setModel] = useState('dolphin-mistral');
  const [systemMessage, setSystemMessage] = useState("You are a witty, concise writing assistant that rewrites user text into microfiction (≤200 words) in the voice of a 1970s travel guide. Keep sentences short, sprinkle one ironic aside, and always end with a tiny surprise.");
  const [userMessage, setUserMessage] = useState("Write a 150-word kinky microfiction about a lost metro token that changes hands across Kyiv during a hot summer day. Include one vivid sensory detail, a brief character beat for two different holders, and finish with a twist that reframes the token's importance.");
  
  // State for displaying the response, loading status, and errors
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // Function to handle the API request
  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setResponse(null);
    setError(null);

    // Construct the dynamic payload based on user input
    const payload = {
      capability: `LLM::${model}`,
      urgent: true,
      payload: {
        model: model,
        stream: false,
        messages: [
          {
            role: "system",
            content: systemMessage,
          },
          {
            role: "user",
            content: userMessage,
          },
        ],
      },
      apiKey: apiKey, // Use the apiKey passed via props
    };

    try {
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
        // Directly set the message content as the response
        setResponse(data.result.message.content);
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
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.formGroup}>
          <label htmlFor="model" style={styles.label}>Model:</label>
          <input
            id="model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={styles.input}
          />
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="system" style={styles.label}>System Message:</label>
          <textarea
            id="system"
            value={systemMessage}
            onChange={(e) => setSystemMessage(e.target.value)}
            style={styles.textarea}
            rows="4"
          />
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="user" style={styles.label}>User Message:</label>
          <textarea
            id="user"
            value={userMessage}
            onChange={(e) => setUserMessage(e.target.value)}
            style={styles.textarea}
            rows="6"
          />
        </div>

        <button type="submit" style={styles.button} disabled={isLoading}>
          {isLoading ? 'Sending...' : 'Send Request'}
        </button>
      </form>

      {/* Response/Error display area */}
      <div style={styles.responseContainer}>
        {isLoading && <p style={styles.loading}>Loading...</p>}
        {error && <pre style={styles.error}>{error}</pre>}
        {response && <p style={styles.response}>{response}</p>}
      </div>
    </div>
  );
};

// Embedded CSS styles
const styles = {
  content: {
    padding: '24px',
    backgroundColor: '#FFFFFF', // Retained for a clean background
    borderRadius: '12px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.1), 0 0 1px rgba(0, 0, 0, 0.1)',
    border: '1px solid #E0E0E0',
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
  },
  textarea: {
    padding: '8px 12px',
    fontSize: '14px',
    border: '1px solid #D0D0D0',
    borderRadius: '6px',
    resize: 'vertical',
    outline: 'none',
  },
  button: {
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: '600',
    color: '#FFF',
    backgroundColor: '#007AFF',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.2s, transform 0.1s',
    alignSelf: 'flex-start',
    WebkitAppearance: 'none', // For better rendering on macOS
    MozAppearance: 'none',
    appearance: 'none',
  },
  responseContainer: {
    marginTop: '24px',
    padding: '16px',
    backgroundColor: '#F7F7F7',
    border: '1px solid #E0E0E0',
    borderRadius: '8px',
  },
  responseLabel: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#333',
    marginTop: '0',
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
  },
  error: {
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    fontSize: '12px',
    color: '#D9534F',
    margin: '0',
  },
};

export default LlmApp;
