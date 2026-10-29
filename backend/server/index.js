const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require('./models/Delivery');
const Source = require('./models/Source');
const { router } = require('./routes');
const { startActivityPoller } = require('./streamHub');
const { processNextDelivery } = require('./worker');

const app = express();
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => { req.rawBody = buffer; }
}));

app.get('/', (req, res) => res.send('ReviewClock server is running!'));
app.get('/healthz', (req, res) => res.json({ success: true }));

app.post('/hooks/github/:endpointId', async (req, res, next) => {
  try {
    const source = await Source.findOne({ endpointId: req.params.endpointId }).select('+endpointId +webhookSecret');
    if (!source) return res.status(404).send('Unknown webhook endpoint');

    const signature = req.get('x-hub-signature-256') || '';
    const supplied = /^sha256=([a-f0-9]{64})$/i.exec(signature);
    const expected = crypto.createHmac('sha256', source.webhookSecret).update(req.rawBody || Buffer.alloc(0)).digest();
    const actual = supplied ? Buffer.from(supplied[1], 'hex') : Buffer.alloc(0);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).send('Unauthorized: Invalid signature');
    }

    const deliveryId = req.get('x-github-delivery');
    const event = req.get('x-github-event');
    if (!deliveryId || !event) return res.status(400).send('Missing GitHub delivery headers');

    if (event === 'ping') {
      await Source.updateOne({ _id: source._id }, { $set: { status: 'connected', lastDeliveryAt: new Date() } });
      return res.status(202).send('Ping accepted');
    }

    let inserted = false;
    try {
      await Delivery.create({
        sourceId: String(source._id),
        deliveryID: deliveryId,
        event,
        rawPayload: req.body
      });
      inserted = true;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    await Source.updateOne({ _id: source._id }, { $set: { lastDeliveryAt: new Date() } });
    if (inserted) setImmediate(() => processNextDelivery().catch(error => console.error('Could not process webhook delivery:', error.message)));
    return res.status(202).send('Accepted');
  } catch (error) { return next(error); }
});

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
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  startActivityPoller();
  const port = Number(process.env.PORT) || 3000;
  return app.listen(port, () => console.log(`ReviewClock server listening on port ${port}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error('Could not start ReviewClock server:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
