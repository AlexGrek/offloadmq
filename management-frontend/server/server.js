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

function logProxy(label) {
    return {
        target: label === 'API' ? API_TARGET : MGMT_TARGET,
        changeOrigin: true,
        logLevel: 'debug', // show proxy-level logs too
        onProxyReq: (proxyReq, req) => {
            console.log(`[${label}] ${req.method} ${req.originalUrl} -> ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
        },
        onProxyRes: (proxyRes, req) => {
            console.log(`[${label}] Response ${proxyRes.statusCode} for ${req.method} ${req.originalUrl}`);
        },
        onError: (err, req, res) => {
            console.error(`[${label}] Proxy error:`, err.message);
            res.status(500).send('Proxy error');
        }
    };
}

app.use('/api', createProxyMiddleware(logProxy('API')));
app.use('/management', createProxyMiddleware(logProxy('MGMT')));

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
