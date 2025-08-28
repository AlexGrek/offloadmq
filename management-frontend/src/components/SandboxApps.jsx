import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BrainCircuit, Construction, SaveAll, X } from 'lucide-react';

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

const apps = [
    { id: 'bash', name: 'Bash', logo: Construction, app: BashApp },
    { id: 'llm', name: 'LLM', logo: BrainCircuit, app: LlmApp },
];

const SandboxApps = () => {
    const [selectedId, setSelectedId] = useState(null);
    const [apiKey, setApiKey] = useState('client_secret_key_123');
    const selectedApp = apps.find((app) => app.id === selectedId);

    // Sync prop and local state
    useEffect(() => {
        let item = localStorage.getItem('offroadmq-api-key');
        if (item) setApiKey(item);
    }, []);

    // Function to save API key to local storage
    const handleSaveApiKey = () => {
        if (apiKey) {
            localStorage.setItem('offroadmq-api-key', apiKey);
            console.log('API key saved to local storage.');
        }
    };

    const transition = { type: "tween", duration: 0.3, ease: "easeInOut" };

    return (
        <div className="flex justify-center items-center min-h-screen p-8 bg-gray-100 font-sans text-gray-900">
            {/* CSS for the component */}
            <style>
                {`
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
            font-size: 2rem;
            font-weight: bold;
            color: #1f2937;
            margin-bottom: 16px;
          }
          
          .api-input-container {
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
                    <button className='btn' onClick={() => handleSaveApiKey()}><SaveAll /></button>
                </div>

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
                                <button
                                    className="close-button"
                                    onClick={() => setSelectedId(null)}
                                >
                                    {/* The X icon for the close button */}
                                    <X size={8} color="#fff" />
                                </button>
                            </div>
                            <div className="modal-body">
                                <selectedApp.app apiKey={apiKey} />
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default SandboxApps;
