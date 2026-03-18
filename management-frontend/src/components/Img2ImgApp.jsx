import React, { useState, useEffect, useRef } from 'react';
import { fetchOnlineCapabilities, stripCapabilityAttrs } from '../utils';
import ImgGenModelSelector from './ImgGenModelSelector';
import ErrorBoundary from './ErrorBoundary';
import { Upload, X } from 'lucide-react';

const Img2ImgApp = ({ apiKey, addDevEntry }) => {
  const [workflow, setWorkflow] = useState('img2img');
  const [model, setModel] = useState('wan-2.1-outpaint');
  const [prompt, setPrompt] = useState('turn this into an oil painting');
  const [negativePrompt, setNegativePrompt] = useState('blurry, deformed');
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(768);
  const [seed, setSeed] = useState('');

  const [bucketUid, setBucketUid] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [capabilities, setCapabilities] = useState([]);
  const fileInputRef = useRef(null);
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

  const createBucket = async () => {
    try {
      const res = await fetch('/api/storage/bucket/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey }),
      });

      const data = await res.json();
      addDevEntry?.({ label: 'Create bucket', method: 'POST', url: '/api/storage/bucket/create', request: { api_key: apiKey }, response: data });

      if (data.uid) {
        setBucketUid(data.uid);
        return data.uid;
      } else {
        throw new Error('Failed to create bucket');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      setError(`Failed to create bucket: ${errorMsg}`);
      return null;
    }
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploadProgress(0);

    try {
      // Create bucket if not exists
      const bid = bucketUid || (await createBucket());
      if (!bid) return;

      // Upload file
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`/api/storage/bucket/${bid}/upload`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: formData,
      });

      const data = await res.json();
      addDevEntry?.({ label: `Upload file to bucket ${bid}`, method: 'POST', url: `/api/storage/bucket/${bid}/upload`, request: { file: file.name }, response: data });

      if (data.file_uid) {
        setUploadedFile({ name: file.name, file_uid: data.file_uid });
      } else {
        throw new Error('Upload failed');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      setError(`Upload error: ${errorMsg}`);
    }

    setUploadProgress(0);
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setResponse(null);
    setError(null);
    setStatusText('Submitting...');

    // Create output bucket if not done yet
    let outBucketUid = outputBucketRef.current;
    if (!outBucketUid) {
      try {
        setStatusText('Creating output bucket...');
        const bucketRes = await fetch('/api/storage/bucket/create', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey },
        });
        const bucketData = await bucketRes.json();
        if (!bucketData.bucket_uid) throw new Error('Failed to create output bucket');
        outBucketUid = bucketData.bucket_uid;
        outputBucketRef.current = outBucketUid;
        addDevEntry?.({ label: 'Create output bucket', method: 'POST', url: '/api/storage/bucket/create', request: {}, response: bucketData });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
        setError(`Failed to create output bucket: ${errorMsg}`);
        setIsLoading(false);
        return;
      }
      setStatusText('Submitting...');
    }

    if (!uploadedFile) {
      setError('Please upload an image first');
      setIsLoading(false);
      return;
    }

    const payload = {
      apiKey: apiKey,
      capability: `imggen.${model}`,
      urgent: false,
      file_bucket: bucketUid ? [bucketUid] : [],
      output_bucket: outBucketUid,
      payload: {
        workflow: workflow,
        prompt: prompt,
        secondary_prompts: {
          negative: negativePrompt,
        },
        input_image: uploadedFile.name,
        resolution: {
          width: parseInt(width),
          height: parseInt(height),
        },
      },
    };

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
      addDevEntry?.({ label: 'Submit img2img task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.error) {
        const errorMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        setError(errorMsg);
      } else if (data.id) {
        setResponse(data);
        pollTask(data.id.cap, data.id.id);
      } else {
        setError('Unexpected response format.');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      addDevEntry?.({ label: 'Submit img2img task', method: 'POST', url: '/api/task/submit', request: payload, response: { error: errorMsg } });
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

  const pollTask = async (cap, id) => {
    const maxAttempts = 120;
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setError('Task polling timeout');
        setIsLoading(false);
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
        } else if (data.status === 'failed' || data.status === 'canceled') {
          const errorMsg = data.output?.error
            ? (typeof data.output.error === 'string' ? data.output.error : JSON.stringify(data.output.error))
            : (data.status === 'canceled' ? 'Task was canceled' : 'Task failed');
          setError(errorMsg);
          setIsLoading(false);
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
      }
    };

    poll();
  };

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
          <label style={styles.label}>Input Image:</label>
          <div style={styles.uploadBox}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            {uploadedFile ? (
              <div style={styles.uploadedFile}>
                <span>{uploadedFile.name}</span>
                <button
                  type="button"
                  onClick={handleRemoveFile}
                  style={styles.removeBtn}
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={styles.uploadBtn}
              >
                <Upload size={20} />
                <span>Click to upload image</span>
              </button>
            )}
          </div>
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

        <button type="submit" style={styles.button} disabled={isLoading || !uploadedFile}>
          {isLoading ? 'Processing...' : 'Generate Image'}
        </button>
      </form>

      <div style={styles.responseContainer}>
        {isLoading && <p style={styles.loading}>{statusText || 'Processing image...'}</p>}
        {error && <pre style={styles.error}>{error}</pre>}
        {response && response.images && (
          <div>
            <p style={styles.responseLabel}>Generated Images:</p>
            <div style={styles.imageGrid}>
              {response.images.map((img, idx) => {
                const src = img.file_uid
                  ? `/api/storage/bucket/${img.bucket_uid}/file/${img.file_uid}`
                  : `data:${img.content_type};base64,${img.data_base64}`;
                const downloadHref = img.file_uid ? src : `data:${img.content_type};base64,${img.data_base64}`;
                return (
                  <div key={idx}>
                    <img
                      src={src}
                      alt={`Generated ${idx + 1}`}
                      style={styles.image}
                    />
                    <div style={styles.imageFooter}>
                      <p style={styles.imageName}>{img.filename}</p>
                      <a href={downloadHref} download={img.filename} style={styles.downloadLink}>
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
  uploadBox: {
    border: '2px dashed var(--border)',
    borderRadius: '8px',
    padding: '16px',
    textAlign: 'center',
    backgroundColor: 'var(--glass)',
  },
  uploadBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text)',
    fontSize: '14px',
  },
  uploadedFile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: 'var(--input-bg)',
    borderRadius: '6px',
    fontSize: '14px',
    color: 'var(--text)',
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--danger)',
    padding: '4px',
    display: 'flex',
    alignItems: 'center',
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

export default Img2ImgApp;
