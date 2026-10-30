import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const mongoose = require('mongoose');
const Source = require('../server/models/Source');
const PullRequest = require('../server/models/PullRequest');
const Delivery = require('../server/models/Delivery');
const Activity = require('../server/models/Activity');
const Counter = require('../server/models/Counter');
const User = require('../server/models/User');
const { applyEvent } = require('../server/logic/prState');
const { processDelivery, processNextDelivery, sweepStalledPullRequests } = require('../server/worker');
const { connectStream } = require('../server/streamHub');

// Explicit opt-in only: never point these destructive cleanup tests at a
// developer's default/local application database.
const enabled = Boolean(process.env.MONGODB_URI_TEST);
const describeWithMongo = enabled ? describe : describe.skip;
const userId = new mongoose.Types.ObjectId();
let source;
let user;
let server;
let baseUrl;
process.env.JWT_SECRET = 'phase8-test-secret-that-is-only-used-for-the-disposable-test';
const { app } = require('../server/index');
const { signToken } = require('../server/auth');

function githubSignature(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function fakeStreamConnection(lastEventId) {
  const req = new EventEmitter();
  req.query = {};
  req.get = name => name.toLowerCase() === 'last-event-id' ? String(lastEventId) : '';
  const res = new EventEmitter();
  const writes = [];
  res.destroyed = false;
  res.writableEnded = false;
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.write = chunk => { writes.push(chunk); return true; };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return { req, res, writes };
}

describeWithMongo('Phase 8 isolated MongoDB integration', () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI_TEST);
    await Delivery.init();
    user = await User.create({ _id: userId, email: `phase8-${userId}@example.test`, passwordHash: 'unused-test-hash' });
    source = await Source.create({
      _id: new mongoose.Types.ObjectId(), userId, repoFullName: 'phase8/test',
      endpointId: `phase8-${new mongoose.Types.ObjectId()}`, webhookSecret: 'test-only-secret',
      stalledThresholdMinutes: 1
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (!source) return;
    await Promise.all([
      PullRequest.deleteMany({ sourceId: String(source._id) }),
      Delivery.deleteMany({ sourceId: String(source._id) }),
      Activity.deleteMany({ userId: String(userId), sourceId: String(source._id) })
    ]);
  });

  beforeEach(async () => {
    if (source) await Source.updateOne({ _id: source._id }, { $set: { stalledThresholdMinutes: 1 } });
  });

  afterAll(async () => {
    if (source) {
      await Source.deleteOne({ _id: source._id });
      await Counter.deleteOne({ _id: String(userId) });
    }
    if (user) await User.deleteOne({ _id: userId });
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
  });

  test('sweeper uses the current threshold and emits once for one stall period', async () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const waitingSince = new Date(now.getTime() - 90_000);
    const pr = await PullRequest.create({
      sourceId: String(source._id), repo: source.repoFullName, prNumber: 1,
      title: 'Sweeper test', author: 'author', state: 'open', waitingSince,
      derived: { state: 'Awaiting review', stalled: false }
    });

    expect(await sweepStalledPullRequests({ now })).toBe(1);
    expect(await sweepStalledPullRequests({ now })).toBe(0);
    expect(await sweepStalledPullRequests({ now })).toBe(0);
    const saved = await PullRequest.findById(pr._id);
    expect(saved.derived.stalled).toBe(true);
    expect(saved.stalledForSince.getTime()).toBe(waitingSince.getTime());
    expect(await Activity.countDocuments({ sourceId: String(source._id), type: 'pull_request.stalled' })).toBe(1);

    // The sweeper queries Source each invocation; a newer threshold applies
    // without restarting the worker.
    await Source.updateOne({ _id: source._id }, { $set: { stalledThresholdMinutes: 2 } });
    const newerPR = await PullRequest.create({
      sourceId: String(source._id), repo: source.repoFullName, prNumber: 2,
      title: 'Dynamic threshold test', author: 'author', state: 'open', waitingSince,
      derived: { state: 'Awaiting review', stalled: false }
    });
    expect(await sweepStalledPullRequests({ now })).toBe(0);
    expect((await PullRequest.findById(newerPR._id)).derived.stalled).toBe(false);
  });

  test('reviewer comment clears a stall and starts a fresh wait period', async () => {
    const openedAt = new Date('2026-10-30T10:00:00.000Z');
    const commentAt = new Date('2026-10-30T11:59:00.000Z');
    const payload = (timestamp, review) => ({
      action: 'submitted', repository: { full_name: source.repoFullName },
      pull_request: { number: 3, title: 'Comment reset test', state: 'open', user: { login: 'author' } },
      review: { id: 33, state: 'commented', submitted_at: timestamp.toISOString(), user: { login: 'reviewer' }, ...review }
    });
    const prPayload = {
      action: 'opened', repository: { full_name: source.repoFullName },
      pull_request: { number: 3, title: 'Comment reset test', state: 'open', updated_at: openedAt.toISOString(), user: { login: 'author' } }
    };
    const facts = applyEvent({}, 'pull_request', prPayload);
    const waitingSince = new Date(openedAt);
    const pr = await PullRequest.create({
      sourceId: String(source._id), repo: source.repoFullName, prNumber: 3,
      title: 'Comment reset test', author: 'author', state: 'open', reviewStatus: 'pending',
      facts, waitingSince, stalledForSince: waitingSince,
      derived: { state: 'Awaiting review', stalled: true }
    });
    const delivery = {
      sourceId: String(source._id), deliveryID: `phase8-comment-${new mongoose.Types.ObjectId()}`,
      event: 'pull_request_review', rawPayload: payload(commentAt), status: 'processing',
      save: async function save() { return this; }
    };

    await processDelivery(delivery);
    const refreshed = await PullRequest.findById(pr._id);
    expect(delivery.status).toBe('processed');
    expect(refreshed.derived.stalled).toBe(false);
    expect(refreshed.waitingSince.getTime()).toBe(commentAt.getTime());
    expect(refreshed.stalledForSince.getTime()).toBe(waitingSince.getTime());
    expect(await sweepStalledPullRequests({ now: new Date(commentAt.getTime() + 59_000) })).toBe(0);
    expect(await sweepStalledPullRequests({ now: new Date(commentAt.getTime() + 61_000) })).toBe(1);
  });

  test('authenticated retry queues only failed deliveries and worker completes the valid retry', async () => {
    const delivery = await Delivery.create({
      sourceId: String(source._id), deliveryID: `phase8-retry-${new mongoose.Types.ObjectId()}`,
      event: 'pull_request', status: 'failed', error: 'temporary test failure',
      rawPayload: {
        action: 'opened', repository: { full_name: source.repoFullName },
        pull_request: { number: 4, title: 'Retry test', state: 'open', updated_at: new Date().toISOString(), user: { login: 'author' } }
      }
    });
    const headers = { Authorization: `Bearer ${signToken(userId)}` };
    const response = await fetch(`${baseUrl}/api/deliveries/${delivery._id}/reprocess`, { method: 'POST', headers });
    expect(response.status).toBe(200);
    const queued = await response.json();
    expect(queued.data.status).toBe('received');
    expect(queued.data.error).toBeUndefined();

    // The API only queues the inbox item; the background worker owns processing.
    const processedPR = await processNextDelivery();
    expect(processedPR.prNumber).toBe(4);
    expect((await Delivery.findById(delivery._id)).status).toBe('processed');

    const duplicateRetry = await fetch(`${baseUrl}/api/deliveries/${delivery._id}/reprocess`, { method: 'POST', headers });
    expect(duplicateRetry.status).toBe(404);
  });

  test('valid duplicate webhook is acknowledged but stored and processed only once', async () => {
    const deliveryID = `phase9-duplicate-${new mongoose.Types.ObjectId()}`;
    const payload = JSON.stringify({
      action: 'opened', repository: { full_name: source.repoFullName },
      pull_request: { number: 9, title: 'Duplicate drill', state: 'open', updated_at: new Date().toISOString(), user: { login: 'author' } }
    });
    const headers = {
      'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': deliveryID,
      'x-hub-signature-256': githubSignature('test-only-secret', payload)
    };
    const post = () => fetch(`${baseUrl}/hooks/github/${source.endpointId}`, { method: 'POST', headers, body: payload });

    expect((await post()).status).toBe(202);
    const duplicateResponse = await post();
    expect(duplicateResponse.status).toBe(202);
    expect(await Delivery.countDocuments({ sourceId: String(source._id), deliveryID })).toBe(1);

    const deadline = Date.now() + 3000;
    let storedDelivery;
    do {
      storedDelivery = await Delivery.findOne({ sourceId: String(source._id), deliveryID });
      if (storedDelivery?.status === 'processed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    expect(storedDelivery.status).toBe('processed');
    const prs = await PullRequest.find({ sourceId: String(source._id), repo: source.repoFullName, prNumber: 9 });
    expect(prs).toHaveLength(1);
    expect(prs[0].facts[`${source.repoFullName}#9`].lifecycleEvents).toHaveLength(1);
  });

  test('tampered, fake, and missing webhook signatures never enter delivery processing', async () => {
    const deliveryID = `phase9-forgery-${new mongoose.Types.ObjectId()}`;
    const originalBody = JSON.stringify({
      action: 'opened', repository: { full_name: source.repoFullName },
      pull_request: { number: 10, title: 'Forgery drill', state: 'open', user: { login: 'author' } }
    });
    const changedBody = originalBody.replace('Forgery drill', 'Tampered drill');
    const headers = {
      'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': deliveryID,
      'x-hub-signature-256': githubSignature('test-only-secret', originalBody)
    };
    const send = (body, signature) => {
      const requestHeaders = { ...headers };
      if (signature === undefined) delete requestHeaders['x-hub-signature-256'];
      else requestHeaders['x-hub-signature-256'] = signature;
      return fetch(`${baseUrl}/hooks/github/${source.endpointId}`, { method: 'POST', headers: requestHeaders, body });
    };

    expect((await send(changedBody, headers['x-hub-signature-256'])).status).toBe(401);
    expect((await send(originalBody, 'sha256=not-a-valid-signature')).status).toBe(401);
    expect((await send(originalBody, undefined)).status).toBe(401);
    expect(await Delivery.countDocuments({ sourceId: String(source._id), deliveryID })).toBe(0);
    expect(await PullRequest.countDocuments({ sourceId: String(source._id), repo: source.repoFullName, prNumber: 10 })).toBe(0);
  });

  test('expired processing lease recovers an abandoned delivery exactly once', async () => {
    const deliveryID = `phase9-crash-${new mongoose.Types.ObjectId()}`;
    const payload = {
      action: 'opened', repository: { full_name: source.repoFullName },
      pull_request: { number: 11, title: 'Crash recovery drill', state: 'open', updated_at: new Date().toISOString(), user: { login: 'author' } }
    };
    const abandoned = await Delivery.create({
      sourceId: String(source._id), deliveryID, event: 'pull_request', status: 'processing',
      processingAt: new Date(Date.now() - 120_000), rawPayload: payload
    });
    expect((await Delivery.findById(abandoned._id)).status).toBe('processing');

    const [workerA, workerB] = await Promise.all([
      processNextDelivery({ processingLeaseMs: 60_000 }),
      processNextDelivery({ processingLeaseMs: 60_000 })
    ]);
    expect([workerA, workerB].filter(Boolean)).toHaveLength(1);
    const finished = await Delivery.findById(abandoned._id);
    expect(finished.status).toBe('processed');
    expect(finished.processingAt).toBeNull();
    expect(await PullRequest.countDocuments({ sourceId: String(source._id), repo: source.repoFullName, prNumber: 11 })).toBe(1);
    expect(await Activity.countDocuments({
      sourceId: String(source._id), eventKey: `${source._id}:${deliveryID}:pull_request.updated`
    })).toBe(1);
  });

  test('SSE reconnect replays multiple webhook activities from MongoDB in sequence', async () => {
    const currentCounter = await Counter.findById(String(userId)).lean();
    const lastProcessedSequence = currentCounter?.sequence || 0;
    const disconnected = fakeStreamConnection(lastProcessedSequence);
    await connectStream(disconnected.req, disconnected.res, String(userId));
    disconnected.res.emit('close');

    for (const [number, deliveryID] of [
      [20, `phase9-catchup-a-${new mongoose.Types.ObjectId()}`],
      [21, `phase9-catchup-b-${new mongoose.Types.ObjectId()}`]
    ]) {
      await Delivery.create({
        sourceId: String(source._id), deliveryID, event: 'pull_request',
        rawPayload: {
          action: 'opened', repository: { full_name: source.repoFullName },
          pull_request: { number, title: `Catch-up ${number}`, state: 'open', updated_at: new Date().toISOString(), user: { login: 'author' } }
        }
      });
      await processNextDelivery();
    }

    const reconnected = fakeStreamConnection(lastProcessedSequence);
    await connectStream(reconnected.req, reconnected.res, String(userId));
    const frames = reconnected.writes.filter(chunk => chunk.includes('event: activity'));
    expect(frames).toHaveLength(2);
    expect(frames.map(frame => Number(frame.match(/^id: (\d+)/m)?.[1]))).toEqual([
      lastProcessedSequence + 1, lastProcessedSequence + 2
    ]);
    const replayed = frames.map(frame => JSON.parse(frame.match(/^data: (.+)$/m)[1]));
    expect(replayed.map(activity => activity.pullRequest.number)).toEqual([20, 21]);
    expect(replayed.every(activity => activity.type === 'pull_request.updated')).toBe(true);
    reconnected.res.emit('close');
  });
});
