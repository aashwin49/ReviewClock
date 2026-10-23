import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';
const mongoose = require('mongoose');
const Delivery = require('../server/models/Delivery');
const PullRequest = require('../server/models/PullRequest');
const { processNextDelivery } = require('../server/worker');

// Use a separate test database so you don't overwrite local development data
const TEST_DB_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/reviewclock_test';

describe('Worker Database Integration', () => {
  beforeAll(async () => {
    await mongoose.connect(TEST_DB_URI);
  });

  afterEach(async () => {
    await Delivery.deleteMany({});
    await PullRequest.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  test('Worker successfully processes a delivery and upserts a PR document', async () => {
    const sourceId = 'test-source-123';
    
    // 1. Seed the Inbox with a 'received' delivery
    const delivery = await Delivery.create({
      sourceId: sourceId,
      deliveryID: 'del-001',
      event: 'pull_request',
      status: 'received',
      rawPayload: {
        action: 'opened',
        repository: { full_name: 'testuser/repo' },
        pull_request: {
          number: 42,
          state: 'open',
          title: 'Integration Test PR',
          user: { login: 'testuser' },
          updated_at: new Date('2026-10-23T10:00:00Z').toISOString(),
        }
      }
    });

    // Process synchronously through the worker's exported polling function.
    await processNextDelivery();

    // 3. Assertions to verify MongoDB updated correctly
    const savedPR = await PullRequest.findOne({ sourceId, prNumber: 42 });
    expect(savedPR).toBeDefined();
    expect(savedPR.title).toBe('Integration Test PR');
    expect(savedPR.derived.state).toBe('Awaiting review'); // Derived dynamically
    expect(savedPR.derived.reviewStatus).toBe('pending');
    
    const savedDelivery = await Delivery.findOne({ deliveryID: 'del-001' });
    expect(savedDelivery.status).toBe('processed');
  });
});
