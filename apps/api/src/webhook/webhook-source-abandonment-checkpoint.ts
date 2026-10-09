import type { WebhookEvent, WebhookExecutionClaim } from '../prisma/prisma-client';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';

const waitingKeys = ['kind', 'authorityVersion', 'webhookEventId', 'semanticKey', 'deadlineAt'];

// FLAG: Readiness can leave its exact waiting checkpoint on a subsequently started
// claim. It is retained uncertain execution evidence, never a no-effect proof or
// permission to expire/replay the claim. Admission and frozen materialization use
// the same predicate; all existing started-claim and descendant fences still apply.
export function isSourceAbandonmentCheckpointSupported(
  owner: Pick<WebhookEvent, 'id' | 'semanticKey' | 'executionDeadlineAt'>,
  claim: Pick<
    WebhookExecutionClaim,
    'webhookEventId' | 'semanticKey' | 'businessStartedAt' | 'commandResult'
  >,
): boolean {
  if (claim.commandResult === null) return true;
  const checkpoint = claim.commandResult;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
  const keys = Object.keys(checkpoint);
  const deadline = owner.executionDeadlineAt;
  const started = claim.businessStartedAt;
  return Boolean(
    keys.length === waitingKeys.length &&
    keys.every((key) => waitingKeys.includes(key)) &&
    checkpoint.kind === 'EXECUTION_WAITING' &&
    checkpoint.authorityVersion === MULTIBOT_EXECUTION_AUTHORITY_VERSION &&
    owner.semanticKey &&
    claim.webhookEventId === owner.id &&
    claim.semanticKey === owner.semanticKey &&
    checkpoint.webhookEventId === owner.id &&
    checkpoint.semanticKey === owner.semanticKey &&
    deadline instanceof Date &&
    Number.isFinite(deadline.getTime()) &&
    started instanceof Date &&
    Number.isFinite(started.getTime()) &&
    started.getTime() < deadline.getTime() &&
    checkpoint.deadlineAt === deadline.toISOString(),
  );
}
