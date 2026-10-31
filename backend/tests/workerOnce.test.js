import { afterEach, describe, expect, test, vi } from 'vitest';

const { runWorkerOnce } = require('../server/worker');

describe('one-shot worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test('connects, drains every claimed delivery, sweeps, and disconnects', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://worker-once-test/reviewclock');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const order = [];
    const deliveries = [{ deliveryID: 'pending' }, { deliveryID: 'expired-lease' }, null];

    const result = await runWorkerOnce({
      connect: async uri => order.push(`connect:${uri}`),
      disconnect: async () => order.push('disconnect'),
      claim: async () => {
        order.push('claim');
        return deliveries.shift();
      },
      processDeliveryFn: async delivery => {
        order.push(`process:${delivery.deliveryID}`);
        return null;
      },
      sweep: async () => { order.push('sweep'); return 3; }
    });

    expect(result).toEqual({ claimedCount: 2, failedCount: 0, sweptCount: 3 });
    expect(order).toEqual([
      'connect:mongodb://worker-once-test/reviewclock',
      'claim', 'process:pending',
      'claim', 'process:expired-lease',
      'claim', 'sweep', 'disconnect'
    ]);
  });

  test('continues draining and sweeps after a delivery error, then rejects', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://worker-once-test/reviewclock');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const order = [];
    const deliveries = [{ deliveryID: 'bad' }, { deliveryID: 'good' }, null];

    await expect(runWorkerOnce({
      connect: async () => order.push('connect'),
      disconnect: async () => order.push('disconnect'),
      claim: async () => deliveries.shift(),
      processDeliveryFn: async delivery => {
        order.push(`process:${delivery.deliveryID}`);
        if (delivery.deliveryID === 'bad') throw new Error('processing failed');
      },
      sweep: async () => { order.push('sweep'); return 0; }
    })).rejects.toThrow('One-shot worker failed to process 1 delivery(s)');

    expect(order).toEqual(['connect', 'process:bad', 'process:good', 'sweep', 'disconnect']);
  });

  test('disconnects and rejects when connecting fails', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://worker-once-test/reviewclock');
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const claim = vi.fn();
    const sweep = vi.fn();

    await expect(runWorkerOnce({
      connect: vi.fn().mockRejectedValue(new Error('connection failed')),
      disconnect,
      claim,
      sweep
    })).rejects.toThrow('connection failed');

    expect(disconnect).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });
});
