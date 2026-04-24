import React, { useState, useRef, useEffect } from 'react';
import { cancelTask, deleteBucket, statusLabel } from '../sandboxUtils';
import { sandboxStyles as ss } from '../sandboxStyles';
import CircularProgress from './CircularProgress';
import { useCapabilities } from '../hooks/useCapabilities';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import AttributeTag from './AttributeTag';
import ErrorBoundary from './ErrorBoundary';

// Workflow selector — mirrors ImgGenModelSelector but filters txt2music.*
const MusicWorkflowSelector = ({ model, setModel, capabilities }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const valid = (capabilities || []).filter(c => typeof c === 'string' && c.startsWith('txt2music.'));
  const isEmpty = valid.length === 0;
  const safeModel = typeof model === 'string' ? model : '';

  const selectedCap = valid.find(c => stripCapabilityAttrs(c).replace(/^txt2music\./, '') === safeModel);
  const selectedAttrs = selectedCap ? (parseCapabilityAttrs(selectedCap) || []) : [];

  return (
    <div style={{ position: 'relative', flex: 1 }} ref={ref}>
      <button
        type="button"
        style={{
          width: '100%', padding: '5px 10px', fontSize: '13px',
          border: `1px ${isEmpty ? 'dashed' : 'solid'} var(--border)`,
          borderRadius: '6px', outline: 'none', background: 'var(--input-bg)',
          color: 'var(--text)', cursor: 'pointer', textAlign: 'left',
          opacity: isEmpty ? 0.7 : 1,
        }}
        onClick={() => setOpen(v => !v)}
      >
        {isEmpty ? (
          <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: '12px' }}>
            No agents online
          </span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>{safeModel || '(no selection)'}</span>
            {selectedAttrs.map((a, i) => <AttributeTag key={i} attr={a} inline />)}
          </span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '4px',
          background: 'var(--glass-strong)', border: '1px solid var(--border)',
          borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,.15)',
          zIndex: 1000, maxHeight: '200px', overflowY: 'auto',
        }}>
          {valid.length ? valid.map((cap, i) => {
            const base = stripCapabilityAttrs(cap);
            const wf = base.replace(/^txt2music\./, '');
            const attrs = parseCapabilityAttrs(cap) || [];
            const selected = safeModel === wf;
            return (
              <div key={i}
                style={{
                  padding: '8px 10px', fontSize: '13px', cursor: 'pointer',
                  borderBottom: '1px solid rgba(0,0,0,.05)',
                  backgroundColor: selected ? 'var(--primary)' : 'transparent',
                  color: selected ? '#fff' : 'var(--text)',
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.backgroundColor = 'var(--chip-bg)'; }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.backgroundColor = 'transparent'; }}
                onClick={() => { setModel(wf); setOpen(false); }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', pointerEvents: 'none' }}>
                  <span>{wf}</span>
                  {attrs.map((a, ai) => <AttributeTag key={ai} attr={a} inline />)}
                </span>
              </div>
            );
          }) : (
            <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
              No txt2music workflows online
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Audio player toolbar shown after generation completes
const AudioPlayer = ({ audioItems }) => {
  const [current, setCurrent] = useState(0);
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const item = audioItems?.[current];

  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setDuration(0);
  }, [current, audioItems]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setProgress(el.currentTime);
    const onDuration = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onDuration);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onDuration);
      el.removeEventListener('ended', onEnded);
    };
  }, [item]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play(); setPlaying(true); }
  };

  const seek = (e) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    el.currentTime = ratio * duration;
  };

  const fmt = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  if (!item) return null;

  const pct = duration ? (progress / duration) * 100 : 0;

  return (
    <div style={playerStyles.wrap}>
      {audioItems.length > 1 && (
        <div style={playerStyles.trackList}>
          {audioItems.map((_, i) => (
            <button key={i} type="button"
              style={{ ...playerStyles.trackBtn, background: i === current ? 'var(--primary)' : 'var(--chip-bg)' }}
              onClick={() => setCurrent(i)}
            >
              Track {i + 1}
            </button>
          ))}
        </div>
      )}
      <audio ref={audioRef} src={item.url} preload="metadata" style={{ display: 'none' }} />
      <div style={playerStyles.toolbar}>
        <button type="button" onClick={togglePlay} style={playerStyles.playBtn} title={playing ? 'Pause' : 'Play'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span style={playerStyles.time}>{fmt(progress)}</span>
        <div style={playerStyles.scrubberTrack} onClick={seek} title="Seek">
          <div style={{ ...playerStyles.scrubberFill, width: `${pct}%` }} />
          <div style={{ ...playerStyles.scrubberThumb, left: `calc(${pct}% - 6px)` }} />
        </div>
        <span style={playerStyles.time}>{fmt(duration)}</span>
        {item.filename && (
          <a href={item.url} download={item.filename} style={playerStyles.dlBtn} title="Download">
            ↓
          </a>
        )}
      </div>
    </div>
  );
};

