function userIdFromToken(token) {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return 'anonymous';
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : 'anonymous';
  } catch {
    return 'anonymous';
  }
}

export function createStreamCursor(storage, token) {
  const key = `reviewclock-last-event-id:${userIdFromToken(token || '')}`;
  const stored = Number(storage.getItem(key));
  let sequence = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  return {
    key,
    current: () => sequence,
    advance(nextSequence) {
      if (Number.isSafeInteger(nextSequence) && nextSequence >= 0) {
        sequence = Math.max(sequence, nextSequence);
        storage.setItem(key, String(sequence));
      }
      return sequence;
    }
  };
}
