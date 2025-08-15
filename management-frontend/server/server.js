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

console.log('Starting proxy server...');
console.log(`API_TARGET: ${API_TARGET}`);
console.log(`MGMT_TARGET: ${MGMT_TARGET}`);

// MINIMAL DEBUG - see what's hitting the server
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// VERSION 3.x SYNTAX - filter function + options
const managementProxy = createProxyMiddleware({
  target: MGMT_TARGET,
  changeOrigin: true,
  logger: console,
  on: {
    proxyReq: function(proxyReq, req, res) {
      console.log(`>>> MGMT PROXY REQ: ${req.method} ${req.url} -> ${MGMT_TARGET}${proxyReq.path}`);
    },
    proxyRes: function(proxyRes, req, res) {
      console.log(`<<< MGMT PROXY RES: ${proxyRes.statusCode} ${req.method} ${req.url}`);
    },
    error: function(err, req, res) {
      console.log(`!!! MGMT PROXY ERROR: ${err.message} for ${req.method} ${req.url}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Management proxy error: ' + err.message);
      }
    }
  }
});

const apiProxy = createProxyMiddleware({
  target: API_TARGET,
  changeOrigin: true,
  logger: console,
  on: {
    proxyReq: function(proxyReq, req, res) {
      console.log(`>>> API PROXY REQ: ${req.method} ${req.url} -> ${API_TARGET}${proxyReq.path}`);
    },
    proxyRes: function(proxyRes, req, res) {
      console.log(`<<< API PROXY RES: ${proxyRes.statusCode} ${req.method} ${req.url}`);
    },
    error: function(err, req, res) {
      console.log(`!!! API PROXY ERROR: ${err.message} for ${req.method} ${req.url}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('API proxy error: ' + err.message);
      }
    }
  }
});

// Apply the proxies
app.use('/management', managementProxy);
app.use('/api', apiProxy);

// TEST ENDPOINTS - to verify server is working
app.get('/test', (req, res) => {
  res.json({ message: 'Server is working', timestamp: new Date().toISOString() });
});

app.get('/proxy-test', (req, res) => {
  res.json({ 
    message: 'Proxy test endpoint',
    targets: {
      api: API_TARGET,
      management: MGMT_TARGET
    }
  });
});

// Serve static files AFTER proxies
const staticPath = path.join(__dirname, 'dist');
app.use(express.static(staticPath));

// SPA fallback - LAST
app.get('*', (req, res) => {
  res.sendFile(path.join(staticPath, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`Server running on port ${PORT}`);
  console.log(`Management proxy: /management -> ${MGMT_TARGET}`);
  console.log(`API proxy: /api -> ${API_TARGET}`);
  console.log(`Static files: ${staticPath}`);
  console.log(`===========================================`);
  console.log(`Test with:`);
  console.log(`  curl http://localhost:${PORT}/test`);
  console.log(`  curl http://localhost:${PORT}/management/anything`);
  console.log(`  curl http://localhost:${PORT}/api/anything`);
  console.log(`===========================================`);
});
