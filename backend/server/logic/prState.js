// Pure functions for deriving Pull Request state from webhook events.

// Record each event's facts without depending on arrival order.
function applyEvent(facts, type, payload) {
  const nextFacts = { ...facts };

  const repo = payload.repository?.full_name;
  const pr = payload.pull_request;

  if (!repo || !pr?.number) {
    return nextFacts;
  }

  const key = `${repo}#${pr.number}`;

  if (!nextFacts[key]) {
    nextFacts[key] = {
      repo,
      prNumber: pr.number,
      title: pr.title,
      author: pr.user?.login,
      lifecycleEvents: [],
      reviews: []
    };
  }

  //Create a new record, copy its arrays, and then modify the copies.
  const record = {
    ...nextFacts[key],
    lifecycleEvents: [...nextFacts[key].lifecycleEvents],
    reviews: [...nextFacts[key].reviews]
  };

  if (type === 'pull_request') {
    const action = payload.action;

    if (action) {
      const lifecycleEvent = {
        action,
        state: pr.state,
        merged: pr.merged === true,
        timestamp: payload.updated_at || pr.updated_at || null
      };
      if (!record.lifecycleEvents.some(event => event.action === lifecycleEvent.action && event.timestamp === lifecycleEvent.timestamp)) {
        record.lifecycleEvents.push(lifecycleEvent);
      }
    }
  }

  if (type === 'pull_request_review') {
    const review = payload.review;

    if (review) {
      const reviewEvent = {
        state: review.state,
        submittedAt: review.submitted_at || null,
        id: review.id ?? null
      };
      if (!record.reviews.some(event =>
        (reviewEvent.id != null && event.id === reviewEvent.id) ||
        (reviewEvent.id == null && event.id == null && event.state === reviewEvent.state && event.submittedAt === reviewEvent.submittedAt)
      )) record.reviews.push(reviewEvent);
    }
  }

  nextFacts[key] = record;

  return nextFacts;
}

// Select the latest event using its timestamp, not its arrival order.
function latestByTimestamp(events, timestampField) {
  return [...events].sort((a, b) => {
    const timeA = a[timestampField]
      ? new Date(a[timestampField]).getTime()
      : 0;

    const timeB = b[timestampField]
      ? new Date(b[timestampField]).getTime()
      : 0;

    if (timeA !== timeB) {
      return timeA - timeB;
    }

    // Stable tie-breaker when timestamps are identical.
    return String(a.id ?? a.action ?? '').localeCompare(
      String(b.id ?? b.action ?? '')
    );
  });
}

function derive(facts) {
  const result = {};

  for (const [key, record] of Object.entries(facts)) {
    const lifecycleEvents = latestByTimestamp(
      record.lifecycleEvents,
      'timestamp'
    );

    const latestLifecycle = lifecycleEvents.at(-1);  //It returns the last element of an array.

    let state = 'open';

    if (latestLifecycle) {
      if (
        latestLifecycle.action === 'closed' &&
        latestLifecycle.merged
      ) {
        state = 'merged';
      } else if (latestLifecycle.action === 'closed') {
        state = 'closed';
      } else if (
        latestLifecycle.action === 'opened' ||
        latestLifecycle.action === 'reopened'
      ) {
        state = 'open';
      } else {
        state = latestLifecycle.state || 'open';
      }
    }

    const reviews = latestByTimestamp(
      record.reviews.filter(review => ['approved', 'changes_requested'].includes(review.state)),
      'submittedAt'
    );

    const latestReview = reviews.at(-1);

    const reviewStatus = latestReview?.state || 'pending';

    let displayState;

    if (state === 'merged') {
      displayState = 'Merged';
    } else if (state === 'closed') {
      displayState = 'Closed';
    } else if (reviewStatus === 'approved') {
      displayState = 'Approved';
    } else if (reviewStatus === 'changes_requested') {
      displayState = 'Changes requested';
    } else {
      displayState = 'Awaiting review';
    }

    result[key] = {
      repo: record.repo,
      prNumber: record.prNumber,
      title: record.title,
      author: record.author,
      state,
      reviewStatus,
      displayState
    };
  }

  return result;
}

module.exports = { applyEvent, derive };
