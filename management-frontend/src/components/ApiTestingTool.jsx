import React, { useEffect, useState } from 'react';

const CLIENT_KEY = 'client_secret_key_123';
const MGMT_TOKEN = 'this-is-for-testing-management-tokens';

// auth types:
//   'body-apikey'   – apiKey injected into JSON body before send
//   'header-apikey' – X-API-Key header
//   'bearer'        – Authorization: Bearer header

const ENDPOINTS = [
  // ── Client — Tasks ──────────────────────────────────────────────
  {
    group: 'Client — Tasks',
    label: 'Submit Task',
    method: 'POST',
    path: '/api/task/submit',
    auth: 'body-apikey',
    pathParams: [],
    queryParams: [],
    bodyExample: JSON.stringify(
      { capability: 'llm.mistral', payload: { prompt: 'What is 2+2?' }, urgent: false },
      null, 2,
    ),
    description: 'Submit a task to the queue. Returns immediately with task ID.',
  },
  {
    group: 'Client — Tasks',
    label: 'Submit Task (Blocking)',
    method: 'POST',
    path: '/api/task/submit_blocking',
    auth: 'body-apikey',
    pathParams: [],
    queryParams: [],
    bodyExample: JSON.stringify(
      { capability: 'llm.mistral', payload: { prompt: 'What is 2+2?' }, urgent: true },
      null, 2,
    ),
    description: 'Submit an urgent task and block the connection until result or 60 s timeout.',
  },
  {
    group: 'Client — Tasks',
    label: 'Poll Task Status',
    method: 'POST',
    path: '/api/task/poll/{cap}/{id}',
    auth: 'body-apikey',
    pathParams: ['cap', 'id'],
    queryParams: [],
    bodyExample: JSON.stringify({}, null, 2),
    description: 'Check status of a submitted task by capability and task ID.',
  },
  {
    group: 'Client — Tasks',
    label: 'Get Online Capabilities (filtered)',
    method: 'POST',
    path: '/api/capabilities/online',
    auth: 'body-apikey',
    pathParams: [],
    queryParams: [],
    bodyExample: JSON.stringify({}, null, 2),
    description: 'Returns online capabilities intersected with what this API key is allowed to use.',
  },
  // ── Client — Storage ─────────────────────────────────────────────
  {
    group: 'Client — Storage',
    label: 'Get Storage Limits',
    method: 'GET',
    path: '/api/storage/limits',
    auth: 'header-apikey',
    pathParams: [],
    queryParams: [],
    description: 'Returns quota limits for your API key (max buckets, size, TTL).',
  },
  {
    group: 'Client — Storage',
    label: 'List Buckets',
    method: 'GET',
    path: '/api/storage/buckets',
    auth: 'header-apikey',
    pathParams: [],
    queryParams: [],
    description: 'Returns all buckets owned by your API key with usage info.',
  },
  {
    group: 'Client — Storage',
    label: 'Create Bucket',
    method: 'POST',
    path: '/api/storage/bucket/create',
    auth: 'header-apikey',
    pathParams: [],
    queryParams: [],
    bodyExample: JSON.stringify({}, null, 2),
    description: 'Creates a new bucket scoped to your API key. Returns bucket_uid.',
  },
  {
    group: 'Client — Storage',
    label: 'Get Bucket Contents',
    method: 'GET',
    path: '/api/storage/bucket/{bucket_uid}/stat',
    auth: 'header-apikey',
    pathParams: ['bucket_uid'],
    queryParams: [],
    description: 'Lists all files in a bucket with sizes and remaining space.',
  },
  {
    group: 'Client — Storage',
    label: 'Delete Bucket',
    method: 'DELETE',
    path: '/api/storage/bucket/{bucket_uid}',
    auth: 'header-apikey',
    pathParams: ['bucket_uid'],
    queryParams: [],
    description: 'Deletes a bucket and all its files. Cannot be undone.',
  },
  {
    group: 'Client — Storage',
    label: 'Get File Hash',
    method: 'GET',
    path: '/api/storage/bucket/{bucket_uid}/file/{file_uid}/hash',
    auth: 'header-apikey',
    pathParams: ['bucket_uid', 'file_uid'],
    queryParams: [],
    description: 'Returns the SHA-256 digest of a file (no download).',
  },
  {
    group: 'Client — Storage',
    label: 'Delete File',
    method: 'DELETE',
    path: '/api/storage/bucket/{bucket_uid}/file/{file_uid}',
    auth: 'header-apikey',
    pathParams: ['bucket_uid', 'file_uid'],
    queryParams: [],
    description: 'Removes a single file from a bucket and frees up space.',
  },
  // ── Management — Health ──────────────────────────────────────────
  {
    group: 'Management — Health',
    label: 'Get Server Version',
    method: 'GET',
    path: '/management/version',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns the application version.',
  },
  // ── Management — Capabilities ────────────────────────────────────
  {
    group: 'Management — Capabilities',
    label: 'List Online Capabilities (Base)',
    method: 'GET',
    path: '/management/capabilities/list/online',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns deduplicated base capabilities from all online agents.',
  },
  {
    group: 'Management — Capabilities',
    label: 'List Online Capabilities (Extended)',
    method: 'GET',
    path: '/management/capabilities/list/online_ext',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns raw capabilities including extended attributes in brackets.',
  },
  // ── Management — Agents ──────────────────────────────────────────
  {
    group: 'Management — Agents',
    label: 'List All Agents',
    method: 'GET',
    path: '/management/agents/list',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns all registered agents (online and offline) with full metadata.',
  },
  {
    group: 'Management — Agents',
    label: 'List Online Agents',
    method: 'GET',
    path: '/management/agents/list/online',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns only agents active within the last 120 seconds.',
  },
  {
    group: 'Management — Agents',
    label: 'Delete Agent',
    method: 'POST',
    path: '/management/agents/delete/{agent_id}',
    auth: 'bearer',
    pathParams: ['agent_id'],
    queryParams: [],
    description: 'Permanently removes an agent. Tasks assigned to it remain in assigned state.',
  },
  {
    group: 'Management — Agents',
    label: 'Reset All Agents',
    method: 'POST',
    path: '/management/agents/reset',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: '⚠️ Destructive — clears all agents. Use only in test environments.',
  },
  {
    group: 'Management — Agents',
    label: 'Trigger Stale Agents Cleanup',
    method: 'POST',
    path: '/management/agents/cleanup/trigger',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Removes agents inactive longer than STALE_AGENTS_TTL_DAYS (default 7 days).',
  },
  // ── Management — Tasks ────────────────────────────────────────────
  {
    group: 'Management — Tasks',
    label: 'List All Tasks',
    method: 'GET',
    path: '/management/tasks/list',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns all tasks (urgent/regular, assigned/unassigned) with full details.',
  },
  {
    group: 'Management — Tasks',
    label: 'Reset All Tasks',
    method: 'POST',
    path: '/management/tasks/reset',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: '⚠️ Destructive — clears all tasks from both in-memory and persistent storage.',
  },
  // ── Management — Client Keys ──────────────────────────────────────
  {
    group: 'Management — Client Keys',
    label: 'List Client API Keys',
    method: 'GET',
    path: '/management/client_api_keys/list',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns all client API keys and their capabilities/status.',
  },
  {
    group: 'Management — Client Keys',
    label: 'Create / Update API Key',
    method: 'POST',
    path: '/management/client_api_keys/update',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    bodyExample: JSON.stringify(
      { key: 'new-client-key-456', capabilities: ['llm.mistral', 'vision'] },
      null, 2,
    ),
    description: 'Create a new client API key or update an existing one\'s capabilities.',
  },
  {
    group: 'Management — Client Keys',
    label: 'Revoke API Key',
    method: 'POST',
    path: '/management/client_api_keys/revoke/{id}',
    auth: 'bearer',
    pathParams: ['id'],
    queryParams: [],
    description: 'Mark a client API key as revoked. Clients using it get 401 immediately.',
  },
  // ── Management — Storage ──────────────────────────────────────────
  {
    group: 'Management — Storage',
    label: 'List All Buckets',
    method: 'GET',
    path: '/management/storage/buckets',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Returns all buckets across all API keys, grouped by owner.',
  },
  {
    group: 'Management — Storage',
    label: 'Get Storage Quotas',
    method: 'GET',
    path: '/management/storage/quotas',
    auth: 'bearer',
    pathParams: [],
    queryParams: [
      { name: 'api_key', required: false, placeholder: 'Filter to one API key (optional)' },
    ],
    description: 'System-wide quota limits and per-key usage statistics.',
  },
  {
    group: 'Management — Storage',
    label: 'Trigger Storage Cleanup',
    method: 'POST',
    path: '/management/storage/cleanup/trigger',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Immediately runs the expired-bucket cleanup job (normally runs every 3 h).',
  },
  // ── Management — Maintenance ──────────────────────────────────────
  {
    group: 'Management — Maintenance',
    label: 'Trigger Heuristics Cleanup',
    method: 'POST',
    path: '/management/heuristics/cleanup/trigger',
    auth: 'bearer',
    pathParams: [],
    queryParams: [],
    description: 'Runs heuristic record cleanup by age and per-(runner, capability) cap.',
  },
  // ── Management — Logs ─────────────────────────────────────────────
  {
    group: 'Management — Logs',
    label: 'Get Service Logs',
    method: 'GET',
    path: '/management/service_logs',
    auth: 'bearer',
    pathParams: [],
    queryParams: [
      { name: 'class', required: true, placeholder: 'Required — e.g. bg' },
      { name: 'limit', required: false, placeholder: 'Default: 50 (max: 500)' },
      { name: 'cursor', required: false, placeholder: 'next_cursor from previous page' },
    ],
    description: 'Returns paginated service messages filtered by class (newest first).',
  },
];

