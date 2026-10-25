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

function parsePage(query) {
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit, skip: (page - 1) * limit };
}

async function ownedSourceIds(userId) {
  const sources = await Source.find({ userId }).select('_id');
  return sources.map(source => String(source._id));
}

router.get('/api/prs', requireAuth, async (req, res, next) => {
  try {
    const paging = parsePage(req.query);
    if (!paging) return res.status(400).json({ success: false, error: 'page must be positive and limit must be between 1 and 100' });
    const sourceParam = req.query.source || req.query.sourceId;
    let sourceIds;
    if (sourceParam) {
      const source = await Source.findOne({ _id: sourceParam, userId: req.user._id }).select('_id');
      if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
      sourceIds = [String(source._id)];
    } else {
      sourceIds = await ownedSourceIds(req.user._id);
    }

    const filter = { sourceId: { $in: sourceIds } };
    if (req.query.state) {
      const allowedStates = ['Draft', 'Awaiting review', 'Changes requested', 'Approved', 'Merged', 'Closed'];
      if (!allowedStates.includes(req.query.state)) return res.status(400).json({ success: false, error: 'Unsupported state filter' });
      filter['derived.state'] = req.query.state;
    }
    if (req.query.stalled !== undefined) {
      if (!['true', 'false'].includes(req.query.stalled)) return res.status(400).json({ success: false, error: 'stalled must be true or false' });
      filter['derived.stalled'] = req.query.stalled === 'true';
    }

    const [total, prs] = await Promise.all([
      PullRequest.countDocuments(filter),
      PullRequest.find(filter).sort({ updatedAt: -1, _id: 1 }).skip(paging.skip).limit(paging.limit)
    ]);
    return res.json({
      success: true,
      data: prs,
      pagination: { page: paging.page, limit: paging.limit, total, pages: Math.ceil(total / paging.limit) }
    });
  } catch (error) { return next(error); }
});

router.get('/api/prs/:id', requireAuth, async (req, res, next) => {
  try {
    const sourceIds = await ownedSourceIds(req.user._id);
    const pr = await PullRequest.findOne({ _id: req.params.id, sourceId: { $in: sourceIds } });
    if (!pr) return res.status(404).json({ success: false, error: 'Pull request not found' });

    const deliveries = await Delivery.find({
      sourceId: pr.sourceId,
      $or: [
        { 'rawPayload.pull_request.number': pr.prNumber },
        { 'rawPayload.number': pr.prNumber }
      ]
    }).sort({ receivedAt: 1 }).limit(500).select('+rawPayload');

    const timeline = deliveries.map(delivery => {
      const payload = delivery.rawPayload || {};
      const review = payload.review || {};
      const action = payload.action || delivery.event;
      return {
        deliveryId: delivery.deliveryID,
        event: delivery.event,
        action,
        actor: review.user?.login || payload.sender?.login || null,
        at: review.submitted_at || payload.pull_request?.updated_at || delivery.receivedAt,
        status: delivery.status,
        summary: delivery.event === 'pull_request_review'
          ? `${review.user?.login || 'A reviewer'} ${review.state || action} review`
          : `Pull request ${action}`
      };
    }).sort((left, right) => new Date(left.at) - new Date(right.at));

    const verdictByReviewer = new Map();
    for (const delivery of deliveries) {
      if (delivery.event !== 'pull_request_review') continue;
      const review = delivery.rawPayload?.review || {};
      const reviewer = review.user?.login;
      if (!reviewer) continue;
      const action = delivery.rawPayload?.action;
      const verdict = action === 'dismissed' ? 'dismissed' : String(review.state || '').toLowerCase();
      // A plain comment does not replace that reviewer's most recent verdict.
      if (!['approved', 'changes_requested', 'dismissed'].includes(verdict)) continue;
      const timestamp = new Date(review.submitted_at || delivery.receivedAt).getTime();
      const prior = verdictByReviewer.get(reviewer);
      if (!prior || timestamp >= prior.timestamp) {
        verdictByReviewer.set(reviewer, { reviewer, verdict, submittedAt: new Date(timestamp), timestamp });
      }
    }

    return res.json({
      success: true,
      data: {
        pullRequest: pr,
        timeline,
        reviewerVerdicts: [...verdictByReviewer.values()].map(({ timestamp, ...verdict }) => verdict)
      }
    });
  } catch (error) { return next(error); }
});

router.get('/api/sources/:id/deliveries', requireAuth, async (req, res, next) => {
  try {
    const paging = parsePage(req.query);
    if (!paging) return res.status(400).json({ success: false, error: 'page must be positive and limit must be between 1 and 100' });
    const source = await Source.findOne({ _id: req.params.id, userId: req.user._id }).select('_id');
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    const filter = { sourceId: String(source._id) };
    const allowedStatuses = ['received', 'processing', 'processed', 'failed'];
    if (req.query.status) {
      if (!allowedStatuses.includes(req.query.status)) return res.status(400).json({ success: false, error: 'Unsupported delivery status filter' });
      filter.status = req.query.status;
    }
    const [total, deliveries] = await Promise.all([
      Delivery.countDocuments(filter),
      Delivery.find(filter).sort({ receivedAt: -1, _id: -1 }).skip(paging.skip).limit(paging.limit).select('-rawPayload')
    ]);
    return res.json({
      success: true,
      data: deliveries,
      pagination: { page: paging.page, limit: paging.limit, total, pages: Math.ceil(total / paging.limit) }
    });
  } catch (error) { return next(error); }
});

router.get('/api/stats', requireAuth, async (req, res, next) => {
  try {
    const sourceIds = await ownedSourceIds(req.user._id);
    const groups = await PullRequest.aggregate([
      { $match: { sourceId: { $in: sourceIds } } },
      { $group: { _id: '$derived.state', count: { $sum: 1 } } }
    ]);
    const byState = Object.fromEntries(groups.map(group => [group._id || 'Unknown', group.count]));
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    return res.json({
      success: true,
      data: {
        total,
        byState,
        stalled: await PullRequest.countDocuments({ sourceId: { $in: sourceIds }, 'derived.stalled': true })
      }
    });
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

module.exports = { router, CONNECT_EVENTS };
