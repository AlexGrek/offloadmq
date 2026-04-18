import React, { useEffect, useMemo, useState } from 'react';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import { sandboxStyles as ss } from '../sandboxStyles';
import { useCapabilities } from '../hooks/useCapabilities';

const DEFAULT_MODEL = 'model_q8f16';
const DEFAULT_TEXT = 'Hello from OffloadMQ. This is a text-to-speech test using Kokoro.';

const TtsApp = ({ apiKey, addDevEntry }) => {
  const [capabilities] = useCapabilities('tts.');
  const [capability, setCapability] = useState('');
  const [voice, setVoice] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [text, setText] = useState(DEFAULT_TEXT);

  const [response, setResponse] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const voices = useMemo(() => {
    const selected = capabilities.find((c) => stripCapabilityAttrs(c) === capability);
    return selected ? parseCapabilityAttrs(selected) : [];
  }, [capabilities, capability]);

  useEffect(() => {
    if (!capability && capabilities.length > 0) {
      setCapability(stripCapabilityAttrs(capabilities[0]));
    }
  }, [capabilities, capability]);

  useEffect(() => {
    if (voices.length > 0 && !voices.includes(voice)) {
      setVoice(voices[0]);
    }
  }, [voices, voice]);

  useEffect(() => {
    return () => { if (audioUrl) URL.revokeObjectURL(audioUrl); };
  }, [audioUrl]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!capability) { setError('No TTS capability online.'); return; }
    if (!text.trim()) { setError('Text is required.'); return; }

    setIsLoading(true);
    setError(null);
    setResponse(null);
    if (audioUrl) { URL.revokeObjectURL(audioUrl); setAudioUrl(null); }

    const body = {
      capability,
      urgent: true,
      payload: { model, voice, input: text },
      apiKey,
    };

    try {
      const res = await fetch('/api/task/submit_blocking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      addDevEntry?.({
        label: 'Submit TTS (blocking)',
        method: 'POST',
        url: '/api/task/submit_blocking',
        request: body,
        response: data,
      });

      if (data.error) {
        setError(typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error)));
      } else if (data.result?.audio_data_base64) {
        const { audio_data_base64, content_type } = data.result;
        const mime = content_type || 'audio/wav';
        const binary = atob(audio_data_base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setAudioUrl(url);
        setResponse({
          bytes: bytes.length,
          content_type: mime,
        });
      } else {
        setError(`Unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
      }
    } catch (err) {
      addDevEntry?.({
        label: 'Submit TTS (blocking)',
        method: 'POST',
        url: '/api/task/submit_blocking',
        request: body,
        response: { error: err.message },
      });
      setError(`Request failed: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const downloadName = useMemo(() => {
    const ext = response?.content_type?.includes('mpeg') ? 'mp3' :
                response?.content_type?.includes('ogg') ? 'ogg' :
                response?.content_type?.includes('wav') ? 'wav' : 'audio';
    const slug = (voice || 'tts').replace(/[^a-z0-9_-]/gi, '_').slice(0, 24);
    return `${slug}.${ext}`;
  }, [response, voice]);

  return (
    <div style={ss.content}>
      <form onSubmit={handleSubmit} style={ss.form}>
        <div style={ss.row}>
          <div style={{ ...ss.formGroup, flex: 1 }}>
            <label style={ss.label}>Capability:</label>
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              style={ss.input}
              disabled={capabilities.length === 0}
            >
              {capabilities.length === 0 && <option value="">No tts.* capability online</option>}
              {capabilities.map((c) => {
                const base = stripCapabilityAttrs(c);
                return <option key={base} value={base}>{base}</option>;
              })}
            </select>
          </div>

          <div style={{ ...ss.formGroup, flex: 1 }}>
            <label style={ss.label}>Voice:</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              style={ss.input}
              disabled={voices.length === 0}
            >
              {voices.length === 0 && <option value="">(voice list unavailable — type below)</option>}
              {voices.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            {voices.length === 0 && (
              <input
                type="text"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                placeholder="e.g., af_heart"
                style={{ ...ss.input, marginTop: '6px' }}
              />
            )}
          </div>
        </div>

        <div style={ss.formGroup}>
          <label style={ss.label}>Model:</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={ss.monoInput}
            placeholder={DEFAULT_MODEL}
          />
        </div>

        <div style={ss.formGroup}>
          <label htmlFor="tts-text" style={ss.label}>Text:</label>
          <textarea
            id="tts-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={ss.textarea}
            rows="5"
            placeholder="Type something to synthesize..."
          />
        </div>

        <button type="submit" style={ss.button} disabled={isLoading || !capability}>
          {isLoading ? 'Synthesizing...' : 'Synthesize'}
        </button>
      </form>

      <div style={ss.responseContainer}>
        {isLoading && <p style={ss.loading}>Waiting for audio...</p>}
        {error && <pre style={ss.error}>{error}</pre>}
        {audioUrl && (
          <div>
            <audio controls src={audioUrl} style={{ width: '100%' }} />
            <div style={{ ...ss.imageFooter, marginTop: '8px' }}>
              <span style={ss.imageName}>
                {response.content_type} · {(response.bytes / 1024).toFixed(1)} KB
              </span>
              <a href={audioUrl} download={downloadName} style={ss.downloadLink}>
                Download
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TtsApp;
