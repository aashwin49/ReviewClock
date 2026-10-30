import { describe, expect, test } from 'vitest';
const { applyActivityToPRs } = await import('../../frontend/lib/dashboardState.js');

describe('React dashboard activity updates', () => {
  test('replayed activity inserts a PR without a reload and replaying it is idempotent', () => {
    const activity = {
      sequence: 17,
      sourceId: 'source-1',
      type: 'pull_request.updated',
      pullRequest: { id: 'pr-1', number: 42, title: 'Catch me up', author: 'octo', state: 'Awaiting review' }
    };

    const firstUpdate = applyActivityToPRs([], activity);
    const duplicateReplay = applyActivityToPRs(firstUpdate, activity);
    expect(firstUpdate).toHaveLength(1);
    expect(firstUpdate[0]).toMatchObject({
      id: 'pr-1', sourceId: 'source-1', number: 42,
      state: 'awaiting_review', author: { login: 'octo' }
    });
    expect(duplicateReplay).toHaveLength(1);
  });

  test('replayed close activity removes the matching PR only', () => {
    const current = [
      { id: 'pr-1', sourceId: 'source-1', number: 42 },
      { id: 'pr-2', sourceId: 'source-2', number: 42 }
    ];
    expect(applyActivityToPRs(current, {
      sourceId: 'source-1', pullRequest: { number: 42, state: 'Closed' }
    })).toEqual([current[1]]);
  });
});
