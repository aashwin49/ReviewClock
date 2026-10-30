const API_BASE = (window.REVIEWCLOCK_API_BASE || import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
const WEBHOOK_BASE = (window.REVIEWCLOCK_WEBHOOK_BASE || import.meta.env.VITE_WEBHOOK_BASE_URL || import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_PROXY_TARGET || '').trim().replace(/\/$/, '');
const MOCK = window.REVIEWCLOCK_MOCK === true || new URLSearchParams(location.search).get('mock') === '1';
const token = () => window.REVIEWCLOCK_TOKEN || sessionStorage.getItem('reviewclockToken') || '';

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options, signal: controller.signal,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...options.headers }
    });
    const contentType = response.headers.get('content-type') || '';
    const body = response.status === 204 ? null : contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : null;
    if (!response.ok) {
      const detail = body?.error || body?.message;
      const message = detail || (response.status === 404
        ? `API route not found: ${options.method || 'GET'} ${path}. Check that the Cloudflare Tunnel points to the backend service.`
        : `Request to ${path} failed (${response.status})`);
      throw new ApiError(message, response.status);
    }
    return body;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.name === 'AbortError') throw new ApiError('The request timed out. Please try again.');
    if (error instanceof ApiError) throw error;
    throw new ApiError('Could not reach ReviewClock. Check your connection and try again.');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abortFromCaller); }
}
const unwrap = value => value?.data ?? value;
const mapSource = raw => ({ id: raw.id || raw._id, repo: raw.repo || raw.repoFullName, webhookUrl: raw.webhookUrl, secret: raw.secret, status: raw.status || 'waiting', stalledThresholdMinutes: raw.stalledThresholdMinutes || 1440 });
function publicWebhookUrl(value) {
  if (!value || !WEBHOOK_BASE) return value;
  try {
    const url = new URL(value);
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
      const base = new URL(WEBHOOK_BASE);
      url.protocol = base.protocol;
      url.host = base.host;
      return url.toString();
    }
  } catch {}
  return value;
}
const PR_STATES = { Draft: 'draft', 'Awaiting review': 'awaiting_review', 'Changes requested': 'changes_requested', Approved: 'approved', Merged: 'merged' };
const mapPR = raw => ({ id: String(raw.id || raw._id || ''), sourceId: raw.sourceId, number: raw.number ?? raw.prNumber, title: raw.title || 'Untitled pull request', summary: raw.summary || raw.facts?.summary || '', author: typeof raw.author === 'string' ? { login: raw.author } : raw.author || { login: 'Unknown' }, state: PR_STATES[raw.displayState || raw.derived?.state] || raw.state || 'awaiting_review', waitingOn: raw.derived?.waitingOn || raw.waitingOn, waitingSince: raw.derived?.waitingSince || raw.waitingSince || raw.updatedAt, stalled: Boolean(raw.derived?.stalled ?? raw.stalled), readyAt: raw.readyAt, firstReviewAt: raw.firstReviewAt });
const mapDelivery = raw => ({ id: String(raw.id || raw._id), deliveryId: raw.deliveryId || raw.deliveryID, event: raw.event, status: raw.status === 'duplicate' ? 'duplicate' : raw.status, receivedAt: raw.receivedAt, signatureVerified: raw.signatureVerified ?? null });
async function getPages(path, signal) {
  const results = [];
  let page = 1;
  let pageCount = 1;
  do {
    const response = await request(`${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=100`, { signal });
    results.push(...(unwrap(response) || []));
    pageCount = response.pagination?.pages || 1;
    page += 1;
  } while (page <= pageCount);
  return results;
}
const now = Date.now();
/** @type {import('../types/dashboard').PullRequest[]} */
export const mockPRs = [
  { number: 151, title: 'Add rate limiting to webhook endpoint', summary: 'Throttle bursts per installation before events reach the inbox.', author: { login: 'rohanm' }, state: 'draft', waitingSince: new Date(now - 2 * 3600000).toISOString(), stalled: false },
  { number: 149, title: 'Refactor SSE reconnect logic', summary: 'Backoff with jitter and cleaner Last-Event-ID resume.', author: { login: 'aashwin49' }, state: 'draft', waitingSince: new Date(now - 3 * 3600000).toISOString(), stalled: false },
  { number: 145, title: 'Add delivery-ID unique index', author: { login: 'benm' }, state: 'awaiting_review', waitingOn: 'aashwin49', waitingSince: new Date(now - 9 * 3600000).toISOString(), stalled: false },
  { number: 138, title: 'Fix out-of-order review events', author: { login: 'aashwin49' }, state: 'changes_requested', waitingSince: new Date(now - 31 * 3600000).toISOString(), stalled: true },
  { number: 124, title: 'Handle review dismissed events', author: { login: 'meera-k' }, state: 'changes_requested', waitingSince: new Date(now - 5 * 3600000).toISOString(), stalled: false },
  { number: 131, title: 'CI run tests on push', author: { login: 'GitHub Actions' }, state: 'approved', waitingSince: new Date(now - 1 * 3600000).toISOString(), stalled: false },
  { number: 128, title: 'Inbox consumer backoff', author: { login: 'Rohan M.' }, state: 'merged', waitingSince: new Date(now - 1 * 3600000).toISOString(), stalled: false }
];
/** @type {import('../types/dashboard').Delivery[]} */
export const mockDeliveries = Array.from({ length: 8 }, (_, i) => ({ id: `mock-row-${i}`, deliveryId: `8f3c2a1e-b94d-4c11-a0d3-${String(i).padStart(12, '0')}`, event: ['pull_request.opened', 'pull_request.synchronize', 'pull_request.ready_for_review', 'pull_request_review.submitted'][i % 4], status: ['processed', 'duplicate', 'failed', 'processed'][i % 4], receivedAt: new Date(now - i * 4200000).toISOString(), signatureVerified: true }));

