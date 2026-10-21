//This script runs continuously, pulls unprocessed raw webhooks from MongoDB, interprets them, and updates your PullRequests table.
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require("./models/Delivery")
const PullRequest = require("./models/PullRequest");

async function startWorker(){
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('ReviewClock background worker started...');
}

// Polling the inbox every 3 seconds(repeatedly checking a resource to see whether something new has arrived.)
setInterval(async () => {
    try {
      // Atomically grab one unprocessed delivery and mark it as 'processing'
      const delivery = await Delivery.findOneAndUpdate(
        { status: 'received' },
        { status: 'processing' },
        { returnDocument: 'after' }
      );

      if (!delivery) return; // Inbox is empty, wait for next tick

      console.log(` Processing delivery: ${delivery.deliveryID} (${delivery.event})`);
      const payload = delivery.rawPayload;

      // Handle 'pull_request' lifecycle events
      if(delivery.event === 'pull_request'){
        const repo = payload.repository.full_name;
        const pr = payload.pull_request;
        const action = payload.action;

        //PR State
        let state = 'open';
        if (action === 'closed') {
          state = pr.merged ? 'merged' : 'closed';
        }

        // Upsert (update or insert) the derived PR state. This operation creates or updates the Pull Request record.
        //DB operation upsert
        const updatedPR = await PullRequest.findOneAndUpdate(
            {sourceId: delivery.sourceId, repo, prNumber: pr.number},
            {
                title: pr.title,
                author: pr.user.login,
                state,
                updatedAt: new Date()
            },
            {upsert: true, returnDocument: true}
        );
        console.log(updatedPR);
      }

      // Mark delivery as successfully processed
      delivery.status = 'processed';
      await delivery.save();
      console.log(`Successfully processed delivery: ${delivery.deliveryID}`);
    } catch (err) {
      console.error(' Error in worker loop:', err);
    }
  }, 3000);

startWorker();

// Main idea: Delivery tracks incoming webhook events, while PullRequest stores the latest PR information.