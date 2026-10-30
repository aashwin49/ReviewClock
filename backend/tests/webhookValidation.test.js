import { describe, expect, test } from 'vitest';
const { isSupportedPullRequestEvent, validatePullRequestPayload } = require('../server/logic/webhookValidation');

const pullRequestPayload = {
  action: 'opened',
  repository: { full_name: 'octo/repo' },
  pull_request: { number: 17, title: 'Add a feature', user: { login: 'octo' } }
};

describe('GitHub webhook validation', () => {
  test('accepts supported pull request and review events', () => {
    expect(isSupportedPullRequestEvent('pull_request')).toBe(true);
    expect(validatePullRequestPayload('pull_request', pullRequestPayload)).toBeNull();
    expect(validatePullRequestPayload('pull_request_review', {
      ...pullRequestPayload,
      review: { id: 4, state: 'approved', user: { login: 'reviewer' } }
    })).toBeNull();
  });

  test('rejects irrelevant events before worker processing', () => {
    expect(isSupportedPullRequestEvent('push')).toBe(false);
    expect(validatePullRequestPayload('push', { ref: 'refs/heads/main' })).toMatch(/Unsupported webhook event/);
  });

  test('reports incomplete pull request and review bodies precisely', () => {
    expect(validatePullRequestPayload('pull_request', { action: 'opened' })).toMatch(/repository\.full_name/);
    expect(validatePullRequestPayload('pull_request', {
      ...pullRequestPayload, pull_request: { ...pullRequestPayload.pull_request, number: '17' }
    })).toMatch(/pull_request\.number/);
    expect(validatePullRequestPayload('pull_request_review', pullRequestPayload)).toMatch(/review data/);
  });
});
