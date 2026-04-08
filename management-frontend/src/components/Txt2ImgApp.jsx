import React, { useState, useRef } from 'react';
import { cancelTask } from '../sandboxUtils';
import { sandboxStyles as ss } from '../sandboxStyles';
import CircularProgress from './CircularProgress';
import { useCapabilities } from '../hooks/useCapabilities';
import { useBlobUrls } from '../hooks/useBlobUrls';
import { statusLabel, deleteBucket, fetchImageBlobs } from '../sandboxUtils';
import ImgGenModelSelector from './ImgGenModelSelector';
import ErrorBoundary from './ErrorBoundary';
import ImageLightbox from './ImageLightbox';
import ImageGallery from './ImageGallery';

const Txt2ImgApp = ({ apiKey, addDevEntry }) => {
  const [workflow] = useState('txt2img');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('a cat sitting on the moon, cinematic lighting');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [overrideNegative, setOverrideNegative] = useState(false);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [seed, setSeed] = useState('');

  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [heuristicSecs, setHeuristicSecs] = useState(null);
  const [taskCreatedAt, setTaskCreatedAt] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const outputBucketRef = useRef(null);
  const cancelledRef = useRef(false);
  const activeTaskRef = useRef(null); // { cap, id }
  const { revokeAll, track } = useBlobUrls();

  const [capabilities] = useCapabilities('imggen.', { setModel, setError });

  const handleCancel = async () => {
    const task = activeTaskRef.current;
    cancelledRef.current = true;
    activeTaskRef.current = null;
    setIsLoading(false);
    setStatusText('');
    setHeuristicSecs(null);
    setTaskCreatedAt(null);
    setError('Task cancelled');
    if (outputBucketRef.current) {
      deleteBucket(outputBucketRef.current, apiKey);
      outputBucketRef.current = null;
    }
    if (task) await cancelTask(task.cap, task.id, apiKey, addDevEntry);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    cancelledRef.current = false;
    setIsLoading(true);
    setResponse(null);
    setError(null);
    setStatusText('Creating output bucket...');

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
      output_bucket: bucketUid,
      payload: {
        workflow: workflow,
        prompt: prompt,
        ...(overrideNegative && { secondary_prompts: { negative: negativePrompt } }),
        resolution: { width: parseInt(width), height: parseInt(height) },
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
      addDevEntry?.({ label: 'Submit txt2img task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.error) {
        const errorMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        setError(errorMsg);
      } else if (data.id) {
        activeTaskRef.current = { cap: data.id.cap, id: data.id.id };
        setResponse(data);
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

  const pollTask = async (cap, id, outBucketUid) => {
    const maxAttempts = 120;
    let attempts = 0;

    const poll = async () => {
      if (cancelledRef.current) return;
      if (attempts >= maxAttempts) {
        activeTaskRef.current = null;
        setError('Task polling timeout');
        setIsLoading(false);
        outputBucketRef.current = null;
        deleteBucket(outBucketUid, apiKey);
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
          activeTaskRef.current = null;
          setHeuristicSecs(null);
          setTaskCreatedAt(null);
          setStatusText('Fetching images...');
          const output = data.output;
          if (output?.images) {
            revokeAll();
            output.images = await fetchImageBlobs(output.images, apiKey, track);
          }
          setStatusText('');
          setResponse(output);
          setIsLoading(false);
          outputBucketRef.current = null;
          deleteBucket(outBucketUid, apiKey);
        } else if (data.status === 'failed' || data.status === 'canceled') {
          activeTaskRef.current = null;
          setHeuristicSecs(null);
          setTaskCreatedAt(null);
          const errorMsg = data.output?.error
            ? (typeof data.output.error === 'string' ? data.output.error : JSON.stringify(data.output.error))
            : (data.status === 'canceled' ? 'Task was canceled' : 'Task failed');
          setError(errorMsg);
          setIsLoading(false);
          outputBucketRef.current = null;
          deleteBucket(outBucketUid, apiKey);
        } else {
          if (data.createdAt) setTaskCreatedAt(prev => prev ?? data.createdAt);
          if (data.typicalRuntimeSeconds?.secs != null) setHeuristicSecs(data.typicalRuntimeSeconds.secs);
          setStatusText(statusLabel(data.status, data.stage));
          attempts++;
          setTimeout(poll, 5000);
        }
      } catch (err) {
        activeTaskRef.current = null;
        const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
        addDevEntry?.({ label: `Poll task ${id}`, method: 'POST', url: `/api/task/poll/${cap}/${id}`, request: { apiKey: apiKey }, response: { error: errorMsg } });
        setError(`Polling error: ${errorMsg}`);
        setIsLoading(false);
        outputBucketRef.current = null;
        deleteBucket(outBucketUid, apiKey);
      }
    };

    poll();
  };

  return (
    <ErrorBoundary>
      <div style={ss.content}>
      <form onSubmit={handleSubmit} style={ss.form}>
        <div style={ss.formGroup}>
          <label style={ss.label}>Workflow:</label>
          <ImgGenModelSelector model={model} setModel={setModel} capabilities={capabilities} />
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="prompt" style={ss.label}>Prompt:</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={ss.textarea}
            rows="4"
          />
        </div>

        <div style={ss.formGroup}>
          <div style={ss.labelRow}>
            <label htmlFor="negative" style={ss.label}>Negative Prompt:</label>
            <button type="button" onClick={() => setOverrideNegative(v => !v)} style={ss.toggleBtn}>
              {overrideNegative ? 'use model default' : 'override'}
            </button>
          </div>
          {overrideNegative ? (
            <textarea
              id="negative"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              style={ss.textarea}
              rows="2"
              placeholder="e.g. blurry, deformed, low quality"
            />
          ) : (
            <span style={ss.defaultHint}>Using workflow default</span>
          )}
        </div>

        <div style={ss.row}>
          <div style={ss.formGroup}>
            <label htmlFor="width" style={ss.label}>Width:</label>
            <input id="width" type="number" value={width} onChange={(e) => setWidth(e.target.value)} style={ss.input} />
          </div>
          <div style={ss.formGroup}>
            <label htmlFor="height" style={ss.label}>Height:</label>
            <input id="height" type="number" value={height} onChange={(e) => setHeight(e.target.value)} style={ss.input} />
          </div>
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="seed" style={ss.label}>Seed (optional):</label>
          <input id="seed" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="Leave empty for random" style={ss.input} />
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="submit" style={ss.button} disabled={isLoading}>
            {isLoading ? 'Generating...' : 'Generate Image'}
          </button>
          {isLoading && activeTaskRef.current && (
            <button type="button" style={cancelBtnStyle} onClick={handleCancel}>Cancel</button>
          )}
        </div>
      </form>

      <div style={ss.responseContainer}>
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <CircularProgress typicalRuntimeSeconds={heuristicSecs} createdAt={taskCreatedAt} size={32} strokeWidth={3} />
            <p style={{ ...ss.loading, margin: 0 }}>{statusText || 'Generating image...'}</p>
          </div>
        )}
        {error && <pre style={ss.error}>{error}</pre>}
        {response && response.images && (
          <div>
            <p style={ss.responseLabel}>Generated Images:</p>
            <ImageGallery images={response.images} onImageClick={setLightboxSrc} />
            {response.seed != null && (
              <p style={ss.seedInfo}>Seed: {response.seed}</p>
            )}
          </div>
        )}
      </div>
    </div>
    <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </ErrorBoundary>
  );
};

const cancelBtnStyle = {
  padding: '8px 16px',
  borderRadius: '6px',
  background: 'var(--danger, #ef4444)',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
  fontWeight: 500,
};

export default Txt2ImgApp;
