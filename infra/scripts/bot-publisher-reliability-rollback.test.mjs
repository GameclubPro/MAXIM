import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const protectedSources = [
  ['apps/api/src/max/max-action-ledger.service.ts', 'pg_advisory_xact_lock'],
  [
    'apps/api/src/moderation/moderation-delete-intent.service.ts',
    'closedChatDeleteGuard!.authorize',
  ],
  [
    'apps/api/src/moderation/moderation.service.legacy.ts',
    'moderationRuleSanctionGuard!.assertAllowed',
  ],
  ['apps/api/src/moderation/moderation-execution-guard-callbacks.ts', 'botId: readSelectedBotId()'],
  [
    'apps/api/src/moderation/moderation-rule-sanction-authority.ts',
    'metadata.moderationDeleteVerified !== true',
  ],
  [
    'apps/api/src/moderation/moderation-rule-sanction-authority.ts',
    'await dependencies.assertFinalOwnership?.()',
  ],
  [
    'apps/api/src/max/max-moderation-rule-notice.guard.ts',
    'assertModerationRuleSanctionAuthority(this.prisma, proof',
  ],
  ['apps/api/src/max/max-client.service.ts', 'this.moderationRuleNoticeGuard.assertAllowed('],
  ['apps/api/src/max/max.module.ts', '  MaxModerationRuleNoticeGuardService,'],
  [
    'apps/api/src/max/max-required-subscription-notice.guard.ts',
    'assertRequiredSubscriptionNoticeAuthority(this.prisma, proof',
  ],
  [
    'apps/api/src/moderation/required-subscription-notice-authority.ts',
    'binding.moderationDeleteVerified !== true',
  ],
  [
    'apps/api/src/moderation/required-subscription-notice-plan.ts',
    'executionProof: params.executionProof',
  ],
  [
    'apps/api/src/moderation/moderation-state-delete-guard.service.ts',
    'intentId_reasonKey: { intentId: intent.id, reasonKey }',
  ],
  ['apps/api/src/max/max-duplicate-notice.guard.ts', 'notice: proof,'],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-notice-proof.ts',
    'deadlineAtMs <= binding.authorization.deadlineAtMs',
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts',
    'receiptMetadata?.moderationDeleteVerified !== true',
  ],
  [
    'apps/api/src/max/max-moderation-notice-envelope.ts',
    'moderation_notice_legacy_envelope_unverified',
  ],
  [
    'apps/api/src/admin/publication-execution-safety.ts',
    'reviseUnstartedPublicationExecutionBroadcasts',
  ],
  ['apps/api/src/admin/admin-managed-broadcast-ledger-recovery.ts', 'delivery.contentRevisionId'],
  [
    'apps/api/src/publisher/publisher-video-upload.processor.ts',
    'assertPublisherIdentityOrDelay(this.identity, job, token)',
  ],
  ['apps/api/src/admin/vk-sync-lease.ts', 'FOR UPDATE OF source'],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'completeSent(delivery, dispatchStartedAt, sent.messageId)',
  ],
  ['apps/api/src/admin/admin-chat-settings.ts', "'nightModeStartTimeMinutes',"],
  [
    'apps/api/src/moderation/moderation-rule-followup-persistence.ts',
    'intent."delete_dispatch_started_at" IS NULL',
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup.service.ts',
    'moderationViolationMessageClaim.create',
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup-sanction.ts',
    'dependencies.recoverBanReceipt(actionKey)',
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup-execution.ts',
    'host.applyRuleFollowupSanction',
  ],
  ['apps/api/src/moderation/moderation.module.ts', 'useExisting: ModerationService'],
  [
    'apps/api/src/moderation/commercial/commercial-delete-guard.service.ts',
    'this.issuedPermits.get(permit)',
  ],
  [
    'apps/api/src/moderation/moderation-sanction-notice-delivery.ts',
    '...input.noticeDispatchOptions',
  ],
  ['apps/api/src/common/group-command-notice-delivery.ts', 'await revalidateRoute?.()'],
  [
    'apps/api/src/admin/admin-manual-moderation-runtime.ts',
    'this.context.assertManualGroupCommandSuccessNoticeAuthority(',
  ],
  [
    'apps/api/src/admin/admin-manual-group-command-notice-authority.ts',
    'notice.lockToken !== input.lockToken',
  ],
  [
    'apps/api/src/moderation/night-mode-transition-delivery.service.ts',
    'await revalidateRoute?.()',
  ],
];

test('both API rollback paths retain shared member and immutable Publisher effect protections', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-bot-publisher-rollback-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'protected executor fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const check = (sha) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; maxim_topology_require_bot_publisher_reliability "$2"',
        'reliability-test',
        resolve(root, 'infra/scripts/lib/deploy-topology.sh'),
        sha,
      ],
      { cwd: fixture, encoding: 'utf8' },
    );
  try {
    git('init', '-q');
    for (const [path] of protectedSources) {
      mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
      writeFileSync(resolve(fixture, path), readFileSync(resolve(root, path)));
    }
    const positive = check(commit());
    assert.equal(positive.status, 0, positive.stderr);
    for (const [path, guard] of protectedSources) {
      const source = readFileSync(resolve(root, path), 'utf8');
      assert.ok(source.includes(guard), `Fixture guard missing: ${guard}`);
      writeFileSync(resolve(fixture, path), source.replaceAll(guard, 'unsafe_legacy_executor'));
      assert.equal(check(commit()).status, 1, `Rollback erased ${guard}`);
      writeFileSync(resolve(fixture, path), source);
    }
    for (const path of [
      'infra/scripts/vps-runtime-rollback.sh',
      'infra/scripts/vps-release-rollback.sh',
    ])
      assert.match(
        readFileSync(resolve(root, path), 'utf8'),
        /maxim_topology_require_bot_publisher_reliability/u,
      );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
