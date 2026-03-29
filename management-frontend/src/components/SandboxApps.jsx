import React, { useState, useEffect, useCallback, useRef } from 'react';
const DevPanel = React.lazy(() => import('./DevPanel'));
import ErrorBoundary from './ErrorBoundary';
import { motion, AnimatePresence } from 'framer-motion';
import { BrainCircuit, Construction, FileText, FolderOpen, MessagesSquare, Pipette, SaveAll, Speech, X, Image, ImagePlus, Blocks, Copy, Check, ScanSearch, MessageCircleMore } from 'lucide-react';
import { fetchOnlineCapabilities, stripCapabilityAttrs } from '../utils';

// Define the content for each app as a functional component.
// In a real-world application, these would be in separate files and imported.
const NotesApp = ({ apiKey }) => (
  <div>
    <h3 className="text-xl font-semibold mb-4">Notes App</h3>
    <p>This is where you'd write and manage your notes. The application has access to the API key for back-end services.</p>
    <p className="mt-4">Received API Key: <code className="bg-gray-200 text-gray-800 p-1 rounded text-sm">{apiKey || 'No API key entered'}</code></p>
  </div>
);

const PhotosApp = ({ apiKey }) => (
  <div>
    <h3 className="text-xl font-semibold mb-4">Photos App</h3>
    <p>Your photos will be displayed here. The API key can be used to load images from a cloud storage service.</p>
    <p className="mt-4">Received API Key: <code className="bg-gray-200 text-gray-800 p-1 rounded text-sm">{apiKey || 'No API key entered'}</code></p>
  </div>
);

const MailApp = ({ apiKey }) => (
  <div>
    <h3 className="text-xl font-semibold mb-4">Mail App</h3>
    <p>This app handles your emails. The API key could be used to connect to your email service provider.</p>
    <p className="mt-4">Received API Key: <code className="bg-gray-200 text-gray-800 p-1 rounded text-sm">{apiKey || 'No API key entered'}</code></p>
  </div>
);

const MusicApp = ({ apiKey }) => (
  <div>
    <h3 className="text-xl font-semibold mb-4">Music App</h3>
    <p>Listen to your favorite music here. The API key might be for a music streaming service or a playlist manager.</p>
    <p className="mt-4">Received API Key: <code className="bg-gray-200 text-gray-800 p-1 rounded text-sm">{apiKey || 'No API key entered'}</code></p>
  </div>
);

const SettingsApp = ({ apiKey }) => (
  <div>
    <h3 className="text-xl font-semibold mb-4">Settings App</h3>
    <p>Manage application settings. The API key could be used to save your preferences to a remote server.</p>
    <p className="mt-4">Received API Key: <code className="bg-gray-200 text-gray-800 p-1 rounded text-sm">{apiKey || 'No API key entered'}</code></p>
  </div>
);

const ProfileApp = ({ apiKey }) => (
  <div>
    <h3 className="text-xl font-semibold mb-4">Profile App</h3>
    <p>View and edit your user profile. The API key can be used to authenticate and retrieve your profile data.</p>
    <p className="mt-4">Received API Key: <code className="bg-gray-200 text-gray-800 p-1 rounded text-sm">{apiKey || 'No API key entered'}</code></p>
  </div>
);

const LlmApp = React.lazy(() => import('./LlmApp'))
const BashApp = React.lazy(() => import('./BashApp'))
const PipelineApp = React.lazy(() => import('./PipelineApp'))
const StreamingLLMApp = React.lazy(() => import('./StreamingLLMApp'))
const LlmChatApp = React.lazy(() => import('./LlmChatApp'))
const StorageBucketApp = React.lazy(() => import('./StorageBucketApp'))
const PdfAnalyzerApp = React.lazy(() => import('./PdfAnalyzerApp'))
const Txt2ImgApp = React.lazy(() => import('./Txt2ImgApp'))
const Img2ImgApp = React.lazy(() => import('./Img2ImgApp'))
const CustomApp = React.lazy(() => import('./CustomApp'))
const ImageAnalyzerApp = React.lazy(() => import('./ImageAnalyzerApp'))
const LlmDebateApp = React.lazy(() => import('./LlmDebateApp'))

const CAPABILITIES_COLLAPSE_AT = 3;

