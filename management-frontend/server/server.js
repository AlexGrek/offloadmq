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

function logProxy(label) {
  const target = label === 'API' ? API_TARGET : MGMT_TARGET;
  
  return {
    target: target,
    changeOrigin: true,
    logLevel: 'debug',
    // Add pathRewrite if needed to remove the prefix
    // pathRewrite: {
    //   [`^/${label.toLowerCase()}`]: '', // Remove /api or /management prefix
    // },
    onProxyReq: (proxyReq, req) => {
      console.log(`[${label}] PROXYING: ${req.method} ${req.originalUrl} -> ${target}${proxyReq.path}`);
      console.log(`[${label}] Target URL: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
    },
    onProxyRes: (proxyRes, req) => {
      console.log(`[${label}] RESPONSE: ${proxyRes.statusCode} for ${req.method} ${req.originalUrl}`);
    },
    onError: (err, req, res) => {
      console.error(`[${label}] PROXY ERROR for ${req.originalUrl}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Proxy error', details: err.message });
      }
    }
  };
}

// Create proxy middlewares
const apiProxy = createProxyMiddleware('/api', logProxy('API'));
const mgmtProxy = createProxyMiddleware('/management', logProxy('MGMT'));

// Apply proxy middlewares
app.use('/api', (req, res, next) => {
  console.log(`[DEBUG] API proxy middleware hit for: ${req.originalUrl}`);
  apiProxy(req, res, next);
});

app.use('/management', (req, res, next) => {
  console.log(`[DEBUG] MGMT proxy middleware hit for: ${req.originalUrl}`);
  mgmtProxy(req, res, next);
});

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