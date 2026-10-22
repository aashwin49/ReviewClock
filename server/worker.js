// This script runs continuously, pulls unprocessed raw webhooks from MongoDB, interprets them, and updates your PullRequests table.
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require('./models/Delivery');
const PullRequest = require('./models/PullRequest');

async function startWorker() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('ReviewClock background worker started...');
}

// Polling the inbox every 3 seconds
setInterval(async () => {
  let delivery;

  try {
    // Atomically grab one unprocessed delivery and mark it as 'processing'
    delivery = await Delivery.findOneAndUpdate(
      { status: 'received' },
      { $set: { status: 'processing' } },
      { returnDocument: 'after' }
    );

    if (!delivery) return;

    console.log(`Processing delivery: ${delivery.deliveryID} (${delivery.event})`);

    const payload = delivery.rawPayload;

    // Handle pull_request_review events
    if (delivery.event === 'pull_request_review') {
      const repo = payload.repository.full_name;
      const pr = payload.pull_request;
      const reviewAction = payload.review.state;

      let reviewStatus;

      switch (reviewAction) {
        case 'approved':
          reviewStatus = 'approved';
          break;
        case 'changes_requested':
          reviewStatus = 'changes_requested';
          break;
        case 'commented':
          reviewStatus = 'commented';
          break;
        case 'pending':
          reviewStatus = 'pending';
          break;
        case 'dismissed':
          reviewStatus = 'dismissed';
          break;
        default:
          console.warn(`Unknown review state: ${reviewAction}`);
          return;
      }

      const updatedPR = await PullRequest.findOneAndUpdate(
        {
          sourceId: delivery.sourceId,
          repo,
          prNumber: pr.number
        },
        {
          $set: {
            reviewStatus,
            updatedAt: new Date()
          }
        },
        { returnDocument: 'after' }
      );

      if (updatedPR) {
        console.log(`Updated review status for PR #${pr.number} to: ${reviewStatus}`);
      } else {
        console.warn(`PR #${pr.number} was not found in the database.`);
      }

    } else if (delivery.event === 'pull_request') {
      // Handle standard pull_request lifecycle events (opened, synchronized, closed, etc.)
      const repo = payload.repository.full_name;
      const pr = payload.pull_request;
      const state = pr.state; // e.g., 'open', 'closed'

      const updatedPR = await PullRequest.findOneAndUpdate(
        {
          sourceId: delivery.sourceId,
          repo,
          prNumber: pr.number
        },
        {
          $set: {
            title: pr.title,
            author: pr.user.login,
            state,
            updatedAt: new Date()
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      console.log(`Upserted PR #${pr.number} state: ${state}`);
    }

    // Mark delivery as successfully processed
    delivery.status = 'processed';
    await delivery.save();

    console.log(`Successfully processed delivery: ${delivery.deliveryID}`);

  } catch (err) {
    console.error('Error in worker loop:', err);
  }
}, 3000);

startWorker();

// Main idea: Delivery tracks incoming webhook events, while PullRequest stores the latest PR information. dont change aniline just fix error