const AUTH_DEFAULTS = {
  'body-apikey': CLIENT_KEY,
  'header-apikey': CLIENT_KEY,
  'bearer': MGMT_TOKEN,
};

const getStoredAuth = (authType) =>
  localStorage.getItem(`omq_auth_${authType}`) ?? AUTH_DEFAULTS[authType];

const AUTH_LABELS = {
  'body-apikey': 'Client API Key (injected into body)',
  'header-apikey': 'Client API Key  →  X-API-Key header',
  'bearer': 'Management Token  →  Authorization: Bearer',
};

const METHOD_BADGE = {
  GET:    { bg: '#dcfce7', color: '#15803d', border: '#86efac' },
  POST:   { bg: '#dbeafe', color: '#1d4ed8', border: '#93c5fd' },
  DELETE: { bg: '#fee2e2', color: '#b91c1c', border: '#fca5a5' },
  PUT:    { bg: '#fef9c3', color: '#92400e', border: '#fde68a' },
};

const GROUPS = [...new Set(ENDPOINTS.map(e => e.group))];

function methodBadge(method) {
  const s = METHOD_BADGE[method] || METHOD_BADGE.GET;
  return {
    display: 'inline-block',
    fontSize: '0.65rem',
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: '0.05em',
    padding: '1px 6px',
    borderRadius: '4px',
    border: `1px solid ${s.border}`,
    backgroundColor: s.bg,
    color: s.color,
    marginRight: '6px',
    verticalAlign: 'middle',
  };
}

