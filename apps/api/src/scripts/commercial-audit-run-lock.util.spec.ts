import { EventEmitter } from 'node:events';
import type { Client } from 'pg';

import { withCommercialAuditRunLock } from './commercial-audit-run-lock.util';

function createMockClient(acquired: boolean | 'invalid' = true) {
  const events = new EventEmitter();
  const connect = jest.fn(async () => undefined);
  const query = jest.fn(async () => ({
    rows: acquired === 'invalid' ? [{}] : [{ acquired }],
  }));
  const end = jest.fn(async () => {
    events.emit('end');
  });
  const client = Object.assign(events, { connect, query, end }) as unknown as Client;

  return { client, connect, query, end, events };
}

describe('commercial audit run lock', () => {
  it('acquires a nonblocking advisory lock and closes its dedicated session afterward', async () => {
    const mock = createMockClient();
    const action = jest.fn(async (lock: { assertHeld(): void }) => {
      expect(() => lock.assertHeld()).not.toThrow();
      return 'complete';
    });

    await expect(withCommercialAuditRunLock(action, () => mock.client)).resolves.toBe('complete');

    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'), [
      'maxim:commercial-audit-filter:v1',
    ]);
    expect(action).toHaveBeenCalledTimes(1);
    expect(mock.end).toHaveBeenCalledTimes(1);
  });

  it('fails fast on contention without running the audit', async () => {
    const mock = createMockClient(false);
    const action = jest.fn(async () => 'unexpected');

    await expect(withCommercialAuditRunLock(action, () => mock.client)).rejects.toThrow(
      'Another commercial audit is already running',
    );

    expect(action).not.toHaveBeenCalled();
    expect(mock.end).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'end'] as const)(
    'marks the lock lost when its PostgreSQL session emits %s',
    async (event) => {
      const mock = createMockClient();
      const connectionError = new Error('lock connection failed');

      await expect(
        withCommercialAuditRunLock(
          async (lock) => {
            if (event === 'error') {
              mock.events.emit('error', connectionError);
            } else {
              mock.events.emit('end');
            }
            lock.assertHeld();
          },
          () => mock.client,
        ),
      ).rejects.toThrow('Commercial audit run lock session was lost');

      expect(mock.end).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves both the audit and lock-session-loss errors', async () => {
    const mock = createMockClient();
    const auditError = new Error('audit failed');

    const result = withCommercialAuditRunLock(
      async () => {
        mock.events.emit('error', new Error('socket lost'));
        throw auditError;
      },
      () => mock.client,
    );

    await expect(result).rejects.toMatchObject({
      message: 'Commercial audit failed after its run lock session was lost',
      errors: expect.arrayContaining([auditError]),
    });
    expect(mock.end).toHaveBeenCalledTimes(1);
  });

  it('aggregates an audit failure with lock cleanup failure', async () => {
    const mock = createMockClient();
    const auditError = new Error('audit failed');
    const cleanupError = new Error('lock cleanup failed');
    mock.end.mockRejectedValueOnce(cleanupError);

    const result = withCommercialAuditRunLock(
      async () => {
        throw auditError;
      },
      () => mock.client,
    );

    await expect(result).rejects.toMatchObject({
      message: 'Commercial audit failed and run lock cleanup was incomplete',
      errors: [auditError, cleanupError],
    });
  });

  it('rejects an invalid advisory-lock result without running the audit', async () => {
    const mock = createMockClient('invalid');
    const action = jest.fn(async () => 'unexpected');

    await expect(withCommercialAuditRunLock(action, () => mock.client)).rejects.toThrow(
      'PostgreSQL returned an invalid commercial audit run lock result',
    );
    expect(action).not.toHaveBeenCalled();
    expect(mock.end).toHaveBeenCalledTimes(1);
  });
});
