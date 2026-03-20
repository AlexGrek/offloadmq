import React, { useState, useEffect } from 'react';
import { sandboxStyles as ss } from '../sandboxStyles';
import { fetchOnlineCapabilities, stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import { useTaskPolling } from '../hooks/useTaskPolling';
import TerminalOutput from './TerminalOutput';

/**
 * Parse a single capability attribute into a field descriptor.
 * Supports formats:
 *   "prompt"          → { name: "prompt", hint: null }
 *   "temperature:float" → { name: "temperature", hint: "float" }
 *   "max_tokens:int"   → { name: "max_tokens", hint: "int" }
 */
function parseFieldDescriptor(attr) {
  const colonIdx = attr.indexOf(':');
  if (colonIdx === -1) return { name: attr, hint: null };
  return { name: attr.slice(0, colonIdx), hint: attr.slice(colonIdx + 1) };
}

/**
 * Coerce a string value based on a type hint.
 */
function coerceValue(value, hint) {
  if (!hint || !value) return value;
  const h = hint.toLowerCase();
  if (h === 'int' || h === 'integer') {
    const n = parseInt(value, 10);
    return isNaN(n) ? value : n;
  }
  if (h === 'float' || h === 'number' || h === 'double') {
    const n = parseFloat(value);
    return isNaN(n) ? value : n;
  }
  if (h === 'bool' || h === 'boolean') {
    return value === 'true' || value === '1';
  }
  if (h === 'json' || h === 'object') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

const CustomApp = ({ apiKey, addDevEntry }) => {
  const [capabilities, setCapabilities] = useState([]);
  const [selectedCap, setSelectedCap] = useState('');
  const [fields, setFields] = useState([]);
  const [fieldValues, setFieldValues] = useState({});
  const [rawPayload, setRawPayload] = useState('');
  const [useRawPayload, setUseRawPayload] = useState(false);

  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pollingStatus, setPollingStatus] = useState('');
  const [currentTask, setCurrentTask] = useState(null);
  const [log, setLog] = useState('');

  // Fetch all extended online capabilities
  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchOnlineCapabilities();
        if (Array.isArray(data)) {
          setCapabilities(data.filter(c => typeof c === 'string'));
        }
      } catch (err) {
        setError(`Failed to fetch capabilities: ${err.message}`);
      }
    };
    load();
  }, []);

  // When selected capability changes, parse its attributes into fields
  useEffect(() => {
    if (!selectedCap) {
      setFields([]);
      setFieldValues({});
      return;
    }
    const attrs = parseCapabilityAttrs(selectedCap);
    const descriptors = attrs.map(parseFieldDescriptor);
    setFields(descriptors);
    const vals = {};
    descriptors.forEach(f => { vals[f.name] = ''; });
    setFieldValues(vals);
  }, [selectedCap]);

  useTaskPolling({
    currentTask,
    apiKey,
    addDevEntry,
    onResult: (data) => {
      setIsLoading(false);
      setResponse(data.output || data);
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
    onStatus: (status) => setPollingStatus('Status: ' + status),
  });

  const buildPayload = () => {
    if (useRawPayload) {
      try {
        return JSON.parse(rawPayload);
      } catch {
        return rawPayload;
      }
    }
    const payload = {};
    fields.forEach(f => {
      payload[f.name] = coerceValue(fieldValues[f.name], f.hint);
    });
    return payload;
  };

  const handleSubmit = async () => {
    if (!selectedCap) {
      setError('Please select a capability');
      return;
    }

    setIsLoading(true);
    setResponse(null);
    setError(null);
    setLog('');
    setPollingStatus('Submitting task...');
    setCurrentTask(null);

    const baseCap = stripCapabilityAttrs(selectedCap);
    const taskPayload = buildPayload();

    const body = {
      capability: baseCap,
      urgent: false,
      payload: taskPayload,
      apiKey,
    };

    try {
      const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      addDevEntry?.({
        label: 'Submit custom task',
        method: 'POST',
        url: '/api/task/submit',
        request: body,
        response: data,
      });

      if (data.error) {
        setError(data.error.message || String(data.error));
        setIsLoading(false);
        setPollingStatus('');
      } else if (data.id && data.id.id && data.id.cap) {
        setCurrentTask({ id: data.id.id, capability: data.id.cap });
        setPollingStatus('Polling for result...');
      } else {
        setError('Unexpected response format from submit endpoint.');
        setIsLoading(false);
        setPollingStatus('');
      }
    } catch (err) {
      setError(`Submit failed: ${err.message}`);
      setIsLoading(false);
      setPollingStatus('');
    }
  };

  const setFieldValue = (name, value) => {
    setFieldValues(prev => ({ ...prev, [name]: value }));
  };

  const baseCap = selectedCap ? stripCapabilityAttrs(selectedCap) : '';

  return (
    <div style={ss.content}>
      <div style={ss.form}>
        {/* Capability selector */}
        <div style={ss.formGroup}>
          <label style={ss.label}>Capability:</label>
          <select
            value={selectedCap}
            onChange={(e) => setSelectedCap(e.target.value)}
            style={ss.input}
          >
            <option value="">— select a capability —</option>
            {capabilities.map(cap => (
              <option key={cap} value={cap}>{cap}</option>
            ))}
          </select>
          {baseCap && baseCap !== selectedCap && (
            <span style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
              Task will be submitted as: <code>{baseCap}</code>
            </span>
          )}
        </div>

        {/* Auto-detected fields OR raw payload toggle */}
        {selectedCap && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '13px', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input
                  type="checkbox"
                  checked={useRawPayload}
                  onChange={(e) => setUseRawPayload(e.target.checked)}
                />
                Raw JSON payload
              </label>
            </div>

            {useRawPayload ? (
              <div style={ss.formGroup}>
                <label style={ss.label}>Payload (JSON):</label>
                <textarea
                  value={rawPayload}
                  onChange={(e) => setRawPayload(e.target.value)}
                  style={{ ...ss.textarea, fontFamily: 'monospace', minHeight: '120px' }}
                  placeholder='{"key": "value"}'
                />
              </div>
            ) : (
              fields.length > 0 ? (
                fields.map(f => (
                  <div key={f.name} style={ss.formGroup}>
                    <label style={ss.label}>
                      {f.name}
                      {f.hint && <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: '6px', fontSize: '12px' }}>({f.hint})</span>}
                    </label>
                    {(f.hint === 'text' || f.hint === 'json' || f.hint === 'object') ? (
                      <textarea
                        value={fieldValues[f.name] || ''}
                        onChange={(e) => setFieldValue(f.name, e.target.value)}
                        style={{ ...ss.textarea, minHeight: '80px' }}
                        placeholder={f.hint ? `Enter ${f.hint}...` : `Enter ${f.name}...`}
                      />
                    ) : (
                      <input
                        type={f.hint === 'int' || f.hint === 'integer' || f.hint === 'float' || f.hint === 'number' ? 'number' : 'text'}
                        step={f.hint === 'float' || f.hint === 'number' ? 'any' : undefined}
                        value={fieldValues[f.name] || ''}
                        onChange={(e) => setFieldValue(f.name, e.target.value)}
                        style={ss.input}
                        placeholder={f.hint ? `Enter ${f.hint}...` : `Enter ${f.name}...`}
                      />
                    )}
                  </div>
                ))
              ) : (
                <p style={ss.defaultHint}>
                  No parameters detected in capability attributes. Use raw JSON payload or submit with empty payload.
                </p>
              )
            )}
          </>
        )}

        <button
          type="button"
          style={ss.button}
          disabled={isLoading || !selectedCap}
          onClick={handleSubmit}
        >
          {isLoading ? (pollingStatus.startsWith('Polling') ? 'Polling...' : 'Submitting...') : 'Run'}
        </button>
      </div>

      {/* Result area */}
      <div style={ss.responseContainer}>
        {(isLoading || pollingStatus) && <p style={ss.loading}>{pollingStatus || 'Running...'}</p>}
        {error && <pre style={ss.error}>{error}</pre>}
        <TerminalOutput response={response} style={{ maxHeight: '24em', overflowY: 'auto' }} />
      </div>

      {/* Live log area */}
      {log && (
        <div style={{ marginTop: '16px' }}>
          <label style={ss.label}>Live Log:</label>
          <TerminalOutput response={{ stdout: log }} style={{ maxHeight: '16em', overflowY: 'auto' }} />
        </div>
      )}
    </div>
  );
};

export default CustomApp;
