import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Volume2, Loader2, Square } from 'lucide-react';
import { stripCapabilityAttrs, parseCapabilityAttrs } from '../utils';
import { useCapabilities } from '../hooks/useCapabilities';

const VOICE_STORAGE_KEY = 'offroadmq-tts-voice';
const CAPABILITY_STORAGE_KEY = 'offroadmq-tts-capability';

const SpeechWidget = ({ text, apiKey, addDevEntry, disabled = false, compact = true }) => {
  const [capabilities] = useCapabilities('tts.');
  const [capability, setCapability] = useState(() => localStorage.getItem(CAPABILITY_STORAGE_KEY) || '');
  const [voice, setVoice] = useState(() => localStorage.getItem(VOICE_STORAGE_KEY) || '');
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState(null);
  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);

  const voices = useMemo(() => {
    const selected = capabilities.find((c) => stripCapabilityAttrs(c) === capability);
    return selected ? parseCapabilityAttrs(selected) : [];
  }, [capabilities, capability]);

  useEffect(() => {
    if (capabilities.length === 0) return;
    const bases = capabilities.map(stripCapabilityAttrs);
    if (!capability || !bases.includes(capability)) {
      setCapability(bases[0]);
    }
  }, [capabilities, capability]);

  useEffect(() => {
    if (voices.length > 0 && !voices.includes(voice)) {
      setVoice(voices[0]);
    }
  }, [voices, voice]);

  useEffect(() => {
    if (capability) localStorage.setItem(CAPABILITY_STORAGE_KEY, capability);
  }, [capability]);

  useEffect(() => {
    if (voice) localStorage.setItem(VOICE_STORAGE_KEY, voice);
  }, [voice]);

  useEffect(() => () => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
  }, []);

  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setIsPlaying(false);
  };

  const handlePlay = async () => {
    if (isPlaying) { stopPlayback(); return; }
    if (!text || !text.trim()) { setError('No text to speak.'); return; }
    if (!capability) { setError('No TTS capability online.'); return; }

    setError(null);
    setIsLoading(true);

    const model = capability.replace(/^tts\./, '');
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
        label: 'Speech widget TTS',
        method: 'POST',
        url: '/api/task/submit_blocking',
        request: body,
        response: data,
      });

      if (data.error) {
        const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        setError(msg);
        setIsLoading(false);
        return;
      }

      if (!data.result?.audio_data_base64) {
        setError('No audio in response');
        setIsLoading(false);
        return;
      }

      const { audio_data_base64, content_type } = data.result;
      const mime = content_type || 'audio/wav';
      const binary = atob(audio_data_base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));

      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setIsPlaying(false);
        if (audioUrlRef.current === url) {
          URL.revokeObjectURL(url);
          audioUrlRef.current = null;
        }
      };
      audio.onerror = () => {
        setError('Audio playback failed');
        setIsPlaying(false);
      };
      setIsLoading(false);
      setIsPlaying(true);
      await audio.play();
    } catch (err) {
      addDevEntry?.({
        label: 'Speech widget TTS',
        method: 'POST',
        url: '/api/task/submit_blocking',
        request: body,
        response: { error: err.message },
      });
      setError(`Request failed: ${err.message}`);
      setIsLoading(false);
    }
  };

  const unavailable = capabilities.length === 0;
  const btnDisabled = disabled || isLoading || unavailable || !voice || !text?.trim();

  return (
    <div style={{ ...styles.root, ...(compact ? {} : styles.roomy) }}>
      <style>{`@keyframes speech-spin { to { transform: rotate(360deg); } }`}</style>
      <select
        value={voice}
        onChange={(e) => setVoice(e.target.value)}
        style={styles.voiceSelect}
        disabled={unavailable || isLoading || isPlaying}
        title={unavailable ? 'No TTS capability online' : 'Voice'}
      >
        {unavailable && <option value="">no tts</option>}
        {voices.length === 0 && !unavailable && <option value="">(no voices)</option>}
        {voices.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
      <button
        type="button"
        onClick={handlePlay}
        disabled={btnDisabled && !isPlaying}
        style={{
          ...styles.btn,
          ...(isPlaying ? styles.btnPlaying : {}),
          ...(btnDisabled && !isPlaying ? styles.btnDisabled : {}),
        }}
        title={
          unavailable ? 'No TTS capability online'
            : isLoading ? 'Generating…'
            : isPlaying ? 'Stop'
            : 'Read aloud'
        }
      >
        {isLoading ? (
          <Loader2 size={14} style={{ animation: 'speech-spin 1s linear infinite' }} />
        ) : isPlaying ? (
          <Square size={14} fill="currentColor" />
        ) : (
          <Volume2 size={14} />
        )}
      </button>
      {error && <span style={styles.error} title={error}>!</span>}
    </div>
  );
};

const styles = {
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
  },
  roomy: {
    gap: '8px',
  },
  voiceSelect: {
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    padding: '2px 4px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    maxWidth: '110px',
    cursor: 'pointer',
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: 0,
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    cursor: 'pointer',
  },
  btnPlaying: {
    background: 'var(--danger, #ef4444)',
    color: '#fff',
    borderColor: 'transparent',
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  error: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    fontSize: '11px',
    fontWeight: 700,
    color: '#fff',
    background: 'var(--danger, #ef4444)',
    borderRadius: '50%',
    cursor: 'help',
  },
};

export default SpeechWidget;
