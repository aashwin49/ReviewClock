import { beforeEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
const { createGitHubWebhookHandler } = require('../server/githubWebhook');

const secret = 'webhook-test-secret';
const source = { _id: 'source-id', webhookSecret: secret };
let Source;
let Delivery;
let processNextDelivery;
let handler;

beforeEach(() => {
  Source = {
    findOne: vi.fn(() => ({ select: vi.fn().mockResolvedValue(source) })),
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true })
  };
  Delivery = { create: vi.fn().mockResolvedValue({}) };
  processNextDelivery = vi.fn().mockResolvedValue(null);
  handler = createGitHubWebhookHandler({ Source, Delivery, processNextDelivery });
});

function requestFor(event, payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const headers = {
    'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    'x-github-delivery': `delivery-${event}`,
    'x-github-event': event
  };
  return { params: { endpointId: 'endpoint-id' }, body: payload, rawBody, get: name => headers[name.toLowerCase()] || '' };
}

function response() {
  return {
    statusCode: 200, body: '',
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
}

async function deliver(event, payload) {
  const res = response();
  const next = vi.fn();
  await handler(requestFor(event, payload), res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

describe('GitHub webhook ingress', () => {
  test('queues validated pull request events', async () => {
    const res = await deliver('pull_request', {
      action: 'opened', repository: { full_name: 'octo/repo' },
      pull_request: { number: 3, title: 'A PR', user: { login: 'octo' } }
    });
    expect(res.statusCode).toBe(202);
    expect(Delivery.create).toHaveBeenCalledWith(expect.objectContaining({ event: 'pull_request' }));
    expect(Source.updateOne).toHaveBeenCalled();
  });

  test('rejects malformed supported events and ignores unrelated events', async () => {
    const malformed = await deliver('pull_request_review', { action: 'submitted' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toMatch(/repository\.full_name/);
    expect(Delivery.create).not.toHaveBeenCalled();

    const ignored = await deliver('push', { ref: 'refs/heads/main' });
    expect(ignored.statusCode).toBe(202);
    expect(ignored.body).toMatch(/Ignored unsupported event/);
    expect(Delivery.create).not.toHaveBeenCalled();
  });

  test('keeps GitHub ping behavior intact and rejects invalid signatures', async () => {
    const ping = await deliver('ping', { zen: 'Keep it logically awesome.' });
    expect(ping.statusCode).toBe(202);
    expect(ping.body).toBe('Ping accepted');
    expect(Source.updateOne).toHaveBeenCalledWith({ _id: source._id }, expect.objectContaining({ $set: expect.objectContaining({ status: 'connected' }) }));

    const req = requestFor('ping', {});
    req.rawBody = Buffer.from('tampered');
    const invalid = response();
    await handler(req, invalid, vi.fn());
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).toMatch(/Invalid/);
  });
});
