import React, { useState } from 'react';
import { stripCapabilityAttrs } from '../utils';
import { sandboxStyles as ss } from '../sandboxStyles';
import { useCapabilities } from '../hooks/useCapabilities';
import ModelSelector from './ModelSelector';
import SandboxMarkdown from './SandboxMarkdown';

const LlmApp = ({ apiKey, addDevEntry }) => {
  const [model, setModel] = useState('');
  const [systemMessage, setSystemMessage] = useState("You are a witty, concise writing assistant that rewrites user text into microfiction (≤200 words) in the voice of a 1970s travel guide. Keep sentences short, sprinkle one ironic aside, and always end with a tiny surprise.");
  const [userMessage, setUserMessage] = useState("Write a 150-word kinky microfiction about a lost metro token that changes hands across Kyiv during a hot summer day. Include one vivid sensory detail, a brief character beat for two different holders, and finish with a twist that reframes the token's importance.");

  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const [capabilities] = useCapabilities('llm.', { setModel, setError });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setResponse(null);
    setError(null);

    const payload = {
      capability: stripCapabilityAttrs(`llm.${model}`),
      urgent: true,
      payload: {
        model: model,
        stream: false,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
      },
      apiKey: apiKey,
    };

    try {
      const res = await fetch('/api/task/submit_blocking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      addDevEntry?.({ label: 'Submit task (blocking)', method: 'POST', url: '/api/task/submit_blocking', request: payload, response: data });

      if (data.error) {
        setError(data.error.message);
      } else if (data.result) {
        setResponse(data.result.message.content);
      } else {
        setError('Unexpected response format.');
      }
    } catch (err) {
      addDevEntry?.({ label: 'Submit task (blocking)', method: 'POST', url: '/api/task/submit_blocking', request: payload, response: { error: err.message } });
      setError(`An error occurred: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={ss.content}>
      <form onSubmit={handleSubmit} style={ss.form}>
        <div style={ss.formGroup}>
          <label style={ss.label}>Model:</label>
          <ModelSelector model={model} setModel={setModel} capabilities={capabilities} />
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="system" style={ss.label}>System Message:</label>
          <textarea
            id="system"
            value={systemMessage}
            onChange={(e) => setSystemMessage(e.target.value)}
            style={ss.textarea}
            rows="4"
          />
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="user" style={ss.label}>User Message:</label>
          <textarea
            id="user"
            value={userMessage}
            onChange={(e) => setUserMessage(e.target.value)}
            style={ss.textarea}
            rows="6"
          />
        </div>

        <button type="submit" style={ss.button} disabled={isLoading}>
          {isLoading ? 'Sending...' : 'Send Request'}
        </button>
      </form>

      <div style={ss.responseContainer}>
        {isLoading && <p style={ss.loading}>Loading...</p>}
        {error && <pre style={ss.error}>{error}</pre>}
        {response && <SandboxMarkdown tone="light" style={{ fontSize: '14px' }}>{response}</SandboxMarkdown>}
      </div>
    </div>
  );
};

export default LlmApp;
