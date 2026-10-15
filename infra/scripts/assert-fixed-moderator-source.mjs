import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Fixed assignments survive rollback. Older readers can silently resume peer
// takeover; schema compatibility alone is insufficient once any assignment exists.
export const FIXED_MODERATOR_SOURCE_CHECKS = [
  [
    'apps/api/src/max/max-execution-route-proof.ts',
    [
      'FIXED_MODERATOR_READER_VERSION = 1',
      'if (state.fixedModeratorBotId && state.fixedModeratorBotId !== botId) return null;',
    ],
  ],
  [
    'apps/api/src/max/max-bot-link.service.ts',
    [
      'fixedModeratorBotId: true',
      '(!chat.fixedModeratorBotId || membership.botId === chat.fixedModeratorBotId)',
      'params.explicitPrimaryBotId !== state.fixedModeratorBotId',
      'hasPersistedBoundMessage(this.prisma,',
      'existingMessage?:',
    ],
  ],
  [
    'apps/api/src/max/max-execution-owner-readiness.service.ts',
    ['state.fixedModeratorBotId', 'executionRouteProof('],
  ],
  [
    'apps/api/src/max/max-client.service.ts',
    [
      'boundObject',
      'existingMessage ? { existingMessage }',
      'message_id',
      'verifyChatExecutionProof(',
      'sourceSendJobId',
    ],
  ],
  [
    'apps/api/src/max/max-bound-message.ts',
    [
      'export async function hasPersistedBoundMessage(',
      "purpose !== 'delete_message'",
      'db.maxActionLedgerEntry.findUnique(',
      'db.managedPoll.findUnique(',
      "intent.routingPolicy === 'origin_only'",
    ],
  ],
];

export function assertFixedModeratorSource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, markers] of FIXED_MODERATOR_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker)))
      throw new Error(`Rollback target lacks fixed moderator readers: ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertFixedModeratorSource(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
