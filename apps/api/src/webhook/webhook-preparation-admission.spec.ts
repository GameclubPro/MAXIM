import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookPreparationAdmission } from './webhook-preparation-admission';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Webhook durable preparation admission', () => {
  it('bounds 1,000 pending calls from a slow bot while another bot progresses', async () => {
    const report = jest.fn();
    const admission = new WebhookPreparationAdmission(4, report);
    const a = gate();
    const b = gate();
    const first = admission.run('bot-a', 'ordinary', () => a.promise);
    const extraTask = jest.fn();
    const excess = await Promise.allSettled(
      Array.from({ length: 1000 }, () => admission.run('bot-a', 'ordinary', extraTask)),
    );
    expect(
      excess.every(
        (result) =>
          result.status === 'rejected' && result.reason instanceof WebhookPreparationDeferredError,
      ),
    ).toBe(true);
    expect(extraTask).not.toHaveBeenCalled();
    const other = admission.run('bot-b', 'ordinary', () => b.promise);
    expect(admission.snapshot()).toMatchObject({ inFlight: 2, pending: 0, botScopes: 2 });
    b.release();
    await other;
    await admission.run('bot-b', 'ordinary', async () => undefined);
    expect(admission.snapshot().inFlight).toBe(1);
    a.release();
    await first;
    admission.flush();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        peakInFlight: 2,
        inFlight: 0,
        botScopes: 0,
        deferred: { ordinary: 1000, interactive: 0, lifecycle: 0 },
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain('bot-a');
  });

  it('does not let a slow Start handshake occupy the same bot ordinary-event allowance', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const pending = gate();
    const interactive = admission.run('bot-a', 'interactive', () => pending.promise);
    await admission.run('bot-a', 'ordinary', async () => undefined);
    expect(admission.snapshot()).toMatchObject({ inFlight: 1, ordinary: 0, interactive: 1 });
    pending.release();
    await interactive;
  });

  it('reserves the next slot for a deferred lifecycle event without retaining its payload', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const first = admission.run('bot-a', 'ordinary', () => a.promise);
    const second = admission.run('bot-b', 'ordinary', () => b.promise);
    await expect(admission.run('bot-c', 'lifecycle', async () => undefined)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    b.release();
    await second;
    await expect(admission.run('bot-d', 'ordinary', async () => undefined)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    await admission.run('bot-c', 'lifecycle', async () => undefined);
    a.release();
    await first;
  });

  it('stops admission synchronously and drains only admitted work, including failed tasks', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const pending = gate();
    const first = admission.run('bot-a', 'interactive', () => pending.promise);
    await expect(
      admission.run('bot-b', 'ordinary', async () => {
        throw new Error('DB unavailable');
      }),
    ).rejects.toThrow('DB unavailable');
    admission.stop();
    const task = jest.fn();
    await expect(admission.run('bot-c', 'lifecycle', task)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    let drained = false;
    const draining = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.release();
    await Promise.all([first, draining]);
    expect(task).not.toHaveBeenCalled();
    expect(admission.snapshot()).toMatchObject({ inFlight: 0, pending: 0, botScopes: 0 });
  });

  it.each([NaN, Infinity, 0, -1])(
    'rejects invalid pool budget %s instead of losing the bound',
    (pool) => {
      expect(() => new WebhookPreparationAdmission(pool, jest.fn())).toThrow('pool budget');
    },
  );
});
