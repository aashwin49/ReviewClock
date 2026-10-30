const crypto = require('crypto');
const Activity = require('./models/Activity');
const Counter = require('./models/Counter');

const tickets = new Map();
const clients = new Map();
const appendQueues = new Map();
const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REPLAY_LIMIT = 500;

function issueTicket(userId) {
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, { userId: String(userId), expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function takeTicket(ticket) {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

function createSession(userId) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(userId), exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(16).toString('base64url')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function userForSession(id) {
  if (typeof id !== 'string') return null;
  const [payload, signature, extra] = id.split('.');
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(payload).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof decoded.sub === 'string' && decoded.exp > Date.now() ? decoded.sub : null;
  } catch { return null; }
}

function writeEvent(res, event) {
  return res.write(`id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
}

function cleanupClient(client) {
  if (client.closed) return;
  client.closed = true;
  clearInterval(client.heartbeat);
  clearTimeout(client.blockedTimer);
  client.req.removeListener('aborted', client.cleanup);
  client.res.removeListener('close', client.cleanup);
  client.res.removeListener('error', client.cleanup);
  client.res.removeListener('drain', client.onDrain);
  const group = clients.get(client.userId);
  group?.delete(client);
  if (group?.size === 0) clients.delete(client.userId);
  client.queue.length = 0;
}

function endSlowClient(client) {
  cleanupClient(client);
  if (!client.res.destroyed && !client.res.writableEnded) client.res.destroy();
}

function queueEvent(client, event) {
  const lastQueued = client.queue.at(-1)?.sequence || client.lastSent;
  if (event.sequence <= lastQueued) return;
  client.queue.push(event);
  if (client.queue.length > REPLAY_LIMIT) return endSlowClient(client);
  if (!client.blockedTimer) {
    client.blockedTimer = setTimeout(() => endSlowClient(client), 30_000);
    client.blockedTimer.unref?.();
  }
}

function watchBackpressure(client) {
  if (client.blockedTimer) return;
  client.blockedTimer = setTimeout(() => endSlowClient(client), 30_000);
  client.blockedTimer.unref?.();
}

function sendEvent(client, event) {
  if (client.closed || event.sequence <= client.lastSent) return;
  if (client.backpressured || client.queue.length) return queueEvent(client, event);
  try {
    const writable = writeEvent(client.res, event);
    client.lastSent = event.sequence;
    client.pollCursor = Math.max(client.pollCursor || 0, event.sequence);
    if (!writable) {
      client.backpressured = true;
      watchBackpressure(client);
    }
  } catch { cleanupClient(client); }
}

function deliverToClient(client, event) {
  if (client.closed || event.sequence <= client.lastSent) return;
  if (client.catchingUp || client.backpressured || client.queue.length) return queueEvent(client, event);
  sendEvent(client, event);
}

function flushQueue(client) {
  if (client.catchingUp) return;
  client.backpressured = false;
  clearTimeout(client.blockedTimer);
  client.blockedTimer = null;
  while (!client.closed && !client.backpressured && client.queue.length) {
    const event = client.queue.shift();
    if (event.sequence <= client.lastSent) continue;
    try {
      const writable = writeEvent(client.res, event);
      client.lastSent = event.sequence;
      client.pollCursor = Math.max(client.pollCursor || 0, event.sequence);
      if (!writable) client.backpressured = true;
    } catch { cleanupClient(client); }
  }
  if (client.queue.length) watchBackpressure(client);
}

async function appendActivity({ userId, sourceId, type, pullRequest, eventKey = null }) {
  const key = String(userId);
  const prior = appendQueues.get(key) || Promise.resolve();
  const pending = prior.then(() => appendActivityInOrder({ userId: key, sourceId, type, pullRequest, eventKey }));
  appendQueues.set(key, pending.catch(() => {}));
  return pending;
}

async function appendActivityInOrder({ userId, sourceId, type, pullRequest, eventKey }) {
  if (eventKey) {
    const existing = await Activity.findOne({ eventKey });
    if (existing) return existing;
  }
  const counter = await Counter.findOneAndUpdate(
    { _id: userId }, { $inc: { sequence: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  const event = await Activity.create({
    userId, sequence: counter.sequence, sourceId: String(sourceId), type, pullRequest, ...(eventKey ? { eventKey } : {})
  });
  const listeners = clients.get(userId);
  if (listeners) for (const client of listeners) {
    deliverToClient(client, event.toObject());
  }
  return event;
}

let activityPoller = null;
function startActivityPoller({ intervalMs = 1000 } = {}) {
  if (activityPoller) return activityPoller;
  activityPoller = setInterval(async () => {
    for (const [userId, listeners] of clients) {
      const active = [...listeners].filter(client => !client.closed);
      if (!active.length) continue;
      const cursor = Math.min(...active.map(client => client.pollCursor ?? client.lastSent));
      try {
        const events = await Activity.find({ userId, sequence: { $gt: cursor } })
          .sort({ sequence: 1 }).limit(REPLAY_LIMIT).lean();
        for (const event of events) {
          for (const client of active) deliverToClient(client, event);
          for (const client of active) client.pollCursor = Math.max(client.pollCursor || 0, event.sequence);
        }
      } catch (error) {
        console.error('Could not poll activity feed:', error.message);
      }
    }
  }, intervalMs);
  activityPoller.unref?.();
  return activityPoller;
}

async function connectStream(req, res, userId) {
  const parsed = Number(req.get('last-event-id') || req.query.lastEventId || 0);
  const lastEventId = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const client = { req, res, userId: String(userId), lastSent: lastEventId, pollCursor: lastEventId, closed: false, queue: [], backpressured: false };
  const key = String(userId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(client);

  client.cleanup = () => cleanupClient(client);
  client.onDrain = () => flushQueue(client);
  client.heartbeat = setInterval(() => {
    if (client.closed || client.backpressured || res.destroyed || res.writableEnded) return;
    try { if (!res.write(': heartbeat\n\n')) { client.backpressured = true; watchBackpressure(client); } }
    catch { cleanupClient(client); }
  }, 15_000);
  client.heartbeat.unref?.();
  req.on('aborted', client.cleanup);
  res.on('close', client.cleanup);
  res.on('error', client.cleanup);
  res.on('drain', client.onDrain);
  client.catchingUp = true;

  // Register before querying to close the replay/live race; sequence de-duplication
  // ensures an event seen by both paths is only written once.
  let missedCount;
  try { missedCount = await Activity.countDocuments({ userId: key, sequence: { $gt: lastEventId } }); }
  catch (error) { cleanupClient(client); throw error; }
  if (client.closed) return;
  if (missedCount > REPLAY_LIMIT) {
    let newest;
    try { newest = await Counter.findById(key).lean(); }
    catch (error) { cleanupClient(client); throw error; }
    if (client.closed) return;
    const sequence = newest?.sequence || lastEventId;
    try {
      if (!res.write(`id: ${sequence}\nevent: resync\ndata: ${JSON.stringify({ sequence })}\n\n`)) {
        client.backpressured = true;
        watchBackpressure(client);
      }
    }
    catch { cleanupClient(client); return; }
    client.lastSent = sequence;
  } else {
    let missed;
    try { missed = await Activity.find({ userId: key, sequence: { $gt: lastEventId } }).sort({ sequence: 1 }).lean(); }
    catch (error) { cleanupClient(client); throw error; }
    if (client.closed) return;
    for (const event of missed) {
      if (event.sequence <= client.lastSent) continue;
      if (client.backpressured) queueEvent(client, event);
      else sendEvent(client, event);
    }
  }
  client.catchingUp = false;
  if (!client.backpressured && client.queue.length) flushQueue(client);
  client.pollCursor = Math.max(client.pollCursor || 0, client.lastSent);
}

function getActiveStreamCount(userId) {
  return clients.get(String(userId))?.size || 0;
}

module.exports = { issueTicket, takeTicket, createSession, userForSession, appendActivity, connectStream, startActivityPoller, getActiveStreamCount };
