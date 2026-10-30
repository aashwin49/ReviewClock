const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require('./models/Delivery');
const Source = require('./models/Source');
const { router } = require('./routes');
const { startActivityPoller } = require('./streamHub');
const { processNextDelivery } = require('./worker');
const { createGitHubWebhookHandler } = require('./githubWebhook');

const app = express();
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

// Helmet-style baseline headers without enabling cross-origin embedding or sniffing.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  next();
});

// Browser API access is limited to the configured React origin. GitHub webhooks
// are outside /api and remain usable by GitHub's server-to-server delivery.
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && origin !== frontendOrigin) return res.status(403).json({ success: false, error: 'Origin not allowed' });
  if (origin) res.set({ 'Access-Control-Allow-Origin': frontendOrigin, 'Access-Control-Allow-Credentials': 'true' });
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => { req.rawBody = buffer; }
}));

app.get('/', (req, res) => res.send('ReviewClock server is running!'));
app.get('/healthz', (req, res) => res.json({ success: true }));

app.post('/hooks/github/:endpointId', createGitHubWebhookHandler({ Source, Delivery, processNextDelivery }));

app.use(router);
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Request body too large' });
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ success: false, error: 'Malformed JSON' });
  }
  if (error.name === 'CastError') return res.status(404).json({ success: false, error: 'Resource not found' });
  console.error('Request failed:', error.message);
  return res.status(500).json({ success: false, error: 'Internal Server Error' });
});

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  if (process.env.NODE_ENV === 'production' && !process.env.API_BASE_URL) {
    throw new Error('API_BASE_URL is required in production so GitHub webhook URLs use the public backend origin');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  startActivityPoller();
  const port = Number(process.env.PORT) || 3000;
  return app.listen(port, '0.0.0.0', () => console.log(`ReviewClock server listening on port ${port}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error('Could not start ReviewClock server:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
