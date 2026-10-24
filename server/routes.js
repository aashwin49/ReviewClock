const crypto = require('crypto');
const express = require('express');
const User = require('./models/User');
const Source = require('./models/Source');
const Delivery = require('./models/Delivery');
const PullRequest = require('./models/PullRequest');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('./auth');

const router = express.Router();
const CONNECT_EVENTS = ['Pull requests', 'Pull request reviews'];

function cleanSource(source) {
  return {
    id: String(source._id),
    repoFullName: source.repoFullName,
    stalledThresholdMinutes: source.stalledThresholdMinutes,
    status: source.status,
    lastDeliveryAt: source.lastDeliveryAt,
    createdAt: source.createdAt
  };
}

router.post('/api/auth/register', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 12 || password.length > 256) {
      return res.status(400).json({ success: false, error: 'Provide a valid email and a password between 12 and 256 characters' });
    }
    const user = await User.create({ email, passwordHash: await hashPassword(password) });
    return res.status(201).json({ success: true, token: signToken(user._id), user: { id: String(user._id), email: user.email } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, error: 'An account with that email already exists' });
    return next(error);
  }
});

router.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || typeof password !== 'string' || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    return res.json({ success: true, token: signToken(user._id), user: { id: String(user._id), email: user.email } });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/me', requireAuth, (req, res) => res.json({ success: true, user: { id: String(req.user._id), email: req.user.email } }));

router.get('/api/sources', requireAuth, async (req, res, next) => {
  try {
    const sources = await Source.find({ userId: req.user._id }).sort({ createdAt: -1 });
    return res.json({ success: true, data: sources.map(cleanSource) });
  } catch (error) { return next(error); }
});

router.post('/api/sources', requireAuth, async (req, res, next) => {
  try {
    const repoFullName = typeof req.body?.repoFullName === 'string' ? req.body.repoFullName.trim() : '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
      return res.status(400).json({ success: false, error: 'repoFullName must use the owner/repository format' });
    }
    const source = await Source.create({
      userId: req.user._id,
      repoFullName,
      endpointId: crypto.randomBytes(32).toString('base64url'),
      webhookSecret: crypto.randomBytes(32).toString('hex')
    });
    const baseUrl = (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    return res.status(201).json({
      success: true,
      data: cleanSource(source),
      connect: {
        payloadUrl: `${baseUrl}/hooks/github/${source.endpointId}`,
        contentType: 'application/json',
        secret: source.webhookSecret,
        events: CONNECT_EVENTS,
        status: source.status
      }
    });
  } catch (error) { return next(error); }
});

router.get('/api/sources/:id', requireAuth, async (req, res, next) => {
  try {
    const source = await Source.findOne({ _id: req.params.id, userId: req.user._id });
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    return res.json({ success: true, data: cleanSource(source) });
  } catch (error) { return next(error); }
});

router.patch('/api/sources/:id', requireAuth, async (req, res, next) => {
  try {
    const threshold = req.body?.stalledThresholdMinutes;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 43200) {
      return res.status(400).json({ success: false, error: 'stalledThresholdMinutes must be an integer from 1 to 43200' });
    }
    const source = await Source.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { stalledThresholdMinutes: threshold } },
      { new: true, runValidators: true }
    );
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    return res.json({ success: true, data: cleanSource(source) });
  } catch (error) { return next(error); }
});

router.post('/api/sources/:id/rotate-secret', requireAuth, async (req, res, next) => {
  try {
    const secret = crypto.randomBytes(32).toString('hex');
    const source = await Source.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { webhookSecret: secret, status: 'waiting' } },
      { new: true }
    );
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    return res.json({ success: true, data: cleanSource(source), secret });
  } catch (error) { return next(error); }
});

router.delete('/api/sources/:id', requireAuth, async (req, res, next) => {
  try {
    const source = await Source.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

router.get('/api/pull-requests/:sourceId', requireAuth, async (req, res, next) => {
  try {
    const source = await Source.findOne({ _id: req.params.sourceId, userId: req.user._id }).select('_id');
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    const prs = await PullRequest.find({ sourceId: String(source._id) }).sort({ updatedAt: -1 });
    return res.json({ success: true, count: prs.length, data: prs });
  } catch (error) { return next(error); }
});

router.get('/api/sources/:id/deliveries', requireAuth, async (req, res, next) => {
  try {
    const source = await Source.findOne({ _id: req.params.id, userId: req.user._id }).select('_id');
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    const deliveries = await Delivery.find({ sourceId: String(source._id) }).sort({ receivedAt: -1 }).limit(100).select('-rawPayload');
    return res.json({ success: true, data: deliveries });
  } catch (error) { return next(error); }
});

module.exports = { router, CONNECT_EVENTS };
