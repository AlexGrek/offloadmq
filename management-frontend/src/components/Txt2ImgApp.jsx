import React, { useState, useEffect, useRef } from 'react';
import { fetchOnlineCapabilities, stripCapabilityAttrs } from '../utils';
import ImgGenModelSelector from './ImgGenModelSelector';
import ErrorBoundary from './ErrorBoundary';

const Txt2ImgApp = ({ apiKey, addDevEntry }) => {
  const [workflow, setWorkflow] = useState('txt2img');
  const [model, setModel] = useState('wan-2.1-outpaint');
  const [prompt, setPrompt] = useState('a cat sitting on the moon, cinematic lighting');
  const [negativePrompt, setNegativePrompt] = useState('blurry, deformed, low quality');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [seed, setSeed] = useState('');

  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [capabilities, setCapabilities] = useState([]);
  const outputBucketRef = useRef(null);

  useEffect(() => {
    const updCaps = async () => {
      try {
        const data = await fetchOnlineCapabilities();
        if (Array.isArray(data)) {
          const imggenCaps = data.filter((cap) => {
            try {
              return typeof cap === 'string' && stripCapabilityAttrs(cap).startsWith("imggen.");
            } catch (e) {
              console.warn('Error filtering capability:', cap, e);
              return false;
            }
          });
          setCapabilities(imggenCaps);
        } else {
          console.warn('Expected array of capabilities, got:', data);
          setCapabilities([]);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
        console.error('Failed to fetch capabilities:', err);
        setError(`Failed to fetch capabilities: ${errorMsg}`);
        setCapabilities([]);
      }
    };

    updCaps();
  }, []);

  const deleteBucket = async (uid) => {
    if (!uid) return;
    try {
      await fetch(`/api/storage/bucket/${uid}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': apiKey },
      });
    } catch (e) {
      console.warn('Failed to delete bucket', uid, e);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setResponse(null);
    setError(null);
    setStatusText('Creating output bucket...');

    // Create a fresh output bucket for each task
    let bucketUid = null;
    try {
      const bucketRes = await fetch('/api/storage/bucket/create', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
      });
      const bucketData = await bucketRes.json();
      if (!bucketData.bucket_uid) throw new Error('Failed to create output bucket');
      bucketUid = bucketData.bucket_uid;
      outputBucketRef.current = bucketUid;
      addDevEntry?.({ label: 'Create output bucket', method: 'POST', url: '/api/storage/bucket/create', request: {}, response: bucketData });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      setError(`Failed to create output bucket: ${errorMsg}`);
      setIsLoading(false);
      return;
    }

    setStatusText('Submitting...');

    const payload = {
      apiKey: apiKey,
      capability: `imggen.${model}`,
      urgent: false,
      outputBucket: bucketUid,
      payload: {
        workflow: workflow,
        prompt: prompt,
        secondary_prompts: {
          negative: negativePrompt,
        },
        resolution: {
          width: parseInt(width),
          height: parseInt(height),
        },
      },
    };

    // Add seed only if provided and not empty
    if (seed && seed !== '') {
      payload.payload.seed = parseInt(seed) || -1;
    }

    try {
      const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      addDevEntry?.({ label: 'Submit txt2img task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.error) {
        const errorMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        setError(errorMsg);
      } else if (data.id) {
        setResponse(data);
        // Start polling for result
        pollTask(data.id.cap, data.id.id, bucketUid);
      } else {
        setError('Unexpected response format.');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      addDevEntry?.({ label: 'Submit txt2img task', method: 'POST', url: '/api/task/submit', request: payload, response: { error: errorMsg } });
      setError(`An error occurred: ${errorMsg}`);
      setIsLoading(false);
    }
  };

  const statusLabel = (status, stage) => {
    const base = {
      pending: 'Pending...',
      queued: 'Queued, waiting for agent...',
      assigned: 'Assigned to agent...',
      starting: 'Agent starting task...',
      running: 'Running...',
      failedRetryPending: 'Failed, retrying...',
      failedRetryDelayed: 'Failed, waiting to retry...',
    }[typeof status === 'string' ? status : ''] ?? `Status: ${JSON.stringify(status)}`;
    return stage ? `${base} [${stage}]` : base;
  };

  const pollTask = async (cap, id, outBucketUid) => {
    const maxAttempts = 120; // 10 minutes with 5-second intervals
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setError('Task polling timeout');
        setIsLoading(false);
        outputBucketRef.current = null;
        deleteBucket(outBucketUid);
        return;
      }

      try {
        const res = await fetch(`/api/task/poll/${cap}/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey }),
        });

        const data = await res.json();
        addDevEntry?.({ label: `Poll task ${id}`, method: 'POST', url: `/api/task/poll/${cap}/${id}`, request: { apiKey: apiKey }, response: data });

        if (data.status === 'completed') {
          setStatusText('');
          setResponse(data.output);
          setIsLoading(false);
          outputBucketRef.current = null;
          deleteBucket(outBucketUid);
        } else if (data.status === 'failed' || data.status === 'canceled') {
          const errorMsg = data.output?.error
            ? (typeof data.output.error === 'string' ? data.output.error : JSON.stringify(data.output.error))
            : (data.status === 'canceled' ? 'Task was canceled' : 'Task failed');
          setError(errorMsg);
          setIsLoading(false);
          outputBucketRef.current = null;
          deleteBucket(outBucketUid);
        } else {
          setStatusText(statusLabel(data.status, data.stage));
          attempts++;
          setTimeout(poll, 5000);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
        addDevEntry?.({ label: `Poll task ${id}`, method: 'POST', url: `/api/task/poll/${cap}/${id}`, request: { apiKey: apiKey }, response: { error: errorMsg } });
        setError(`Polling error: ${errorMsg}`);
        setIsLoading(false);
        outputBucketRef.current = null;
        deleteBucket(outBucketUid);
      }
    };

    poll();
  };

  const filteredModels = capabilities
    .map(cap => stripCapabilityAttrs(cap).replace('imggen.', ''))
    .filter(Boolean);

  return (
    <ErrorBoundary>
      <div style={styles.content}>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.formGroup}>
          <label style={styles.label}>Workflow:</label>
          <ImgGenModelSelector
            model={model}
            setModel={setModel}
            capabilities={capabilities}
          />
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="prompt" style={styles.label}>Prompt:</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={styles.textarea}
            rows="4"
          />
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="negative" style={styles.label}>Negative Prompt:</label>
          <textarea
            id="negative"
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            style={styles.textarea}
            rows="2"
          />
        </div>

        <div style={styles.row}>
          <div style={styles.formGroup}>
            <label htmlFor="width" style={styles.label}>Width:</label>
            <input
              id="width"
              type="number"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              style={styles.input}
            />
          </div>
          <div style={styles.formGroup}>
            <label htmlFor="height" style={styles.label}>Height:</label>
            <input
              id="height"
              type="number"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              style={styles.input}
            />
          </div>
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="seed" style={styles.label}>Seed (optional):</label>
          <input
            id="seed"
            type="number"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="Leave empty for random"
            style={styles.input}
          />
        </div>

        <button type="submit" style={styles.button} disabled={isLoading}>
          {isLoading ? 'Generating...' : 'Generate Image'}
        </button>
      </form>

      <div style={styles.responseContainer}>
        {isLoading && <p style={styles.loading}>{statusText || 'Generating image...'}</p>}
        {error && <pre style={styles.error}>{error}</pre>}
        {response && response.images && (
          <div>
            <p style={styles.responseLabel}>Generated Images:</p>
            <div style={styles.imageGrid}>
              {response.images.map((img, idx) => {
                const src = img.file_uid
                  ? `/api/storage/bucket/${img.bucket_uid}/file/${img.file_uid}`
                  : `data:${img.content_type};base64,${img.data_base64}`;
                const downloadHref = img.file_uid
                  ? src
                  : `data:${img.content_type};base64,${img.data_base64}`;
                return (
                  <div key={idx}>
                    <img
                      src={src}
                      alt={`Generated ${idx + 1}`}
                      style={styles.image}
                    />
                    <div style={styles.imageFooter}>
                      <p style={styles.imageName}>{img.filename}</p>
                      <a
                        href={downloadHref}
                        download={img.filename}
                        style={styles.downloadLink}
                      >
                        Download
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
            {response.seed != null && (
              <p style={styles.seedInfo}>Seed: {response.seed}</p>
            )}
          </div>
        )}
      </div>
    </div>
    </ErrorBoundary>
  );
};

const styles = {
  content: {
    padding: '4px',
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
  row: {
    display: 'flex',
    gap: '16px',
  },
  label: {
    fontSize: '14px',
    fontWeight: '600',
    color: 'var(--text)',
    marginBottom: '6px',
  },
  input: {
    padding: '8px 12px',
    fontSize: '14px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    outline: 'none',
    background: 'var(--input-bg)',
    color: 'var(--text)',
  },
  textarea: {
    padding: '8px 12px',
    fontSize: '14px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    resize: 'vertical',
    outline: 'none',
    background: 'var(--input-bg)',
    color: 'var(--text)',
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
    alignSelf: 'flex-start',
  },
  responseContainer: {
    marginTop: '24px',
    padding: '16px',
    background: 'var(--glass)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
  },
  responseLabel: {
    fontSize: '14px',
    fontWeight: '600',
    color: 'var(--text)',
    margin: '0 0 12px 0',
  },
  loading: {
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  imageGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))',
    gap: '12px',
    marginBottom: '12px',
  },
  image: {
    width: '100%',
    borderRadius: '8px',
    border: '1px solid var(--border)',
  },
  imageFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: '6px',
  },
  imageName: {
    fontSize: '12px',
    color: 'var(--muted)',
    margin: '0',
    wordBreak: 'break-all',
  },
  downloadLink: {
    fontSize: '12px',
    color: 'var(--primary)',
    textDecoration: 'none',
    flexShrink: 0,
    marginLeft: '8px',
  },
  seedInfo: {
    fontSize: '12px',
    color: 'var(--muted)',
    margin: '8px 0 0 0',
  },
  error: {
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    fontSize: '12px',
    color: 'var(--danger)',
    margin: '0',
  },
};

export default Txt2ImgApp;
