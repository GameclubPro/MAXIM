import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Independent event and cleanup obligations outlive workers and Redis jobs.
// A rollback must retain their SQL readers even when night-mode notices are disabled.
export const NIGHT_MODE_RECOVERY_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/moderation/night-mode-transition.queue.ts',
    [
      'NIGHT_MODE_INDEPENDENT_RECOVERY_READER_VERSION = 1',
      "'open_notice_event'",
      "'close_notice_cleanup'",
      'parseNightModeTransitionRecoveryObligation',
    ],
  ],
  ['apps/api/prisma/schema.prisma', ['recoveryPayload', '@map("recovery_payload")']],
  [
    'apps/api/src/moderation/night-mode-transition-scheduler.service.ts',
    [
      'recovery_payload',
      'async scheduleRecoveryObligation(',
      'async restoreRecoveryObligations(',
      'parseNightModeTransitionRecoveryObligation',
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-transition-runtime.service.ts',
    [
      'NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY',
      'NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY',
      'processCloseCleanupRecoveryOnly(',
      'hooks.recoverOpenedNoticeEvent(',
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-transition-delivery.service.ts',
    ['inspectCompletedNightModeOpenNoticeDispatch', 'ensureTransitionEvent('],
  ],
  [
    'apps/api/src/max/max-action-ledger.service.ts',
    [
      'async inspectCompletedNightModeOpenNoticeDispatch(',
      "this.inspectCompletedNightModeNoticeDispatch('open', params)",
    ],
  ],
]);

export function assertNightModeRecoverySource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, markers] of NIGHT_MODE_RECOVERY_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker))) {
      throw new Error(`Rollback target lacks independent night-mode recovery readers: ${path}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertNightModeRecoverySource(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
