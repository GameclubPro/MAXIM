import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: A disabled availability flag cannot revoke persisted Lastik ownership.
export const ERASER_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/message-retention/eraser-control.service.ts',
    ['ERASER_OWNERSHIP_VERSION = 1', 'eraser_chat_bindings'],
  ],
  [
    'apps/api/src/message-retention/message-retention-binding.ts',
    ['eraser_chat_bindings', '"eraserOwned"'],
  ],
  [
    'apps/api/src/message-retention/message-retention-delete-guard.service.ts',
    ['binding?.eraserOwned'],
  ],
]);

export function assertEraserSource(
  sha,
  readSource = (path) =>
    execFileSync('git', ['show', `${sha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? ''))
    throw new Error('Lastik rollback requires an exact source SHA.');
  for (const [path, markers] of ERASER_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker))) {
      throw new Error(`Rollback target lacks the installed Lastik ownership reader: ${path}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    assertEraserSource(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
