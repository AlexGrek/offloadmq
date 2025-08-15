import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Environment variables (with defaults)
const API_TARGET = process.env.API_TARGET || 'http://localhost:5000';
const MGMT_TARGET = process.env.MGMT_TARGET || 'http://localhost:5001';
const PORT = process.env.PORT || 8080;

// Add request logging middleware BEFORE proxy setup
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.originalUrl} - Headers:`, req.headers);
  next();
});

// Direct proxy setup - simpler and more reliable
app.use('/api', createProxyMiddleware({
  target: API_TARGET,
  changeOrigin: true,
  logLevel: 'debug',
  onProxyReq: (proxyReq, req) => {
    console.log(`[API] PROXYING: ${req.method} ${req.originalUrl} -> ${API_TARGET}${proxyReq.path}`);
  },
  onProxyRes: (proxyRes, req) => {
    console.log(`[API] RESPONSE: ${proxyRes.statusCode} for ${req.method} ${req.originalUrl}`);
  },
  onError: (err, req, res) => {
    console.error(`[API] PROXY ERROR for ${req.originalUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'API proxy error', details: err.message });
    }
  }
}));

app.use('/management', createProxyMiddleware({
  target: MGMT_TARGET,
  changeOrigin: true,
  logLevel: 'debug',
  onProxyReq: (proxyReq, req) => {
    console.log(`[MGMT] PROXYING: ${req.method} ${req.originalUrl} -> ${MGMT_TARGET}${proxyReq.path}`);
  },
  onProxyRes: (proxyRes, req) => {
    console.log(`[MGMT] RESPONSE: ${proxyRes.statusCode} for ${req.method} ${req.originalUrl}`);
  },
  onError: (err, req, res) => {
    console.error(`[MGMT] PROXY ERROR for ${req.originalUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Management proxy error', details: err.message });
    }
  }
}));

console.log("Proxy servers initialized");
console.log(`API Proxy: /api -> ${API_TARGET}`);
console.log(`MGMT Proxy: /management -> ${MGMT_TARGET}`);

// Serve static frontend
const staticPath = path.join(__dirname, 'dist');
app.use(express.static(staticPath));
console.log("Static initialized: " + staticPath);

// Add a catch-all 404 handler BEFORE the SPA fallback
app.use('/api/*', (req, res) => {
  console.log(`[404] API route not handled by proxy: ${req.originalUrl}`);
  res.status(404).json({ error: 'API endpoint not found', path: req.originalUrl });
});

app.use('/management/*', (req, res) => {
  console.log(`[404] Management route not handled by proxy: ${req.originalUrl}`);
  res.status(404).json({ error: 'Management endpoint not found', path: req.originalUrl });
});

// SPA fallback: send all unknown requests to index.html
app.get('*', (req, res) => {
  console.log(`[SPA] Serving index.html for: ${req.originalUrl}`);
  res.sendFile(path.join(staticPath, 'index.html'));
});

async function testBackendAuth() {
  console.log(`[Startup] Testing backend connectivity...`);
  
  // Test both endpoints
  const endpoints = [
    { name: 'API', url: `${API_TARGET}/api/health` },
    { name: 'MGMT', url: `${MGMT_TARGET}/management/agents/list` }
  ];
  
  for (const endpoint of endpoints) {
    try {
      console.log(`[Startup] Testing ${endpoint.name}: ${endpoint.url}`);
      const res = await fetch(endpoint.url);
      console.log(`[Startup] ${endpoint.name} responded with status: ${res.status} ${res.statusText}`);
      
      if (res.status === 403) {
        console.log(`[Startup] ${endpoint.name} returned expected FORBIDDEN (403)`);
      } else if (res.status === 404) {
        console.log(`[Startup] ${endpoint.name} endpoint not found (404) - check if backend is running`);
      }
      
      const text = await res.text();
      if (text) {
        console.log(`[Startup] ${endpoint.name} response body:`, text.substring(0, 200));
      }
    } catch (err) {
      console.error(`[Startup] Error reaching ${endpoint.name} (${endpoint.url}):`, err.message);
    }
  }
}

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('[ERROR] Express error handler:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Frontend server running at http://localhost:${PORT}`);
  console.log(`Proxy /api -> ${API_TARGET}`);
  console.log(`Proxy /management -> ${MGMT_TARGET}`);
  console.log(`Static files serving from ${staticPath}`);
  console.log(`---`);
  console.log(`Test URLs:`);
  console.log(`  Frontend: http://localhost:${PORT}`);
  console.log(`  API Proxy: http://localhost:${PORT}/api/...`);
  console.log(`  MGMT Proxy: http://localhost:${PORT}/management/...`);
  console.log(`---`);
  
  testBackendAuth();
});
