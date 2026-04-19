import React, { useState, useRef, useEffect } from 'react';
import { Upload, X } from 'lucide-react';
import { sandboxStyles as ss } from '../sandboxStyles';
import CircularProgress from './CircularProgress';
import { useCapabilities } from '../hooks/useCapabilities';
import { useBlobUrls } from '../hooks/useBlobUrls';
import { statusLabel, deleteBucket, fetchImageBlobs, cancelTask } from '../sandboxUtils';
import ImgGenModelSelector from './ImgGenModelSelector';
import ErrorBoundary from './ErrorBoundary';
import ImageLightbox from './ImageLightbox';
import ImageGallery from './ImageGallery';
import RescaleWidget, { rescaleDataPrep } from './RescaleWidget';

const Img2ImgApp = ({ apiKey, addDevEntry }) => {
  const [workflow] = useState('img2img');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('turn this into an oil painting');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [overrideNegative, setOverrideNegative] = useState(false);
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(768);
  const [seed, setSeed] = useState('');

  const [rescaleEnabled, setRescaleEnabled] = useState(true);
  const [rescaleMode, setRescaleMode] = useState('exact');
  const [rescaleWidth, setRescaleWidth] = useState(768);
  const [rescaleHeight, setRescaleHeight] = useState(768);
  const [rescalePx, setRescalePx] = useState('');
  const [rescaleMp, setRescaleMp] = useState('');
  const rescaleUserEditedRef = useRef(false);

  // Keep exact-mode rescale in sync with output dims until user overrides
  useEffect(() => {
    if (rescaleMode === 'exact' && !rescaleUserEditedRef.current) {
      setRescaleWidth(width);
      setRescaleHeight(height);
    }
  }, [width, height, rescaleMode]);

  const [bucketUid, setBucketUid] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);

  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [heuristicSecs, setHeuristicSecs] = useState(null);
  const [taskCreatedAt, setTaskCreatedAt] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const fileInputRef = useRef(null);
  const outputBucketRef = useRef(null);
  const cancelledRef = useRef(false);
  const activeTaskRef = useRef(null); // { cap, id }
  const { revokeAll, track } = useBlobUrls();

  const [capabilities] = useCapabilities('imggen.', { setModel, setError });

  const createBucket = async () => {
    try {
      const res = await fetch('/api/storage/bucket/create?rm_after_task=true', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
      });
      const data = await res.json();
      addDevEntry?.({ label: 'Create input bucket (rm_after_task)', method: 'POST', url: '/api/storage/bucket/create?rm_after_task=true', request: {}, response: data });
      if (data.bucket_uid) {
        setBucketUid(data.bucket_uid);
        return data.bucket_uid;
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

    try {
      const bid = bucketUid || (await createBucket());
      if (!bid) return;

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
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const resetInputBucket = () => {
    setBucketUid(null);
    setUploadedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

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
    setStatusText('Submitting...');

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

    const dataPrep = rescaleDataPrep(rescaleEnabled, { mode: rescaleMode, width: rescaleWidth, height: rescaleHeight, px: rescalePx, mp: rescaleMp });
    const payload = {
      apiKey: apiKey,
      capability: `imggen.${model}`,
      urgent: false,
      file_bucket: bucketUid ? [bucketUid] : [],
      output_bucket: outBucketUid,
      ...(dataPrep && { dataPreparation: dataPrep }),
      payload: {
        workflow: workflow,
        prompt: prompt,
        ...(overrideNegative && { secondary_prompts: { negative: negativePrompt } }),
        input_image: uploadedFile.name,
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
      addDevEntry?.({ label: 'Submit img2img task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.error) {
        const errorMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        setError(errorMsg);
      } else if (data.id) {
        activeTaskRef.current = { cap: data.id.cap, id: data.id.id };
        setResponse(data);
        pollTask(data.id.cap, data.id.id, outBucketUid);
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
        resetInputBucket();
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
          resetInputBucket();
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
          resetInputBucket();
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
        resetInputBucket();
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
          <label style={ss.label}>Input Image:</label>
          <div style={styles.uploadBox}>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} style={{ display: 'none' }} />
            {uploadedFile ? (
              <div style={styles.uploadedFile}>
                <span>{uploadedFile.name}</span>
                <button type="button" onClick={handleRemoveFile} style={styles.removeBtn}>
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => fileInputRef.current?.click()} style={styles.uploadBtn}>
                <Upload size={20} />
                <span>Click to upload image</span>
              </button>
            )}
          </div>
        </div>

        <div style={ss.formGroup}>
          <RescaleWidget
            enabled={rescaleEnabled} onEnabledChange={setRescaleEnabled}
            mode={rescaleMode} onModeChange={(m) => { rescaleUserEditedRef.current = false; setRescaleMode(m); }}
            width={rescaleWidth} onWidthChange={(v) => { rescaleUserEditedRef.current = true; setRescaleWidth(v); }}
            height={rescaleHeight} onHeightChange={(v) => { rescaleUserEditedRef.current = true; setRescaleHeight(v); }}
            px={rescalePx} onPxChange={setRescalePx}
            mp={rescaleMp} onMpChange={setRescaleMp}
            label="Rescale input image"
          />
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="prompt" style={ss.label}>Prompt:</label>
          <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={ss.textarea} rows="4" />
        </div>

        <div style={ss.formGroup}>
          <div style={ss.labelRow}>
            <label htmlFor="negative" style={ss.label}>Negative Prompt:</label>
            <button type="button" onClick={() => setOverrideNegative(v => !v)} style={ss.toggleBtn}>
              {overrideNegative ? 'use model default' : 'override'}
            </button>
          </div>
          {overrideNegative ? (
            <textarea id="negative" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} style={ss.textarea} rows="2" placeholder="e.g. blurry, deformed, low quality" />
          ) : (
            <span style={ss.defaultHint}>Using workflow default</span>
          )}
        </div>

        <div style={ss.row}>
          <div style={ss.formGroup}>
            <label htmlFor="width" style={ss.label}>Width:</label>
            <input id="width" type="number" value={width} onChange={(e) => { if (rescaleMode === 'exact') rescaleUserEditedRef.current = false; setWidth(e.target.value); }} style={ss.input} />
          </div>
          <div style={ss.formGroup}>
            <label htmlFor="height" style={ss.label}>Height:</label>
            <input id="height" type="number" value={height} onChange={(e) => { if (rescaleMode === 'exact') rescaleUserEditedRef.current = false; setHeight(e.target.value); }} style={ss.input} />
          </div>
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="seed" style={ss.label}>Seed (optional):</label>
          <input id="seed" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="Leave empty for random" style={ss.input} />
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="submit" style={ss.button} disabled={isLoading || !uploadedFile}>
            {isLoading ? 'Processing...' : 'Generate Image'}
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
            <p style={{ ...ss.loading, margin: 0 }}>{statusText || 'Processing image...'}</p>
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

// Styles unique to Img2ImgApp (upload UI)
const styles = {
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
};

export default Img2ImgApp;
