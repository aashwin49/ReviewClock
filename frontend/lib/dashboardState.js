const PR_STATES = {
  Draft: 'draft',
  'Awaiting review': 'awaiting_review',
  'Changes requested': 'changes_requested',
  Approved: 'approved',
  Merged: 'merged'
};

export function applyActivityToPRs(current, activity) {
  if (!activity?.pullRequest) return current;
  const pr = activity.pullRequest;
  if (pr.state === 'Closed') {
    return current.filter(item => !(item.sourceId === activity.sourceId && item.number === pr.number));
  }

  const incoming = {
    ...pr,
    state: PR_STATES[pr.state] || pr.state,
    author: typeof pr.author === 'string' ? { login: pr.author } : pr.author,
    sourceId: activity.sourceId
  };
  const mapped = incoming.id ? incoming : { ...incoming, id: `${incoming.sourceId}:${incoming.number}` };
  const index = current.findIndex(item => item.id === mapped.id ||
    (item.number === mapped.number && item.sourceId === mapped.sourceId));
  if (index < 0) return [mapped, ...current];

  const next = [...current];
  next[index] = { ...next[index], ...mapped };
  return next;
}