export const api = {
  async authenticate(mode, email, password) {
    const result = await request(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!result?.token) throw new ApiError('Authentication response did not include a token.');
    sessionStorage.setItem('reviewclockToken', result.token);
    return result.user;
  },
  async sources(signal) {
    if (MOCK) return [{ id: 'mock-source', repo: 'aashwin49/ReviewClock', status: 'connected' }];
    return (unwrap(await request('/api/sources', { signal })) || []).map(mapSource);
  },
  async connect(repo) {
    if (MOCK) return { ...mapSource({ id: 'mock-source', repo, status: 'waiting', webhookUrl: `${location.origin}/hooks/github/mock-endpoint`, secret: 'mock_secret_once' }) };
    const result = await request('/api/sources', { method: 'POST', body: JSON.stringify({ repoFullName: repo }) });
    return mapSource({ ...unwrap(result), webhookUrl: publicWebhookUrl(result.connect?.payloadUrl), secret: result.connect?.secret });
  },
  async source(id, signal) { if (MOCK) return { id, repo: 'aashwin49/ReviewClock', status: 'waiting' }; return mapSource(await request(`/api/sources/${encodeURIComponent(id)}`, { signal }).then(unwrap)); },
  async updateSource(id, stalledThresholdMinutes) { return mapSource(unwrap(await request(`/api/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ stalledThresholdMinutes }) }))); },
  async prs(signal) { if (MOCK) return mockPRs; return (await getPages('/api/prs', signal)).filter(raw => (raw.displayState || raw.derived?.state) !== 'Closed').map(mapPR); },
  async pr(number, signal, knownPR) {
    if (MOCK) return mockPRs.find(pr => pr.number === Number(number)) ? { pr: mockPRs.find(pr => pr.number === Number(number)), verdicts: [], events: [] } : null;
    const pr = knownPR || (await this.prs(signal)).find(item => item.number === Number(number));
    if (!pr) return null;
    if (!pr.id) return { pr, verdicts: [], events: [] };
    const raw = unwrap(await request(`/api/prs/${encodeURIComponent(pr.id)}`, { signal }));
    return { pr: mapPR(raw.pullRequest || raw.pr || pr), verdicts: (raw.reviewerVerdicts || raw.verdicts || []).map(v => ({ reviewer: v.reviewer, state: String(v.verdict || v.state || '').toLowerCase(), submittedAt: v.submittedAt })), events: (raw.timeline || raw.events || []).map(e => ({ id: e.id || e.deliveryId || `${e.event}-${e.at}`, type: mapEvent(e), actor: e.actor, occurredAt: e.at || e.occurredAt, detail: e.summary || e.detail })) };
  },
  async deliveries(signal) {
    if (MOCK) return mockDeliveries;
    const sources = unwrap(await request('/api/sources', { signal })) || [];
    const rows = await Promise.all(sources.map(s => getPages(`/api/sources/${encodeURIComponent(s.id || s._id)}/deliveries`, signal)));
    return rows.flat().map(mapDelivery);
  },
  async reprocess(id) {
    if (MOCK) throw new ApiError('Retry is unavailable in fixture mode.', 404);
    return unwrap(await request(`/api/deliveries/${encodeURIComponent(id)}/reprocess`, { method: 'POST' }));
  },
  async streamTicket() {
    return request('/api/stream-ticket', { method: 'POST', body: '{}' });
  },
  streamUrl(ticket, lastEventId = 0) { return `${API_BASE}/api/stream?ticket=${encodeURIComponent(ticket)}&lastEventId=${encodeURIComponent(lastEventId)}`; }
};
function mapEvent(e) {
  if (e.event === 'pull_request_review') {
    if (e.action === 'dismissed') return 'review_dismissed';
    const summary = String(e.summary || '').toLowerCase();
    if (summary.includes('approved')) return 'approved';
    if (summary.includes('changes_requested') || summary.includes('changes requested')) return 'changes_requested';
    return 'review_submitted';
  }
  return ({ opened: 'opened', ready_for_review: 'ready_for_review', review_requested: 'review_requested', synchronize: 'synchronize', closed: 'closed' })[e.action] || 'opened';
}
