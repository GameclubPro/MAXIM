import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function readReviewedPreservationPlan(path, sha, digest) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? '') || !/^[a-f0-9]{64}$/u.test(digest ?? ''))
    throw new Error('Exact source and reviewed digest required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 256 * 1024
    )
      throw new Error('Private bounded preservation plan required');
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Preservation plan too large');
    const plan = JSON.parse(raw);
    if (
      plan.protocol !== 'PRESERVE_EXISTING_MODERATOR_V1' ||
      plan.sourceSha !== sha ||
      !Array.isArray(plan.entries) ||
      plan.entries.length > 100 ||
      createHash('sha256').update(JSON.stringify(plan)).digest('hex') !== digest
    )
      throw new Error('Preservation plan identity differs');
    return JSON.stringify(plan);
  } finally {
    closeSync(fd);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(readReviewedPreservationPlan(...process.argv.slice(2)) + '\n');
  } catch {
    console.error('Private reviewed preservation plan refused');
    process.exitCode = 1;
  }
}
