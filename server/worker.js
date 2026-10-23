// server/worker.js
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require('./models/Delivery');
const PullRequest = require('./models/PullRequest');
const { applyEvent, derive } = require('./logic/prState'); // Added this import

async function processDelivery(delivery) {
  if (!delivery) throw new Error('A delivery is required');
  try {
    const payload = delivery.rawPayload;
    const pr = payload?.pull_request;
    const repo = payload?.repository?.full_name;
    if (!repo || !pr?.number) throw new Error('Delivery is missing repository or pull request data');

    const prNumber = pr.number;
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
    prDoc.derived = { state: derivedPR.displayState, reviewStatus: derivedPR.reviewStatus };
    prDoc.updatedAt = new Date();
    prDoc.markModified('facts');
    prDoc.markModified('derived');
    await prDoc.save();

    delivery.status = 'processed';
    await delivery.save();
    return prDoc;
  } catch (error) {
    delivery.status = 'failed';
    delivery.error = error.message;
    await delivery.save();
    throw error;
  }
}

async function processNextDelivery() {
  const delivery = await Delivery.findOneAndUpdate(
    { status: 'received' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' }
  );
  return delivery ? processDelivery(delivery) : null;
}

async function startWorker({ pollIntervalMs = 3000 } = {}) {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('ReviewClock background worker started...');
  return setInterval(() => {
    processNextDelivery().catch(error => console.error('Error in worker loop:', error));
  }, pollIntervalMs);
}

if (require.main === module) {
  startWorker().catch(error => {
    console.error('Could not start ReviewClock worker:', error);
    process.exitCode = 1;
  });
}

module.exports = { processDelivery, processNextDelivery, startWorker };
