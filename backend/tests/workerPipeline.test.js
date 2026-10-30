import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const Source = require('../server/models/Source');
const PullRequest = require('../server/models/PullRequest');
const streamHub = require('../server/streamHub');
vi.spyOn(streamHub, 'appendActivity').mockResolvedValue({});
vi.spyOn(Source, 'findById');
vi.spyOn(PullRequest, 'findOne').mockResolvedValue(null);
vi.spyOn(PullRequest.prototype, 'save').mockImplementation(async function save() { return this; });
const { processDelivery } = require('../server/worker');

describe('valid webhook to tracked pull request pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PullRequest.findOne.mockResolvedValue(null);
    PullRequest.prototype.save.mockImplementation(async function save() { return this; });
    Source.findById.mockReturnValue({ select: vi.fn().mockResolvedValue({ userId: 'user-1', stalledThresholdMinutes: 1440 }) });
  });

  afterAll(() => vi.restoreAllMocks());

  test.each([
    ['pull_request', {
      action: 'opened', repository: { full_name: 'octo/repo' },
      pull_request: { number: 17, title: 'Add a feature', user: { login: 'octo' }, state: 'open', updated_at: '2026-10-30T10:00:00.000Z' }
    }],
    ['pull_request_review', {
      action: 'submitted', repository: { full_name: 'octo/repo' },
      pull_request: { number: 17, title: 'Add a feature', user: { login: 'octo' }, state: 'open' },
      review: { id: 991, state: 'approved', submitted_at: '2026-10-30T10:02:00.000Z', user: { login: 'reviewer' } }
    }]
  ])('processes a valid %s delivery and publishes its updated PR', async (event, rawPayload) => {
    const delivery = {
      sourceId: 'source-1', deliveryID: `delivery-${event}`, event, rawPayload,
      status: 'processing', save: async function save() { return this; }
    };
    const pr = await processDelivery(delivery);
    expect(pr.prNumber).toBe(17);
    expect(pr.repo).toBe('octo/repo');
    expect(delivery.status).toBe('processed');
    expect(streamHub.appendActivity).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-1', type: 'pull_request.updated', pullRequest: expect.objectContaining({ number: 17, title: 'Add a feature' })
    }));
  });
});