const ApiTestingTool = () => {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [authValue, setAuthValue] = useState(CLIENT_KEY);
  const [pathParamValues, setPathParamValues] = useState({});
  const [queryParamValues, setQueryParamValues] = useState({});
  const [bodyText, setBodyText] = useState('');

  const [responseStatus, setResponseStatus] = useState(null);
  const [responseBody, setResponseBody] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const ep = ENDPOINTS[selectedIdx];
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(ep.method) && ep.bodyExample !== undefined;

  useEffect(() => {
    setAuthValue(getStoredAuth(ep.auth));
    const pp = {};
    ep.pathParams.forEach(p => { pp[p] = ''; });
    setPathParamValues(pp);
    const qp = {};
    (ep.queryParams || []).forEach(q => { qp[q.name] = ''; });
    setQueryParamValues(qp);
    setBodyText(ep.bodyExample || '');
    setResponseStatus(null);
    setResponseBody('');
  }, [selectedIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildUrl = () => {
    let url = ep.path;
    ep.pathParams.forEach(p => {
      url = url.replace(`{${p}}`, encodeURIComponent(pathParamValues[p] || `{${p}}`));
    });
    const active = (ep.queryParams || []).filter(q => queryParamValues[q.name]);
    if (active.length > 0) {
      url += '?' + active
        .map(q => `${encodeURIComponent(q.name)}=${encodeURIComponent(queryParamValues[q.name])}`)
        .join('&');
    }
    return url;
  };

  const handleSend = async () => {
    setIsLoading(true);
    setResponseStatus(null);
    setResponseBody('');

    const url = buildUrl();

    try {
      const headers = {};
      if (ep.auth === 'header-apikey') {
        headers['X-API-Key'] = authValue;
      } else if (ep.auth === 'bearer') {
        headers['Authorization'] = `Bearer ${authValue}`;
      }

      let body = undefined;
      if (hasBody) {
        headers['Content-Type'] = 'application/json';
        if (ep.auth === 'body-apikey') {
          try {
            const parsed = JSON.parse(bodyText);
            parsed.apiKey = authValue;
            body = JSON.stringify(parsed);
          } catch {
            body = bodyText;
          }
        } else {
          body = bodyText || undefined;
        }
      }

      const response = await fetch(url, { method: ep.method, headers, body });
      setResponseStatus(response.status);

      const text = await response.text();
      try {
        setResponseBody(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setResponseBody(text);
      }
    } catch (err) {
      setResponseStatus('Error');
      setResponseBody(`Request failed: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const statusOk = typeof responseStatus === 'number' && responseStatus >= 200 && responseStatus < 300;
  const statusErr = responseStatus === 'Error' || (typeof responseStatus === 'number' && responseStatus >= 400);
  const statusColor = statusErr ? '#fca5a5' : statusOk ? '#86efac' : '#fcd34d';

  // ── Styles ──────────────────────────────────────────────────────
  const s = {
    container: {
      display: 'flex',
      flexDirection: 'column',
      gap: '1.5rem',
      padding: '1.5rem',
      backgroundColor: '#f0f2f5',
      borderRadius: '1rem',
      boxShadow: '0 8px 16px rgba(0,0,0,0.1)',
      maxWidth: '1400px',
      width: '100%',
      color: '#1f2937',
      boxSizing: 'border-box',
    },
    header: {
      fontSize: '1.5rem',
      fontWeight: '700',
      color: '#3b82f6',
      margin: 0,
    },
    columns: {
      display: 'grid',
      gridTemplateColumns: window.innerWidth >= 900 ? '1fr 1fr' : '1fr',
      gap: '1.5rem',
      alignItems: 'start',
    },
    panel: {
      backgroundColor: '#ffffff',
      borderRadius: '0.75rem',
      padding: '1.25rem',
      boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.875rem',
    },
    panelTitle: {
      fontSize: '0.8rem',
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: '#9ca3af',
      margin: 0,
      paddingBottom: '0.5rem',
      borderBottom: '1px solid #f3f4f6',
    },
    label: {
      display: 'block',
      fontSize: '0.75rem',
      fontWeight: '600',
      color: '#6b7280',
      marginBottom: '4px',
    },
    input: {
      width: '100%',
      padding: '0.5rem 0.75rem',
      borderRadius: '0.4rem',
      border: '1px solid #d1d5db',
      backgroundColor: '#fafafa',
      color: '#111827',
      fontSize: '0.85rem',
      outline: 'none',
      boxSizing: 'border-box',
      fontFamily: 'monospace',
    },
    select: {
      width: '100%',
      padding: '0.5rem 0.75rem',
      borderRadius: '0.4rem',
      border: '1px solid #d1d5db',
      backgroundColor: '#fafafa',
      color: '#111827',
      fontSize: '0.875rem',
      outline: 'none',
      boxSizing: 'border-box',
    },
    textarea: {
      width: '100%',
      padding: '0.625rem 0.75rem',
      borderRadius: '0.4rem',
      border: '1px solid #d1d5db',
      backgroundColor: '#fafafa',
      color: '#111827',
      fontSize: '0.8rem',
      fontFamily: 'monospace',
      outline: 'none',
      resize: 'vertical',
      minHeight: '180px',
      boxSizing: 'border-box',
    },
    sendBtn: {
      padding: '0.6rem 1.25rem',
      backgroundColor: isLoading ? '#93c5fd' : '#3b82f6',
      color: '#ffffff',
      fontWeight: '700',
      fontSize: '0.875rem',
      borderRadius: '0.4rem',
      cursor: isLoading ? 'not-allowed' : 'pointer',
      border: 'none',
      outline: 'none',
      transition: 'background-color 0.15s',
      alignSelf: 'flex-start',
    },
    urlPreview: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '0.4rem 0.75rem',
      backgroundColor: '#f9fafb',
      border: '1px solid #e5e7eb',
      borderRadius: '0.4rem',
      fontSize: '0.8rem',
      fontFamily: 'monospace',
      color: '#374151',
      overflowX: 'auto',
      whiteSpace: 'nowrap',
    },
    description: {
      fontSize: '0.8rem',
      color: '#6b7280',
      margin: 0,
      lineHeight: '1.4',
    },
    statusBadge: {
      display: 'inline-block',
      fontWeight: '700',
      fontSize: '0.875rem',
      padding: '2px 10px',
      borderRadius: '0.4rem',
      backgroundColor: responseStatus !== null ? statusColor : '#e5e7eb',
      color: '#1f2937',
    },
    responsePre: {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      fontFamily: 'monospace',
      fontSize: '0.78rem',
      backgroundColor: '#f9fafb',
      border: '1px solid #e5e7eb',
      borderRadius: '0.4rem',
      padding: '0.75rem',
      color: '#111827',
      minHeight: '100px',
      maxHeight: '500px',
      overflowY: 'auto',
      margin: 0,
    },
    sectionDivider: {
      borderTop: '1px solid #f3f4f6',
      paddingTop: '0.875rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.625rem',
    },
    sectionLabel: {
      fontSize: '0.7rem',
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: '#9ca3af',
    },
  };

  const currentUrl = (() => {
    try { return buildUrl(); } catch { return ep.path; }
  })();

  return (
    <div style={s.container}>
      <h1 style={s.header}>REST API Tester</h1>

      <div style={s.columns}>
        {/* ── Request panel ── */}
        <div style={s.panel}>
          <p style={s.panelTitle}>Request</p>

          {/* Endpoint selector */}
          <div>
            <span style={s.label}>Endpoint</span>
            <select
              style={s.select}
              value={selectedIdx}
              onChange={e => setSelectedIdx(Number(e.target.value))}
            >
              {GROUPS.map(group => (
                <optgroup key={group} label={group}>
                  {ENDPOINTS.map((ep, idx) =>
                    ep.group === group ? (
                      <option key={idx} value={idx}>
                        [{ep.method}] {ep.label}
                      </option>
                    ) : null,
                  )}
                </optgroup>
              ))}
            </select>
            {ep.description && <p style={{ ...s.description, marginTop: '5px' }}>{ep.description}</p>}
          </div>

          {/* URL preview */}
          <div style={s.urlPreview}>
            <span style={methodBadge(ep.method)}>{ep.method}</span>
            <span>{currentUrl}</span>
          </div>

          {/* Auth */}
          <div>
            <span style={s.label}>{AUTH_LABELS[ep.auth]}</span>
            <input
              style={s.input}
              type="text"
              value={authValue}
              onChange={e => {
                setAuthValue(e.target.value);
                localStorage.setItem(`omq_auth_${ep.auth}`, e.target.value);
              }}
              placeholder="Enter auth value"
            />
          </div>

          {/* Path params */}
          {ep.pathParams.length > 0 && (
            <div style={s.sectionDivider}>
              <span style={s.sectionLabel}>Path Parameters</span>
              {ep.pathParams.map(param => (
                <div key={param}>
                  <span style={s.label}>{`{${param}}`}</span>
                  <input
                    style={s.input}
                    type="text"
                    value={pathParamValues[param] || ''}
                    onChange={e => setPathParamValues(prev => ({ ...prev, [param]: e.target.value }))}
                    placeholder={`Enter ${param}`}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Query params */}
          {ep.queryParams && ep.queryParams.length > 0 && (
            <div style={s.sectionDivider}>
              <span style={s.sectionLabel}>Query Parameters</span>
              {ep.queryParams.map(qp => (
                <div key={qp.name}>
                  <span style={s.label}>
                    {qp.name}
                    {qp.required && (
                      <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>
                    )}
                  </span>
                  <input
                    style={s.input}
                    type="text"
                    value={queryParamValues[qp.name] || ''}
                    onChange={e =>
                      setQueryParamValues(prev => ({ ...prev, [qp.name]: e.target.value }))
                    }
                    placeholder={qp.placeholder || `Enter ${qp.name}`}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Body */}
          {hasBody && (
            <div style={s.sectionDivider}>
              <span style={s.sectionLabel}>
                Request Body (JSON)
                {ep.auth === 'body-apikey' && (
                  <span style={{ color: '#9ca3af', fontWeight: '400', marginLeft: '6px' }}>
                    — apiKey injected automatically
                  </span>
                )}
              </span>
              <textarea
                style={s.textarea}
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}

          <button style={s.sendBtn} onClick={handleSend} disabled={isLoading}>
            {isLoading ? 'Sending…' : 'Send'}
          </button>
        </div>

        {/* ── Response panel ── */}
        <div style={s.panel}>
          <p style={s.panelTitle}>Response</p>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: '600', color: '#6b7280' }}>Status</span>
            <span style={s.statusBadge}>
              {responseStatus !== null ? responseStatus : '—'}
            </span>
          </div>

          <pre style={s.responsePre}>
            {responseBody || (isLoading ? 'Waiting for response…' : 'Response will appear here')}
          </pre>
        </div>
      </div>
    </div>
  );
};

export default ApiTestingTool;
