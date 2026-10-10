import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const filename = 'backlog-cancellation.json';
export function readBacklogCancellation(directory) {
  let fd;
  try {
    fd = openSync(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 64 * 1024
    )
      throw new Error('Unsafe backlog cancellation journal');
    const state = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      state.version !== 1 ||
      !state.request?.id ||
      !['PREPARED', 'STOPPED', 'APPLIED', 'COMPLETE'].includes(state.phase)
    )
      throw new Error('Invalid backlog cancellation journal');
    return state;
  } finally {
    closeSync(fd);
  }
}
export function assertNoActiveBacklogCancellation(directory, ownId = null) {
  const state = readBacklogCancellation(directory);
  if (state && state.phase !== 'COMPLETE' && state.request.id !== ownId)
    throw new Error('Active backlog cancellation blocks ordinary mutation');
}

// FLAG: A new operation may follow only COMPLETE. Preserve its exact journal before
// the host captures a fresh generation; interrupted requests keep their original cutoff.
export function readBacklogCancellationForRequest(directory, request) {
  const previous = readBacklogCancellation(directory);
  if (!previous || JSON.stringify(previous.request) === JSON.stringify(request)) return previous;
  if (previous.phase !== 'COMPLETE' || previous.request.id === request.id)
    throw new Error('Use the existing immutable cancellation request');
  const raw = readFileSync(join(directory, filename));
  const digest = createHash('sha256').update(raw).digest('hex');
  const archive = join(directory, `backlog-cancellation.complete-${digest}.json`);
  let fd;
  try {
    fd = openSync(
      archive,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(existing);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size !== raw.length ||
        !readFileSync(existing).equals(raw)
      )
        throw new Error('Completed cancellation archive mismatch');
    } finally {
      closeSync(existing);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  // Keep the completed root journal until the host durably writes a new PREPARED state.
  return null;
}
export function writeBacklogCancellation(directory, state) {
  const temporary = join(directory, `${filename}.${process.pid}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(directory, filename));
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
