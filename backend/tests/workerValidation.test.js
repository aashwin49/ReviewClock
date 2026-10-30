import { describe, expect, test } from 'vitest';
const { processDelivery } = require('../server/worker');

describe('delivery worker payload handling', () => {
  test('marks non-PR inbox deliveries ignored rather than failed', async () => {
    const delivery = {
      event: 'push', rawPayload: { ref: 'refs/heads/main' }, status: 'processing',
      save: async function save() { return this; }
    };
    await expect(processDelivery(delivery)).resolves.toBeNull();
    expect(delivery.status).toBe('ignored');
    expect(delivery.error).toMatch(/Unsupported webhook event/);
    expect(delivery.processingAt).toBeNull();
  });

  test('marks malformed supported deliveries failed with a useful validation message', async () => {
    const delivery = {
      event: 'pull_request', rawPayload: { action: 'opened' }, status: 'processing',
      save: async function save() { return this; }
    };
    await expect(processDelivery(delivery)).rejects.toThrow(/repository\.full_name/);
    expect(delivery.status).toBe('failed');
    expect(delivery.processingAt).toBeNull();
  });
});
