import { Client } from 'pg';

const COMMERCIAL_AUDIT_LOCK_KEY = 'maxim:commercial-audit-filter:v1';
const COMMERCIAL_AUDIT_LOCK_QUERY = `
  select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired
`;

export type CommercialAuditRunLock = {
  assertHeld(): void;
};

export type CommercialAuditRunLockClientFactory = () => Client;

function createCommercialAuditRunLockClient(): Client {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to acquire the commercial audit run lock');
  }

  return new Client({
    connectionString: databaseUrl,
    application_name: `maxim_commercial_audit_${process.pid}`,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });
}

function combineRunAndOwnershipErrors(runError: unknown, ownershipError: unknown): unknown {
  if (runError === undefined) {
    return ownershipError;
  }
  if (ownershipError === undefined || ownershipError === runError) {
    return runError;
  }
  return new AggregateError(
    [runError, ownershipError],
    'Commercial audit failed after its run lock session was lost',
  );
}

export async function withCommercialAuditRunLock<T>(
  action: (lock: CommercialAuditRunLock) => Promise<T>,
  createClient: CommercialAuditRunLockClientFactory = createCommercialAuditRunLockClient,
): Promise<T> {
  const client = createClient();
  let releasing = false;
  let ownershipError: Error | undefined;

  const markLost = (cause: Error): void => {
    if (!releasing && !ownershipError) {
      ownershipError = new Error('Commercial audit run lock session was lost', { cause });
    }
  };
  client.on('error', (error) => markLost(error));
  client.on('end', () => markLost(new Error('PostgreSQL lock session ended unexpectedly')));

  const lock: CommercialAuditRunLock = {
    assertHeld() {
      if (ownershipError) {
        throw ownershipError;
      }
    },
  };

  let result: T | undefined;
  let runError: unknown;
  try {
    await client.connect();
    const acquisition = await client.query<{ acquired: boolean }>(COMMERCIAL_AUDIT_LOCK_QUERY, [
      COMMERCIAL_AUDIT_LOCK_KEY,
    ]);
    const acquired = acquisition.rows[0]?.acquired;
    if (typeof acquired !== 'boolean') {
      throw new Error('PostgreSQL returned an invalid commercial audit run lock result');
    }
    if (!acquired) {
      throw new Error('Another commercial audit is already running');
    }
    lock.assertHeld();
    result = await action(lock);
  } catch (error) {
    runError = error;
  }

  try {
    lock.assertHeld();
  } catch (error) {
    runError = combineRunAndOwnershipErrors(runError, error);
  }

  releasing = true;
  let cleanupError: unknown;
  try {
    // Closing the dedicated PostgreSQL session releases the advisory lock, including after
    // process crashes where the server observes the disconnected client.
    await client.end();
  } catch (error) {
    cleanupError = error;
  }

  if (runError !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [runError, cleanupError],
        'Commercial audit failed and run lock cleanup was incomplete',
      );
    }
    throw runError;
  }
  if (cleanupError !== undefined) {
    throw new AggregateError([cleanupError], 'Commercial audit run lock cleanup failed');
  }
  return result as T;
}