const playerStyles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' },
  trackList: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  trackBtn: {
    padding: '3px 10px', borderRadius: '4px', border: 'none',
    color: 'var(--text)', fontSize: '12px', cursor: 'pointer',
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: '10px',
    background: 'var(--glass)', border: '1px solid var(--border)',
    borderRadius: '8px', padding: '10px 14px',
  },
  playBtn: {
    width: '32px', height: '32px', borderRadius: '50%',
    background: 'var(--primary)', border: 'none', cursor: 'pointer',
    fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  scrubberTrack: {
    flex: 1, height: '6px', background: 'var(--border)', borderRadius: '3px',
    position: 'relative', cursor: 'pointer',
  },
  scrubberFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    background: 'var(--primary)', borderRadius: '3px',
    pointerEvents: 'none',
  },
  scrubberThumb: {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)',
    width: '12px', height: '12px', borderRadius: '50%',
    background: 'var(--primary)', border: '2px solid #fff',
    pointerEvents: 'none',
  },
  time: { fontSize: '11px', color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  dlBtn: {
    padding: '4px 8px', borderRadius: '4px', background: 'var(--chip-bg)',
    color: 'var(--text)', textDecoration: 'none', fontSize: '14px', flexShrink: 0,
  },
};

const Txt2MusicApp = ({ apiKey, addDevEntry }) => {
  const [model, setModel] = useState('');
  const [tags, setTags] = useState('pop, upbeat, electronic');
  const [lyrics, setLyrics] = useState('');
  const [bpm, setBpm] = useState('');
  const [duration, setDuration] = useState(30);
  const [seed, setSeed] = useState('');

  // Model-specific fields (ACE Step and compatible models)
  const [language, setLanguage] = useState('');
  const [keyscale, setKeyscale] = useState('');
  const [cfgScale, setCfgScale] = useState('');
  const [temperature, setTemperature] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [response, setResponse] = useState(null);
  const [audioItems, setAudioItems] = useState([]);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [heuristicSecs, setHeuristicSecs] = useState(null);
  const [taskCreatedAt, setTaskCreatedAt] = useState(null);

  const outputBucketRef = useRef(null);
  const cancelledRef = useRef(false);
  const activeTaskRef = useRef(null);
  const blobUrlsRef = useRef([]);

  const [capabilities] = useCapabilities('txt2music.', { setModel, setError });

  // Revoke blob URLs on unmount
  useEffect(() => () => blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u)), []);

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
    setAudioItems([]);
    setError(null);
    setStatusText('Creating output bucket...');

    let bucketUid = null;
    try {
      const r = await fetch('/api/storage/bucket/create', { method: 'POST', headers: { 'X-API-Key': apiKey } });
      const d = await r.json();
      if (!d.bucket_uid) throw new Error('Failed to create output bucket');
      bucketUid = d.bucket_uid;
      outputBucketRef.current = bucketUid;
      addDevEntry?.({ label: 'Create output bucket', method: 'POST', url: '/api/storage/bucket/create', request: {}, response: d });
    } catch (err) {
      setError(`Failed to create output bucket: ${err instanceof Error ? err.message : String(err)}`);
      setIsLoading(false);
      return;
    }

    setStatusText('Submitting...');

    const payload = {
      apiKey,
      capability: `txt2music.${model}`,
      urgent: false,
      output_bucket: bucketUid,
      payload: {
        workflow: 'txt2music',
        tags,
        ...(lyrics.trim() && { lyrics: lyrics.trim() }),
        ...(bpm && { bpm: parseInt(bpm) }),
        duration: parseInt(duration) || 30,
        ...(seed && { seed: parseInt(seed) || -1 }),
        ...(language.trim() && { language: language.trim() }),
        ...(keyscale.trim() && { keyscale: keyscale.trim() }),
        ...(cfgScale !== '' && { cfg_scale: parseFloat(cfgScale) }),
        ...(temperature !== '' && { temperature: parseFloat(temperature) }),
      },
    };

    try {
      const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      addDevEntry?.({ label: 'Submit txt2music task', method: 'POST', url: '/api/task/submit', request: payload, response: data });

      if (data.error) {
        setError(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
        setIsLoading(false);
        deleteBucket(bucketUid, apiKey);
        outputBucketRef.current = null;
      } else if (data.id) {
        activeTaskRef.current = { cap: data.id.cap, id: data.id.id };
        pollTask(data.id.cap, data.id.id, bucketUid);
      } else {
        setError('Unexpected response format.');
        setIsLoading(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addDevEntry?.({ label: 'Submit txt2music task', method: 'POST', url: '/api/task/submit', request: payload, response: { error: msg } });
      setError(`An error occurred: ${msg}`);
      setIsLoading(false);
    }
  };

  const pollTask = async (cap, id, outBucketUid) => {
    const maxAttempts = 180;
    let attempts = 0;

    const poll = async () => {
      if (cancelledRef.current) return;
      if (attempts >= maxAttempts) {
        activeTaskRef.current = null;
        setError('Task polling timeout');
        setIsLoading(false);
        deleteBucket(outBucketUid, apiKey);
        outputBucketRef.current = null;
        return;
      }

      try {
        const res = await fetch(`/api/task/poll/${cap}/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        });
        const data = await res.json();
        addDevEntry?.({ label: `Poll task ${id}`, method: 'POST', url: `/api/task/poll/${cap}/${id}`, request: { apiKey }, response: data });

        if (data.status === 'completed') {
          activeTaskRef.current = null;
          setHeuristicSecs(null);
          setTaskCreatedAt(null);
          setStatusText('Fetching audio...');
          const output = data.output;
          const items = await fetchAudioBlobs(output?.audio || [], apiKey);
          blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u));
          blobUrlsRef.current = items.map(i => i.url);
          setAudioItems(items);
          setResponse(output);
          setStatusText('');
          setIsLoading(false);
          outputBucketRef.current = null;
          deleteBucket(outBucketUid, apiKey);
        } else if (data.status === 'failed' || data.status === 'canceled') {
          activeTaskRef.current = null;
          setHeuristicSecs(null);
          setTaskCreatedAt(null);
          const errMsg = data.output?.error
            ? (typeof data.output.error === 'string' ? data.output.error : JSON.stringify(data.output.error))
            : (data.status === 'canceled' ? 'Task was canceled' : 'Task failed');
          setError(errMsg);
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
        const msg = err instanceof Error ? err.message : String(err);
        addDevEntry?.({ label: `Poll task ${id}`, method: 'POST', url: `/api/task/poll/${cap}/${id}`, request: { apiKey }, response: { error: msg } });
        setError(`Polling error: ${msg}`);
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
            <MusicWorkflowSelector model={model} setModel={setModel} capabilities={capabilities} />
          </div>

          <div style={ss.formGroup}>
            <label htmlFor="tags" style={ss.label}>Tags / style:</label>
            <textarea
              id="tags"
              value={tags}
              onChange={e => setTags(e.target.value)}
              style={ss.textarea}
              rows={2}
              placeholder="pop, upbeat, electronic, female vocal"
            />
          </div>

          <div style={ss.formGroup}>
            <label htmlFor="lyrics" style={ss.label}>Lyrics (optional):</label>
            <textarea
              id="lyrics"
              value={lyrics}
              onChange={e => setLyrics(e.target.value)}
              style={ss.textarea}
              rows={4}
              placeholder="Leave empty for instrumental"
            />
          </div>

          <div style={ss.rowWrap}>
            <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
              <label htmlFor="duration" style={ss.label}>Duration (s):</label>
              <input
                id="duration"
                type="number"
                min={5}
                max={300}
                value={duration}
                onChange={e => setDuration(e.target.value)}
                style={ss.inputInDimensionField}
              />
            </div>
            <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
              <label htmlFor="bpm" style={ss.label}>BPM (optional):</label>
              <input
                id="bpm"
                type="number"
                min={40}
                max={300}
                value={bpm}
                onChange={e => setBpm(e.target.value)}
                placeholder="e.g. 120"
                style={ss.inputInDimensionField}
              />
            </div>
            <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
              <label htmlFor="seed" style={ss.label}>Seed (optional):</label>
              <input
                id="seed"
                type="number"
                value={seed}
                onChange={e => setSeed(e.target.value)}
                placeholder="Random"
                style={ss.inputInDimensionField}
              />
            </div>
          </div>

          {/* Model-specific / advanced fields */}
          <div style={advancedSectionStyle}>
            <button
              type="button"
              onClick={() => setAdvancedOpen(v => !v)}
              style={advancedToggleStyle}
            >
              <span style={{ marginRight: '6px' }}>{advancedOpen ? '▾' : '▸'}</span>
              Model-specific settings
              <span style={advancedBadgeStyle}>ACE Step + compatible</span>
            </button>
            {advancedOpen && (
              <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p style={advancedHintStyle}>
                  Fields below are forwarded as-is to the agent. Unsupported fields for a given model are silently ignored.
                </p>
                <div style={ss.rowWrap}>
                  <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
                    <label htmlFor="language" style={ss.label}>Language:</label>
                    <input
                      id="language"
                      type="text"
                      value={language}
                      onChange={e => setLanguage(e.target.value)}
                      placeholder="e.g. en, zh, fr"
                      style={ss.inputInDimensionField}
                    />
                  </div>
                  <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
                    <label htmlFor="keyscale" style={ss.label}>Key &amp; scale:</label>
                    <input
                      id="keyscale"
                      type="text"
                      value={keyscale}
                      onChange={e => setKeyscale(e.target.value)}
                      placeholder="e.g. C major, A minor"
                      style={ss.inputInDimensionField}
                    />
                  </div>
                </div>
                <div style={ss.rowWrap}>
                  <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
                    <label htmlFor="cfg_scale" style={ss.label}>CFG scale:</label>
                    <input
                      id="cfg_scale"
                      type="number"
                      step="0.1"
                      min="0"
                      max="30"
                      value={cfgScale}
                      onChange={e => setCfgScale(e.target.value)}
                      placeholder="e.g. 7.0"
                      style={ss.inputInDimensionField}
                    />
                  </div>
                  <div style={{ ...ss.formGroup, ...ss.dimensionField }}>
                    <label htmlFor="temperature" style={ss.label}>Temperature:</label>
                    <input
                      id="temperature"
                      type="number"
                      step="0.05"
                      min="0"
                      max="2"
                      value={temperature}
                      onChange={e => setTemperature(e.target.value)}
                      placeholder="e.g. 1.0"
                      style={ss.inputInDimensionField}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="submit" style={ss.button} disabled={isLoading || !model}>
              {isLoading ? 'Generating...' : 'Generate Music'}
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
              <p style={{ ...ss.loading, margin: 0 }}>{statusText || 'Generating music...'}</p>
            </div>
          )}
          {error && <pre style={ss.error}>{error}</pre>}
          {audioItems.length > 0 && (
            <div>
              <p style={ss.responseLabel}>Generated Audio:</p>
              <AudioPlayer audioItems={audioItems} />
              {response?.seed != null && <p style={ss.seedInfo}>Seed: {response.seed}</p>}
            </div>
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
};

async function fetchAudioBlobs(audioList, apiKey) {
  if (!Array.isArray(audioList)) return [];
  const results = [];
  for (const item of audioList) {
    try {
      const res = await fetch(`/api/storage/bucket/${item.bucket_uid}/file/${item.file_uid}`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!res.ok) continue;
      const blob = await res.blob();
      results.push({ url: URL.createObjectURL(blob), filename: item.filename || `audio_${item.file_uid}.mp3` });
    } catch {
      // skip failed files
    }
  }
  return results;
}

const cancelBtnStyle = {
  padding: '8px 16px', borderRadius: '6px',
  background: 'var(--danger, #ef4444)', color: '#fff',
  border: 'none', cursor: 'pointer', fontWeight: 500,
};

const advancedSectionStyle = {
  border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 14px',
};

const advancedToggleStyle = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--text)', fontSize: '13px', fontWeight: 600,
  padding: 0, display: 'flex', alignItems: 'center', gap: '4px',
};

const advancedBadgeStyle = {
  marginLeft: '8px', fontSize: '10px', padding: '1px 6px',
  borderRadius: '4px', background: 'var(--chip-bg)',
  color: 'var(--muted)', fontWeight: 400,
};

const advancedHintStyle = {
  fontSize: '11px', color: 'var(--muted)', margin: 0, lineHeight: 1.5,
};

export default Txt2MusicApp;
