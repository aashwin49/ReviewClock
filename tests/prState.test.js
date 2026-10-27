import { describe, test, expect } from 'vitest';
const { applyEvent, derive } = require('../server/logic/prState');

// Helper to generate mock GitHub webhook payloads with specific timestamps
const makePayload = (action, updated_at, customProps = {}) => ({
  action,
  repository: { full_name: 'owner/repo' },
  pull_request: {
    number: 1,
    state: customProps.state || 'open',
    draft: customProps.draft || false,
    merged: customProps.merged || false,
    title: 'Update tests',
    updated_at: new Date(updated_at).toISOString(),
    user: { login: 'author1' },
    requested_reviewers: customProps.requested_reviewers || [],
  },
  review: customProps.review || null,
});

// Helper to generate all permutations of an array
function getPermutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((v, i) =>
    getPermutations(arr.filter((_, j) => j !== i)).map(p => [v, ...p])
  );
}

describe('PR State Derivation Logic', () => {
  
  test('Permutation Test: Order of events does not change final state', () => {
    // 1. Open PR (T=1000)
    const opened = { type: 'pull_request', payload: makePayload('opened', 1000, { requested_reviewers: [{ login: 'reviewer1' }] }) };
    // 2. Request Review (T=2000)
    const reviewReq = { type: 'pull_request', payload: makePayload('review_requested', 2000) };
    // 3. Review Submitted (Approved) (T=3000)
    const approved = { type: 'pull_request_review', payload: makePayload('submitted', 3000, {
      review: { user: { login: 'reviewer1', type: 'User' }, state: 'approved', submitted_at: new Date(3000).toISOString() }
    })};
    // 4. Closed / Merged (T=4000)
    const closed = { type: 'pull_request', payload: makePayload('closed', 4000, { state: 'closed', merged: true }) };

    const events = [opened, reviewReq, approved, closed];
    const permutations = getPermutations(events);
    const results = new Set();

    permutations.forEach(sequence => {
      const finalFacts = sequence.reduce((facts, { type, payload }) => applyEvent(facts, type, payload), {});
      const finalState = derive(finalFacts);
      results.add(JSON.stringify(finalState));
    });

    // All 24 orderings must produce exactly 1 unique final state (Merged)
    expect(results.size).toBe(1);
    expect(JSON.parse([...results][0])['owner/repo#1'].displayState).toBe('Merged');
  });

  test('Out-of-order: Older events arriving late do not overwrite newer state', () => {
    const closedEvent = makePayload('closed', 5000, { state: 'closed' });
    const lateOpenEvent = makePayload('opened', 1000, { state: 'open' }); // Older timestamp

    // Apply NEWER event first, then OLDER event
    let facts = applyEvent({}, 'pull_request', closedEvent);
    facts = applyEvent(facts, 'pull_request', lateOpenEvent);

    const state = derive(facts);
    // The state should remain 'Closed' because the lateOpenEvent's updated_at is older
    expect(state['owner/repo#1'].displayState).toBe('Closed');
  });

  test('Idempotency: Duplicate events do not duplicate data or crash', () => {
    const opened = makePayload('opened', 1000);
    
    let factsOnce = applyEvent({}, 'pull_request', opened);
    let factsTwice = applyEvent(factsOnce, 'pull_request', opened);

    expect(factsOnce).toEqual(factsTwice);
  });

  test('Review changes: Commented does not override approval, but changes_requested does', () => {
    let facts = {};
    
    // 1. Reviewer approves
    const approve = makePayload('submitted', 1000, {
      review: { user: { login: 'rev1' }, state: 'approved', submitted_at: new Date(1000).toISOString() }
    });
    facts = applyEvent(facts, 'pull_request_review', approve);
    expect(derive(facts)['owner/repo#1'].displayState).toBe('Approved');

    // 2. Reviewer comments later (should NOT clear approval)
    const comment = makePayload('submitted', 2000, {
      review: { user: { login: 'rev1' }, state: 'commented', submitted_at: new Date(2000).toISOString() }
    });
    facts = applyEvent(facts, 'pull_request_review', comment);
    expect(derive(facts)['owner/repo#1'].displayState).toBe('Approved');

    // 3. Reviewer changes mind to changes_requested (SHOULD override approval)
    const changesReq = makePayload('submitted', 3000, {
      review: { user: { login: 'rev1' }, state: 'changes_requested', submitted_at: new Date(3000).toISOString() }
    });
    facts = applyEvent(facts, 'pull_request_review', changesReq);
    expect(derive(facts)['owner/repo#1'].displayState).toBe('Changes requested');
  });

  test('PR Reopening: Transitions from Closed back to Awaiting Review', () => {
    // 1. Closed
    let facts = applyEvent({}, 'pull_request', makePayload('closed', 1000, { state: 'closed' }));
    expect(derive(facts)['owner/repo#1'].displayState).toBe('Closed');

    // 2. Reopened (newer timestamp, state back to open)
    facts = applyEvent(facts, 'pull_request', makePayload('reopened', 2000, { state: 'open' }));
    expect(derive(facts)['owner/repo#1'].displayState).toBe('Awaiting review');
  });
});
