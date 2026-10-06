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
  it('distinguishes shared saturation from a poisoned bot behind a lifecycle reservation', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const first = admission.run('a', 'ordinary', () => a.promise);
    const second = admission.run('b', 'ordinary', () => b.promise);
    try {
      expect(admission.schedulingState('a', 'ordinary')).toBe('shared_capacity');
      expect(admission.schedulingState('c', 'lifecycle')).toBe('shared_capacity');
      b.release();
      await second;
      expect(admission.schedulingState('a', 'ordinary')).toBe('scope_capacity');
      expect(admission.schedulingState('b', 'ordinary')).toBe('shared_capacity');
      expect(admission.schedulingState('c', 'lifecycle')).toBe('available');
      admission.stop();
      expect(admission.schedulingState('b', 'ordinary')).toBe('closed');
    } finally {
      a.release();
      b.release();
      await Promise.all([first, second]);
    }
  });

  it('preserves lifecycle reservation and shutdown when the outbox checks scheduling availability', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const first = admission.run('a', 'ordinary', () => a.promise);
    const second = admission.run('b', 'ordinary', () => b.promise);
    try {
      expect(admission.canRun('c', 'lifecycle')).toBe(false);
      const completion = admission.nextCompletion();
      b.release();
      await completion;
      expect(admission.canRun('b', 'ordinary')).toBe(false);
      expect(admission.canRun('c', 'lifecycle')).toBe(true);
      await admission.run('c', 'lifecycle', async () => undefined);
      expect(admission.canRun('b', 'ordinary')).toBe(true);
      admission.stop();
      expect(admission.canRun('b', 'ordinary')).toBe(false);
      expect(admission.canRun('c', 'lifecycle')).toBe(false);
    } finally {
      a.release();
      b.release();
      await Promise.all([first, second]);
    }
    expect(admission.nextCompletion()).toBeNull();
  });

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

  it.each([false, true])(
    'does not reserve another slot for lifecycle work blocked by its own bot quota (initially full=%s)',
    async (initiallyFull) => {
      const admission = new WebhookPreparationAdmission(4, jest.fn());
      const lifecycleGate = gate();
      const ordinaryGate = gate();
      const lifecycle = admission.run('bot-a', 'lifecycle', () => lifecycleGate.promise);
      const ordinary = initiallyFull
        ? admission.run('bot-b', 'ordinary', () => ordinaryGate.promise)
        : Promise.resolve();
      try {
        await expect(
          admission.run('bot-a', 'lifecycle', async () => undefined),
        ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
        ordinaryGate.release();
        await ordinary;
        // The rejected bot already holds its lifecycle allowance. It cannot use the
        // other slot, which must remain available to independent ordinary work.
        await expect(admission.run('bot-b', 'ordinary', async () => 'progress')).resolves.toBe(
          'progress',
        );
        expect(admission.snapshot()).toMatchObject({ inFlight: 1, lifecycle: 1, pending: 0 });
      } finally {
        lifecycleGate.release();
        ordinaryGate.release();
        await Promise.all([lifecycle, ordinary]);
      }
    },
  );

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

  it.each([false, true])(
    'releases a consumed lifecycle reservation after its task settles (failed=%s)',
    async (fails) => {
      const admission = new WebhookPreparationAdmission(4, jest.fn());
      const a = gate();
      const b = gate();
      const first = admission.run('bot-a', 'ordinary', () => a.promise);
      const second = admission.run('bot-b', 'ordinary', () => b.promise);
      try {
        await expect(
          admission.run('bot-c', 'lifecycle', async () => undefined),
        ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
        b.release();
        await second;
        const lifecycle = admission.run('bot-c', 'lifecycle', async () => {
          if (fails) throw new Error('Required follow-up failed');
        });
        if (fails) await expect(lifecycle).rejects.toThrow('Required follow-up failed');
        else await lifecycle;
        await expect(admission.run('bot-b', 'ordinary', async () => 'progress')).resolves.toBe(
          'progress',
        );
        expect(admission.snapshot()).toMatchObject({ inFlight: 1, pending: 0 });
      } finally {
        a.release();
        b.release();
        await Promise.all([first, second]);
      }
    },
  );

  it('preserves a later lifecycle reservation when an earlier admitted task finishes', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const lifecycleGate = gate();
    const first = admission.run('bot-a', 'ordinary', () => a.promise);
    const second = admission.run('bot-b', 'ordinary', () => b.promise);
    let lifecycle: Promise<void> | undefined;
    try {
      await expect(
        admission.run('bot-c', 'lifecycle', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      b.release();
      await second;
      lifecycle = admission.run('bot-c', 'lifecycle', () => lifecycleGate.promise);
      await expect(
        admission.run('bot-d', 'lifecycle', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      lifecycleGate.release();
      await lifecycle;
      await expect(
        admission.run('bot-b', 'ordinary', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      await admission.run('bot-d', 'lifecycle', async () => undefined);
      await expect(admission.run('bot-b', 'ordinary', async () => 'progress')).resolves.toBe(
        'progress',
      );
    } finally {
      a.release();
      b.release();
      lifecycleGate.release();
      await Promise.all([first, second, lifecycle]);
    }
  });

  it.each([NaN, Infinity, 0, -1])(
    'rejects invalid pool budget %s instead of losing the bound',
    (pool) => {
      expect(() => new WebhookPreparationAdmission(pool, jest.fn())).toThrow('pool budget');
    },
  );
});
