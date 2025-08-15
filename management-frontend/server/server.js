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

// Proxies
app.use(
  '/api',
  createProxyMiddleware({
    target: API_TARGET,
    changeOrigin: true,
    logLevel: 'debug',
  })
);

app.use(
  '/management',
  createProxyMiddleware({
    target: MGMT_TARGET,
    changeOrigin: true,
    logLevel: 'debug',
  })
);

// Serve static frontend
const staticPath = path.join(__dirname, 'dist');
app.use(express.static(staticPath));

// SPA fallback: send all unknown requests to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(staticPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Frontend server running at http://localhost:${PORT}`);
  console.log(`Proxy /api -> ${API_TARGET}`);
  console.log(`Proxy /management -> ${MGMT_TARGET}`);
});
