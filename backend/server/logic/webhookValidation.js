const SUPPORTED_EVENTS = new Set(['pull_request', 'pull_request_review']);

function isSupportedPullRequestEvent(event) {
  return SUPPORTED_EVENTS.has(event);
}

function validatePullRequestPayload(event, payload) {
  if (!isSupportedPullRequestEvent(event)) return `Unsupported webhook event: ${event || 'unknown'}`;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Webhook body must be a JSON object';
  if (typeof payload.action !== 'string' || !payload.action) return `${event} payload is missing action`;
  if (typeof payload.repository?.full_name !== 'string' || !/^[^/]+\/[^/]+$/.test(payload.repository.full_name)) {
    return `${event} payload is missing a valid repository.full_name`;
  }
  const pr = payload.pull_request;
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1) return `${event} payload is missing a valid pull_request.number`;
  if (typeof pr.title !== 'string' || !pr.title.trim()) return `${event} payload is missing pull_request.title`;
  if (typeof pr.user?.login !== 'string' || !pr.user.login) return `${event} payload is missing pull_request.user.login`;
  if (event === 'pull_request_review') {
    if (!payload.review || typeof payload.review !== 'object' || Array.isArray(payload.review)) return 'pull_request_review payload is missing review data';
    if (typeof payload.review.state !== 'string' || !payload.review.state) return 'pull_request_review payload is missing review.state';
    if (typeof payload.review.user?.login !== 'string' || !payload.review.user.login) return 'pull_request_review payload is missing review.user.login';
  }
  return null;
}

module.exports = { SUPPORTED_EVENTS, isSupportedPullRequestEvent, validatePullRequestPayload };
