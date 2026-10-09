import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertInheritedDeployLock } from './legacy-cold-journal.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireFact = (value, code) => {
  if (!value) throw new Error(code);
};
const namePattern =
  /^maxim-source-session:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// FLAG: Persist a newly connected Redis client before any queue mutation. On
// continuation, the queue adapter must prove this exact previous client absent;
// a lost acknowledgement never permits an automatic resend or CLIENT KILL.
export function createSessionConnectionLedger({
  directory,
  connectionName,
  assertLock = assertInheritedDeployLock,
  checkpoint = () => {},
}) {
  requireFact(namePattern.test(connectionName), 'session_redis_name_refused');
  const target = join(directory, 'queue-connection.json');
  const guard = () => {
    assertLock();
    const stat = lstatSync(directory);
    requireFact(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o700,
      'session_redis_directory_refused',
    );
  };
  const identity = (value) => {
    requireFact(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Reflect.ownKeys(value).length === 2 &&
        Reflect.ownKeys(value).every(
          (key) =>
            ['clientId', 'connectionName'].includes(key) &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'),
        ) &&
        Number.isSafeInteger(value.clientId) &&
        value.clientId > 0 &&
        value.connectionName === connectionName,
      'session_redis_identity_refused',
    );
    return { clientId: value.clientId, connectionName: value.connectionName };
  };
  const syncDirectory = () => {
    const fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const read = () => {
    guard();
    let fd;
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      requireFact(
        stat.isFile() &&
          stat.nlink === 1 &&
          stat.uid === process.getuid() &&
          (stat.mode & 0o777) === 0o600 &&
          stat.size <= 512,
        'session_redis_file_refused',
      );
      const bytes = readFileSync(fd);
      requireFact(bytes.length === stat.size, 'session_redis_file_changed');
      return identity(JSON.parse(bytes));
    } finally {
      closeSync(fd);
    }
  };
  return {
    read,
    compareAndSet(expectedDigest, value) {
      requireFact(
        expectedDigest === null || /^[a-f0-9]{64}$/u.test(expectedDigest),
        'session_redis_digest_refused',
      );
      const next = identity(value),
        previous = read();
      requireFact(
        (previous === null ? null : digest(previous)) === expectedDigest,
        'session_redis_connection_changed',
      );
      const temporary = join(directory, `queue-connection-${randomUUID()}.tmp`);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, `${JSON.stringify(next)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory();
      checkpoint('before_commit');
      guard();
      const current = read();
      requireFact(
        (current === null ? null : digest(current)) === expectedDigest,
        'session_redis_connection_changed',
      );
      renameSync(temporary, target);
      syncDirectory();
      checkpoint('after_commit');
      requireFact(digest(read()) === digest(next), 'session_redis_readback_refused');
      return next;
    },
  };
}