const apps = [
  { id: 'bash', name: 'Bash', logo: Construction, app: BashApp },
  { id: 'llm', name: 'LLM', logo: BrainCircuit, app: LlmApp },
  { id: 'pipeline', name: 'Pipeline', logo: Pipette, app: PipelineApp },
  { id: 'streamingllm', name: 'Streaming LLM', logo: Speech, app: StreamingLLMApp },
  { id: 'llmchat', name: 'LLM Chat', logo: MessagesSquare, app: LlmChatApp },
  { id: 'txt2img', name: 'Txt2Img', logo: ImagePlus, app: Txt2ImgApp },
  { id: 'img2img', name: 'Img2Img', logo: Image, app: Img2ImgApp },
  { id: 'storage', name: 'Storage', logo: FolderOpen, app: StorageBucketApp },
  { id: 'pdf', name: 'PDF Analyzer', logo: FileText, app: PdfAnalyzerApp },
  { id: 'imganalyzer', name: 'Image Analyzer', logo: ScanSearch, app: ImageAnalyzerApp },
  { id: 'llmdebate', name: 'LLM Debate', logo: MessageCircleMore, app: LlmDebateApp },
  { id: 'custom', name: 'Custom', logo: Blocks, app: CustomApp },
];

const SandboxApps = () => {
  const [selectedId, setSelectedId] = useState(null);
  const [apiKey, setApiKey] = useState('client_secret_key_123');
  const [activeTab, setActiveTab] = useState('app');
  const [devLog, setDevLog] = useState([]);
  const [capabilities, setCapabilities] = useState([]);
  const [capsLoading, setCapsLoading] = useState(false);
  const [capsExpanded, setCapsExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const selectedApp = apps.find((app) => app.id === selectedId);
  const closeInterceptorRef = useRef(null);

  const doClose = useCallback(() => {
    closeInterceptorRef.current = null;
    setSelectedId(null);
  }, []);

  const handleCloseButtonClick = useCallback(() => {
    if (closeInterceptorRef.current) {
      closeInterceptorRef.current();
    } else {
      doClose();
    }
  }, [doClose]);

  const setCloseInterceptor = useCallback((fn) => {
    closeInterceptorRef.current = fn;
  }, []);

  useEffect(() => {
    closeInterceptorRef.current = null;
  }, [selectedId]);

  // Sync prop and local state
  useEffect(() => {
    let item = localStorage.getItem('offroadmq-api-key');
    if (item) setApiKey(item);
  }, []);

  // Fetch online capabilities when no app is selected
  useEffect(() => {
    if (selectedId) return;
    const loadCapabilities = async () => {
      setCapsLoading(true);
      try {
        const caps = await fetchOnlineCapabilities();
        setCapabilities(Array.isArray(caps) ? caps : []);
      } catch (err) {
        console.error('Failed to fetch capabilities:', err);
        setCapabilities([]);
      } finally {
        setCapsLoading(false);
      }
    };
    loadCapabilities();
  }, [selectedId]);

  useEffect(() => {
    setCapsExpanded(false);
  }, [capabilities]);

  const addDevEntry = useCallback((entry) => {
    setDevLog(prev => {
      const withTs = { ...entry, ts: new Date().toLocaleTimeString() };
      if (entry.key != null) {
        const idx = prev.findIndex(e => e.key === entry.key);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = withTs;
          return updated;
        }
      }
      return [withTs, ...prev].slice(0, 100);
    });
  }, []);

  useEffect(() => {
    setDevLog([]);
    setActiveTab('app');
  }, [selectedId]);

  // Function to save API key to local storage
  const handleSaveApiKey = () => {
    if (apiKey) {
      localStorage.setItem('offroadmq-api-key', apiKey);
      console.log('API key saved to local storage.');
    }
  };

  // Function to copy API key to clipboard
  const handleCopyApiKey = () => {
    if (apiKey) {
      navigator.clipboard.writeText(apiKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  const transition = { type: "tween", duration: 0.3, ease: "easeInOut" };

  return (
    <div className="flex justify-center items-center min-h-screen p-8 bg-gray-100 font-sans text-gray-900" style={{ fontFamily: 'var(--font-sans)' }}>
      {/* CSS for the component */}
      <style>
        {`
          .capabilities-section {
            width: 100%;
            max-width: 800px;
            margin-bottom: 32px;
          }

          .capabilities-title {
            font-family: var(--font-display), sans-serif;
            font-size: 13px;
            font-weight: 600;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
          }

          .capabilities-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }

          .capability-badge {
            display: inline-flex;
            align-items: center;
            padding: 6px 12px;
            background-color: #f3f4f6;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            font-size: 12px;
            color: #4b5563;
            font-family: monospace;
            font-weight: 500;
            white-space: nowrap;
          }

          .capability-badge:hover {
            background-color: #e5e7eb;
            border-color: #d1d5db;
          }

          .capabilities-empty {
            font-size: 13px;
            color: #9ca3af;
            font-style: italic;
          }

          .capabilities-toggle {
            margin-top: 8px;
            padding: 0;
            font-size: 12px;
            font-weight: 600;
            color: #3b82f6;
            background: none;
            border: none;
            cursor: pointer;
            font-family: inherit;
          }

          .capabilities-toggle:hover {
            text-decoration: underline;
          }

          .app-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 24px;
            max-width: 800px;
            width: 100%;
          }

          .app-tile {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background-color: #ffffff;
            border-radius: 12px;
            cursor: pointer;
            transition: box-shadow 0.2s;
            aspect-ratio: 1; /* Ensures the tile is a perfect square */
            text-align: center;
          }

          .app-tile:hover {
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }

          .app-logo {
            width: 64px;
            height: 64px;
            background-color: #e5e7eb;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 8px;
          }

          .app-name {
            font-family: var(--font-display), sans-serif;
            font-size: 14px;
            font-weight: 500;
            color: #4b5563;
            user-select: none;
          }

          .modal-overlay {
            position: fixed;
            top: 44px; /* Anchor to the top */
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: flex-start; /* Align content to the top */
            background-color: rgba(255, 255, 255, 0.75);
            backdrop-filter: blur(8px);
            padding-top: 24px; /* Add padding from the top */
          }
          
          .modal-content {
            background: #ffffff;
            padding: 24px;
            border-radius: 16px;
            width: 95%;
            max-width: 800px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
            position: relative;
            z-index: 10000;
            overflow-y: auto;
            max-height: calc(100vh - 48px); /* Adjust max-height for mobile */
          }

          @media (max-width: 600px) {
            .modal-content {
              width: 100%;
              height: 100%;
              max-height: 100%; /* Take full height on smaller screens */
              border-radius: 0; /* Remove border radius for a full-screen feel */
            }
          }

          .modal-header {
            display: flex;
            justify-content: flex-end; /* Move the close button to the right */
            margin-bottom: 16px;
          }

          .close-button {
            width: 12px;
            height: 12px;
            background-color: #ef4444; /* macOS red dot */
            border-radius: 50%;
            cursor: pointer;
            border: none;
            outline: none;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .close-button:hover {
            opacity: 0.8;
          }

          .modal-title {
            font-family: var(--font-display), sans-serif;
            font-size: 2rem;
            font-weight: bold;
            color: #1f2937;
            margin-bottom: 16px;
          }
          
          .api-input-container {
            font-family: var(--font-sans), sans-serif;
            display: flex;
            flex-wrap: nowrap; /* Prevent wrapping */
            align-items: center; /* Center items vertically */
            gap: 10px; /* Space between input and button */
            width: 100%;
            max-width: 800px;
            margin-bottom: 24px;
            text-align: center;
            font-size: 14px;
          }

          .api-input-container label {
            white-space: nowrap; /* Prevent label from wrapping */
          }

          .api-input {
            font-family: var(--font-sans), sans-serif;
            width: 100%;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid #d1d5db;
            background-color: #f9fafb;
            color: #1f2937;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s;
          }

          .api-input:focus {
            border-color: #6b7280;
            box-shadow: 0 0 0 2px rgba(107, 114, 128, 0.2);
          }

          .modal-body {
            font-family: var(--font-sans), sans-serif;
            color: #6b7280;
            line-height: 1.6;
          }

          .modal-api-key {
            background-color: #e5e7eb;
            padding: 8px 12px;
            border-radius: 8px;
            font-family: monospace;
            word-break: break-all;
            margin-top: 16px;
          }
        `}
      </style>

      <div className="flex flex-col items-center w-full max-w-[800px]">
        <div className="api-input-container">
          <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-2">Enter API Key</label>
          <input
            id="apiKey"
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="e.g., sk-xxxxxxxxxxxxxxxxxxxxxxxx"
            className="api-input"
          />
          <button className='btn' onClick={() => handleCopyApiKey()} title="Copy API key" style={{ padding: '6px 8px', opacity: 0.6, cursor: 'pointer', transition: 'opacity 0.2s' }} onMouseEnter={(e) => e.target.style.opacity = '1'} onMouseLeave={(e) => e.target.style.opacity = '0.6'}>{copiedKey ? <Check size={18} color="#22c55e" /> : <Copy size={18} />}</button>
          <button className='btn' onClick={() => handleSaveApiKey()}><SaveAll /></button>
        </div>

        {/* Online capabilities section - show when no app is selected */}
        {!selectedId && (
          <motion.div className="capabilities-section" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
            <div className="capabilities-title">Online Capabilities</div>
            <div className="capabilities-list">
              {capsLoading ? (
                <div className="capabilities-empty">Loading...</div>
              ) : capabilities.length > 0 ? (
                (capsExpanded || capabilities.length <= CAPABILITIES_COLLAPSE_AT
                  ? capabilities
                  : capabilities.slice(0, CAPABILITIES_COLLAPSE_AT)
                ).map((cap, idx) => (
                  <div key={idx} className="capability-badge" title={cap}>
                    {stripCapabilityAttrs(cap)}
                  </div>
                ))
              ) : (
                <div className="capabilities-empty">No capabilities online</div>
              )}
            </div>
            {!capsLoading && capabilities.length > CAPABILITIES_COLLAPSE_AT && (
              <button
                type="button"
                className="capabilities-toggle"
                onClick={() => setCapsExpanded((v) => !v)}
              >
                {capsExpanded
                  ? 'Show less'
                  : `Show ${capabilities.length - CAPABILITIES_COLLAPSE_AT} more`}
              </button>
            )}
          </motion.div>
        )}

        {/* The main app grid container */}
        <motion.div layout className="app-grid">
          {apps.map((app) => (
            // Each app tile is a Framer Motion div
            <motion.div
              key={app.id}
              layoutId={app.id} // This is the key for the tile-to-modal animation
              className="app-tile"
              onClick={() => setSelectedId(app.id)}
              whileTap={{ scale: 0.95 }}
              transition={transition}
            >
              <div className="app-logo">
                {React.createElement(app.logo, { size: 36, color: '#4b5563' })}
              </div>
              <div className="app-name">{app.name}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>

      {/* Use AnimatePresence to handle the mount/unmount animations of the modal */}
      <AnimatePresence>
        {selectedId && selectedApp && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              layoutId={selectedId} // The modal shares the same layoutId as the clicked tile
              className="modal-content"
              transition={transition}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
            >
              <div className="modal-header">
                <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
                  <button
                    style={{ padding: '4px 14px', fontSize: '13px', fontWeight: 500, borderRadius: '6px', border: '1px solid transparent', cursor: 'pointer', background: activeTab === 'app' ? '#f3f4f6' : 'none', borderColor: activeTab === 'app' ? '#d1d5db' : 'transparent', color: activeTab === 'app' ? '#1f2937' : '#6b7280' }}
                    onClick={() => setActiveTab('app')}
                  >App</button>
                  <button
                    style={{ padding: '4px 14px', fontSize: '13px', fontWeight: 500, borderRadius: '6px', border: '1px solid transparent', cursor: 'pointer', background: activeTab === 'dev' ? '#f3f4f6' : 'none', borderColor: activeTab === 'dev' ? '#d1d5db' : 'transparent', color: activeTab === 'dev' ? '#1f2937' : '#6b7280', position: 'relative' }}
                    onClick={() => setActiveTab('dev')}
                  >
                    Dev
                    {devLog.length > 0 && <span style={{ marginLeft: '5px', fontSize: '10px', background: '#3b82f6', color: '#fff', borderRadius: '999px', padding: '1px 5px', fontWeight: 700 }}>{devLog.length}</span>}
                  </button>
                </div>
                <button className="close-button" onClick={handleCloseButtonClick}>
                  <X size={8} color="#fff" />
                </button>
              </div>
              <div className="modal-body">
                <React.Suspense fallback={<div>Loading...</div>}>
                  <div style={{ display: activeTab === 'app' ? 'contents' : 'none' }}>
                    <ErrorBoundary>
                      <selectedApp.app apiKey={apiKey} addDevEntry={addDevEntry} setCloseInterceptor={setCloseInterceptor} doClose={doClose} />
                    </ErrorBoundary>
                  </div>
                  <div style={{ display: activeTab === 'dev' ? 'contents' : 'none' }}>
                    <DevPanel entries={devLog} />
                  </div>
                </React.Suspense>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default SandboxApps;
