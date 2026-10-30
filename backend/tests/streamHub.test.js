import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const Activity = require('../server/models/Activity');
const Counter = require('../server/models/Counter');
const { appendActivity, connectStream, getActiveStreamCount, issueTicket, takeTicket } = require('../server/streamHub');

function fakeConnection() {
  const req = new EventEmitter();
  req.query = {};
  req.get = () => '';
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  const writes = [];
  res.write = value => { writes.push(value); return true; };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return { req, res, writes };
}

describe('SSE stream lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(Activity, 'countDocuments').mockResolvedValue(0);
    vi.spyOn(Activity, 'find').mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([]) }) });
    vi.spyOn(Counter, 'findOneAndUpdate').mockResolvedValue({ sequence: 1 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  test('keeps a connected client registered, then removes it on response close', async () => {
    const { req, res } = fakeConnection();
    await connectStream(req, res, 'sse-user-close');
    expect(getActiveStreamCount('sse-user-close')).toBe(1);
    res.emit('close');
    expect(getActiveStreamCount('sse-user-close')).toBe(0);
    expect(res.listenerCount('drain')).toBe(0);
    expect(req.listenerCount('aborted')).toBe(0);
  });

  test('replays the last-event-id cursor and cleans up aborted requests', async () => {
    const { req, res } = fakeConnection();
    req.get = header => header === 'last-event-id' ? '12' : '';
    req.query.lastEventId = '4';
    await connectStream(req, res, 'sse-user-abort');
    expect(Activity.countDocuments).toHaveBeenCalledWith({ userId: 'sse-user-abort', sequence: { $gt: 12 } });
    expect(getActiveStreamCount('sse-user-abort')).toBe(1);
    req.emit('aborted');
    expect(getActiveStreamCount('sse-user-abort')).toBe(0);
  });

  test('issues single-use tickets and rejects them after expiry', () => {
    vi.useFakeTimers();
    const freshTicket = issueTicket('sse-user-ticket');
    expect(takeTicket(freshTicket)).toBe('sse-user-ticket');
    expect(takeTicket(freshTicket)).toBeNull();

    const expiringTicket = issueTicket('sse-user-ticket');
    vi.advanceTimersByTime(60_001);
    expect(takeTicket(expiringTicket)).toBeNull();
  });

  test('streams new activity to connected clients without polling or page reload', async () => {
    const { req, res, writes } = fakeConnection();
    const userId = 'sse-user-live';
    await connectStream(req, res, userId);
    const activity = { userId, sequence: 1, sourceId: 'source-1', type: 'pull_request.updated', pullRequest: { number: 17 } };
    vi.spyOn(Activity, 'create').mockResolvedValue({ toObject: () => activity });
    await appendActivity({ userId, sourceId: 'source-1', type: activity.type, pullRequest: activity.pullRequest });
    expect(writes.join('')).toContain('event: activity');
    expect(writes.join('')).toContain('"number":17');
    res.emit('close');
  });

  test('queues activity during backpressure and flushes it in sequence after drain', async () => {
    const { req, res, writes } = fakeConnection();
    const userId = 'sse-user-backpressure';
    await connectStream(req, res, userId);
    let firstActivity = true;
    res.write = value => {
      writes.push(value);
      if (value.includes('event: activity') && firstActivity) { firstActivity = false; return false; }
      return true;
    };
    vi.spyOn(Counter, 'findOneAndUpdate')
      .mockResolvedValueOnce({ sequence: 1 })
      .mockResolvedValueOnce({ sequence: 2 });
    vi.spyOn(Activity, 'create')
      .mockImplementationOnce(async data => ({ toObject: () => ({ ...data, sequence: 1 }) }))
      .mockImplementationOnce(async data => ({ toObject: () => ({ ...data, sequence: 2 }) }));
    await appendActivity({ userId, sourceId: 'source-1', type: 'pull_request.updated', pullRequest: { number: 1 } });
    await appendActivity({ userId, sourceId: 'source-1', type: 'pull_request.updated', pullRequest: { number: 2 } });
    expect(writes.join('')).toContain('"number":1');
    expect(writes.join('')).not.toContain('"number":2');
    res.emit('drain');
    expect(writes.join('')).toContain('"number":2');
    expect(writes.filter(value => value.includes('event: activity'))).toHaveLength(2);
    res.emit('close');
  });
});
