import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { selectMaxMessageCandidate } from '../max/max-message-candidate.util';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import {
  buildWebhookSemanticEventKey,
  readWebhookEventTimestamp,
} from './webhook-semantic-event-key';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';

type LegacyExecutionClaim = {
  id: string;
  webhookEventId: string | null;
  semanticKey: string;
  enforced: boolean;
  status: string;
  createdAt?: Date;
  businessStartedAt?: Date | null;
};

type PersistedExecutionOwner = {
  id: string;
  createdAt?: Date;
  status: WebhookStatus;
  errorMessage: string | null;
  normalizedPayload: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasNewOriginalSource(owner: PersistedExecutionOwner, cutoff: Date): boolean {
  const payload = asRecord(owner.normalizedPayload);
  if (!payload || !(owner.createdAt instanceof Date)) return false;
  const sourceMarker = String(payload.eventTimestampSource ?? '')
    .trim()
    .toLowerCase();
  if (sourceMarker === 'ingress') return false;
  const raw = asRecord(payload.raw);
  // FLAG: Old normalized dates may be synthesized ingress time. Only original MAX
  // timestamps or an explicit payload-source marker can certify a new shared event.
  if (!raw && sourceMarker !== 'payload') return false;
  const source = raw ?? payload;
  const type = String(payload.type ?? payload.update_type ?? payload.event_type ?? '')
    .trim()
    .toLowerCase();
  const message = selectMaxMessageCandidate(source, type)?.node;
  const eventAt = readWebhookEventTimestamp({
    ...source,
    // FLAG: Edits/lifecycle events use Update time, never older raw Message creation time.
    message: !raw || type === 'message_created' ? message : undefined,
  });
  const cutoffMs = cutoff.getTime();
  const ownerMs = Math.min(owner.createdAt.getTime(), Date.now());
  const isNewSource = (value: number | null) =>
    value !== null && value > cutoffMs && value <= ownerMs;
  if (!isNewSource(eventAt?.getTime() ?? null)) return false;
  if (type === 'message_created' && message) {
    // FLAG: A newer delivery timestamp cannot renew a stable old message identity.
    for (const field of ['createdAt', 'created_at', 'timestamp']) {
      if (
        message[field] !== undefined &&
        !isNewSource(parseWebhookEventTimestampMs(message[field]))
      )
        return false;
    }
  }
  return true;
}

const legacyCutoffs = new WeakMap<PrismaService, Promise<Date | null>>();

async function readLegacyExecutionCutoff(prisma: PrismaService): Promise<Date | null> {
  let pending = legacyCutoffs.get(prisma);
  if (!pending) {
    pending = Promise.resolve()
      .then(
        () => prisma.$queryRaw<Array<{ finishedAt: Date | null }>>`
        SELECT finished_at AS "finishedAt" FROM _prisma_migrations
        WHERE migration_name = '20261005020000_add_multibot_order_fences'
          AND rolled_back_at IS NULL AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1
      `,
      )
      .then((rows) => {
        const cutoff = rows[0]?.finishedAt;
        return cutoff instanceof Date && Number.isFinite(cutoff.getTime()) ? cutoff : null;
      });
    legacyCutoffs.set(prisma, pending);
  }
  try {
    const cutoff = await pending;
    if (!cutoff && legacyCutoffs.get(prisma) === pending) legacyCutoffs.delete(prisma);
    return cutoff;
  } catch (error) {
    if (legacyCutoffs.get(prisma) === pending) legacyCutoffs.delete(prisma);
    throw error;
  }
}

export async function holdUnverifiedLegacyExecution(
  prisma: PrismaService,
  claim: LegacyExecutionClaim,
  persistedOwner?: PersistedExecutionOwner,
): Promise<boolean> {
  if (claim.status === 'COMPLETED' || claim.businessStartedAt) return false;
  let owner: PersistedExecutionOwner | null | undefined;
  const readOwner = async () => {
    if (owner === undefined)
      owner =
        persistedOwner?.id === claim.webhookEventId
          ? persistedOwner
          : claim.webhookEventId
            ? await prisma.webhookEvent.findUnique({
                where: { id: claim.webhookEventId },
                select: {
                  id: true,
                  createdAt: true,
                  status: true,
                  errorMessage: true,
                  normalizedPayload: true,
                },
              })
            : null;
    return owner;
  };
  if (
    claim.enforced &&
    claim.createdAt instanceof Date &&
    Number.isFinite(claim.createdAt.getTime())
  ) {
    const cutoff = await readLegacyExecutionCutoff(prisma);
    if (cutoff && claim.createdAt.getTime() > cutoff.getTime()) {
      // FLAG: Receipt-scoped diagnostic fallback has no shared cross-bot authority.
      if (claim.semanticKey.startsWith('receipt:')) return false;
      const currentOwner = await readOwner();
      if (
        currentOwner?.createdAt instanceof Date &&
        Number.isFinite(currentOwner.createdAt.getTime()) &&
        currentOwner.createdAt.getTime() > cutoff.getTime() &&
        buildWebhookSemanticEventKey(currentOwner.normalizedPayload) === claim.semanticKey &&
        hasNewOriginalSource(currentOwner, cutoff)
      ) {
        const oldMirror = await prisma.webhookEvent.findFirst({
          where: { semanticKey: claim.semanticKey, createdAt: { lte: cutoff } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (!oldMirror) return false;
      }
    }
  }
  // FLAG: Historical off-mode receipts may have effects without any claim. A fresh
  // claim alone cannot authorize replay: owner birth and original source must also
  // follow the successful quiescent migration, with no indexed older semantic mirror.
  // Every unfinished unenforced claim remains unverified, including after that cutoff.
  // Missing birth/cutoff cannot invent no-effects proof or authorize whole-engine replay.
  if (claim.webhookEventId) {
    const owner = await readOwner();
    if (
      owner &&
      buildWebhookSemanticEventKey(owner.normalizedPayload) === claim.semanticKey &&
      owner.status !== WebhookStatus.PROCESSED &&
      owner.status !== WebhookStatus.DUPLICATE
    ) {
      await prisma.webhookEvent.updateMany({
        where: {
          id: owner.id,
          status: owner.status,
          errorMessage: owner.errorMessage,
          normalizedPayload: { equals: owner.normalizedPayload as Prisma.InputJsonValue },
          executionClaims: {
            some: {
              id: claim.id,
              kind: 'EXECUTION',
              semanticKey: claim.semanticKey,
              enforced: claim.enforced,
              status: { not: 'COMPLETED' },
              businessStartedAt: null,
            },
          },
        },
        data: {
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
          queueName: null,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required`,
        },
      });
    }
  }
  return true;
}
