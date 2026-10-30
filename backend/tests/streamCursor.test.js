import { describe, expect, test } from 'vitest';
const { createStreamCursor } = await import('../../frontend/lib/streamCursor.js');

function tokenFor(userId) {
  const payload = btoa(JSON.stringify({ sub: userId })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `header.${payload}.signature`;
}

function fakeStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values
  };
}

describe('SSE Last-Event-ID cursor persistence', () => {
  test('restores a cursor after page reload and advances monotonically', () => {
    const storage = fakeStorage();
    const firstPage = createStreamCursor(storage, tokenFor('user-1'));
    expect(firstPage.current()).toBe(0);
    expect(firstPage.advance(9)).toBe(9);
    expect(firstPage.advance(7)).toBe(9);
    expect(createStreamCursor(storage, tokenFor('user-1')).current()).toBe(9);
  });

  test('keeps cursors separate per authenticated user', () => {
    const storage = fakeStorage();
    createStreamCursor(storage, tokenFor('user-1')).advance(13);
    expect(createStreamCursor(storage, tokenFor('user-2')).current()).toBe(0);
  });

  test('ignores malformed or negative cursor updates', () => {
    const cursor = createStreamCursor(fakeStorage(), 'invalid-token');
    expect(cursor.advance(-1)).toBe(0);
    expect(cursor.advance(Number.NaN)).toBe(0);
  });
});
