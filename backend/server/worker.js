// server/worker.js
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require('./models/Delivery');
const PullRequest = require('./models/PullRequest');
const Source = require('./models/Source');
const { applyEvent, derive } = require('./logic/prState');
const { appendActivity } = require('./streamHub');
const { isSupportedPullRequestEvent, validatePullRequestPayload } = require('./logic/webhookValidation');

function publicPR(prDoc) {
  return {
    id: String(prDoc._id), number: prDoc.prNumber, title: prDoc.title,
    author: prDoc.author, state: prDoc.derived?.state,
    waitingSince: prDoc.waitingSince, stalled: Boolean(prDoc.derived?.stalled),
    readyAt: prDoc.readyAt, firstReviewAt: prDoc.firstReviewAt, sourceId: prDoc.sourceId
  };
}

async function processDelivery(delivery) {
  if (!delivery) throw new Error('A delivery is required');
  try {
    const payload = delivery.rawPayload;
    if (!isSupportedPullRequestEvent(delivery.event)) {
      delivery.status = 'ignored';
      delivery.processingAt = null;
      delivery.error = `Unsupported webhook event: ${delivery.event || 'unknown'}`;
      await delivery.save();
      return null;
    }
    const payloadError = validatePullRequestPayload(delivery.event, payload);
    if (payloadError) throw new Error(payloadError);
    const pr = payload?.pull_request;
    const repo = payload?.repository?.full_name;

    const prNumber = pr.number;
    let source = null;
    try { source = await Source.findById(delivery.sourceId).select('userId stalledThresholdMinutes'); }
    catch (error) { if (error.name !== 'CastError') throw error; }
    let prDoc = await PullRequest.findOne({ sourceId: delivery.sourceId, repo, prNumber });
    if (!prDoc) prDoc = new PullRequest({ sourceId: delivery.sourceId, repo, prNumber });

    const nextFacts = applyEvent(prDoc.facts || {}, delivery.event, payload);
    const prKey = `${repo}#${prNumber}`;
    const derivedPR = derive(nextFacts)[prKey];
    if (!derivedPR) throw new Error(`Could not derive state for PR ${prKey}`);

    prDoc.title = pr.title;
    prDoc.author = pr.user?.login;
    prDoc.state = derivedPR.state;
    prDoc.reviewStatus = derivedPR.reviewStatus;
    prDoc.facts = nextFacts;
    prDoc.waitingSince = derivedPR.waitingSince ? new Date(derivedPR.waitingSince) : null;
    prDoc.readyAt = derivedPR.readyAt ? new Date(derivedPR.readyAt) : null;
    prDoc.firstReviewAt = derivedPR.firstReviewAt ? new Date(derivedPR.firstReviewAt) : null;
    const thresholdMs = (source?.stalledThresholdMinutes || 1440) * 60_000;
    const alreadyFlagged = prDoc.stalledForSince && prDoc.waitingSince &&
      new Date(prDoc.stalledForSince).getTime() === prDoc.waitingSince.getTime();
    prDoc.derived = {
      state: derivedPR.displayState,
      reviewStatus: derivedPR.reviewStatus,
      waitingSince: prDoc.waitingSince,
      stalled: Boolean(derivedPR.displayState === 'Awaiting review' && alreadyFlagged &&
        Date.now() - prDoc.waitingSince.getTime() >= thresholdMs)
    };
    prDoc.updatedAt = new Date();
    prDoc.markModified('facts');
    prDoc.markModified('derived');
    await prDoc.save();

    if (source) {
      await appendActivity({
        userId: source.userId,
        sourceId: delivery.sourceId,
        type: 'pull_request.updated',
        pullRequest: publicPR(prDoc),
        eventKey: `${delivery.sourceId}:${delivery.deliveryID}:pull_request.updated`
      });
    }

    delivery.status = 'processed';
    delivery.processingAt = null;
    await delivery.save();
    return prDoc;
  } catch (error) {
    delivery.status = 'failed';
    delivery.processingAt = null;
    delivery.error = error.message;
    await delivery.save();
    throw error;
  }
}

async function sweepStalledPullRequests({ now = new Date() } = {}) {
  const sources = await Source.find({}).select('_id userId stalledThresholdMinutes');
  let flagged = 0;
  for (const source of sources) {
    const threshold = Math.max(1, source.stalledThresholdMinutes || 1440) * 60_000;
    const cutoff = new Date(now.getTime() - threshold);
    const candidates = await PullRequest.find({
      sourceId: String(source._id),
      'derived.state': 'Awaiting review',
      waitingSince: { $type: 'date', $lte: cutoff },
      $or: [{ stalledForSince: null }, { $expr: { $ne: ['$stalledForSince', '$waitingSince'] } }]
    }).limit(200);

    for (const candidate of candidates) {
      const waitingSince = candidate.waitingSince;
      const updated = await PullRequest.findOneAndUpdate({
        _id: candidate._id,
        sourceId: String(source._id),
        'derived.state': 'Awaiting review',
        waitingSince,
        $or: [{ stalledForSince: null }, { $expr: { $ne: ['$stalledForSince', '$waitingSince'] } }]
      }, {
        $set: { stalledForSince: waitingSince, 'derived.stalled': true }
      }, { returnDocument: 'after' });
      if (!updated) continue;
      flagged += 1;
      await appendActivity({
        userId: source.userId,
        sourceId: source._id,
        type: 'pull_request.stalled',
        pullRequest: publicPR(updated)
      });
    }
  }
  return flagged;
}

async function processNextDelivery({ processingLeaseMs = Number(process.env.DELIVERY_PROCESSING_LEASE_MS) || 60_000 } = {}) {
  const staleBefore = new Date(Date.now() - processingLeaseMs);
  const delivery = await Delivery.findOneAndUpdate(
    {
      $or: [
        { status: 'received' },
        { status: 'processing', $or: [{ processingAt: null }, { processingAt: { $lte: staleBefore } }] }
      ]
    },
    { $set: { status: 'processing', processingAt: new Date() } },
    { returnDocument: 'after', sort: { receivedAt: 1 } }
  );
  return delivery ? processDelivery(delivery) : null;
}

async function startWorker({ pollIntervalMs = 3000, sweepIntervalMs = 45_000 } = {}) {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('ReviewClock background worker started...');
  const workerTimer = setInterval(() => {
    processNextDelivery().catch(error => console.error('Error in worker loop:', error));
  }, pollIntervalMs);
  const sweeperTimer = setInterval(() => {
    sweepStalledPullRequests().catch(error => console.error('Error in PR sweeper:', error));
  }, sweepIntervalMs);
  return { workerTimer, sweeperTimer };
}

if (require.main === module) {
  startWorker().catch(error => {
    console.error('Could not start ReviewClock worker:', error);
    process.exitCode = 1;
  });
}

module.exports = { processDelivery, processNextDelivery, sweepStalledPullRequests, startWorker };
