import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type ManagedBroadcastDeliveryStatus } from '../../src/prisma/prisma-client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE } from '../../src/admin/publication-dispatch-issue';
import { PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA } from '../../src/admin/publication-delivery-verification-state';
import { readPublisherPreparedDialogContext } from '../../src/admin/publisher-dialog-context.service';
import type { ProfileRuntimeSnapshot, ProfileTurn } from './runtime';

export type ProfileFixtureState = 'ready' | 'future-retry' | 'verification' | 'blocked-head';
export type ProfileFixtureSchedule = 'NOW' | 'ONCE';

export interface ProfileFixtureOptions {
  size: number;
  state: ProfileFixtureState;
  schedule?: ProfileFixtureSchedule;
  contextPaddingBytes?: 0 | 8192;
}

export interface ProfilePostconditions {
  deliveries: Record<ManagedBroadcastDeliveryStatus, number>;
  receipts: number;
  attempted: number;
  dueVerificationRemaining: number;
  broadcastStatus: string;
  occurrenceStatus: string;
  actionTargetOrdinals: number[];
  verificationTargetOrdinals: number[];
  receiptLinkage: { checked: number; normalizedSha256: string };
}

export interface ProfileFixture {
  readonly prisma: PrismaService;
  readonly botId: string;
  readonly actorId: string;
  readonly publicationId: string;
  readonly occurrenceId: string;
  readonly broadcastId: string;
  readonly revisionId: string;
  readonly scheduleId: string;
  readonly chatIds: readonly string[];
  readonly size: number;
  readonly state: ProfileFixtureState;
  readonly schedule: ProfileFixtureSchedule;
  readonly dueVerificationCount: number;
  readonly context: { paddingBytes: number; inputUtf8Bytes: number; parserAccepted: true };
  reset(): Promise<void>;
  assertPostconditions(
    turn: ProfileTurn,
    snapshot: ProfileRuntimeSnapshot,
  ): Promise<ProfilePostconditions>;
  denyActorTargets(targetIds?: readonly string[]): Promise<void>;
  cancelPublication(): Promise<void>;
  setFreshDeniedHead(count?: number): Promise<void>;
  cleanup(): Promise<void>;
}

const BATCH_SIZE = 1_000;
const RETRY_HORIZON_MS = 60 * 60_000;
const DEADLINE_HORIZON_MS = 24 * 60 * 60_000;
const PROFILE_TEXT = 'Synthetic Publisher full-turn profile';
let activeFixture: symbol | undefined;

const bindingProof = {
  isAdmin: true,
  isOwner: false,
  permissions: ['write'],
  permissionsKnown: true,
} satisfies Prisma.InputJsonObject;

function* batches(values: readonly string[]): Generator<string[]> {
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE)
    yield values.slice(offset, offset + BATCH_SIZE);
}

function deliveryResetData(): Prisma.ManagedBroadcastDeliveryUpdateManyMutationInput {
  return {
    status: 'PENDING',
    botId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    waitReason: null,
    capacityDeferralCount: 0,
    rateLimitDeferralCount: 0,
    firstDeferredAt: null,
    lastDeferredAt: null,
    remoteMessageId: null,
    ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
    legacySentWithoutRemoteId: false,
    lastErrorCode: null,
    lastError: null,
    sentAt: null,
    postActionsNextAt: null,
    postActionsToken: null,
    subscriptionDeleteId: null,
    pinStatus: 'NONE',
    pinError: null,
    pinAttemptCount: 0,
    deleteStatus: 'NONE',
    deleteAt: null,
    deletedAt: null,
    deleteError: null,
    deleteAttemptCount: 0,
    lockedAt: null,
    lockToken: null,
    dispatchBlockerCode: null,
    dispatchBlockedAt: null,
  };
}

// FLAG: This is a disposable native fixture, never a recovery API. Only one audience
// may exist at once because the measured public selectors intentionally see the database.
export async function createProfileFixture(
  prisma: PrismaService,
  options: ProfileFixtureOptions,
): Promise<ProfileFixture> {
  assert(Number.isSafeInteger(options.size) && options.size > 0 && options.size <= 50_000);
  if (options.state === 'blocked-head') assert(options.size >= 8);
  const size = options.size;
  const state = options.state;
  const schedule = options.schedule ?? 'NOW';
  if (schedule === 'ONCE') assert.equal(state, 'ready', 'The scheduled control must be ready');
  assert.equal(activeFixture, undefined, 'Clean up the previous profile fixture first');
  const owner = Symbol('publisher-turn-profile');
  const token = randomUUID();
  const botId = `publisher-profile-${token}`;
  const actorId = `publisher-profile-actor-${token}`;
  const publicationId = randomUUID();
  const occurrenceId = randomUUID();
  const broadcastId = randomUUID();
  const revisionId = randomUUID();
  const scheduleId = randomUUID();
  const numericBase = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 10)}`) * 1_000_000n;
  // Register ownership before the first write, including partially completed batches.
  const chatIds = Array.from(
    { length: size },
    (_, position) => `-${numericBase + BigInt(position) + 1n}`,
  );
  const dueVerificationCount = state === 'verification' ? Math.min(50, size) : 0;
  const dueVerificationTargets = chatIds.slice(0, dueVerificationCount);
  const paddingBytes = options.contextPaddingBytes ?? 0;
  assert(paddingBytes === 0 || paddingBytes === 8192);
  const semanticContext = { version: 1, dialogBotId: botId, buttons: [], reference: null };
  const deliveryContext = {
    ...semanticContext,
    ...(paddingBytes ? { profilePadding: 'p'.repeat(paddingBytes) } : {}),
  } satisfies Prisma.InputJsonObject;
  const parsedContext = readPublisherPreparedDialogContext(deliveryContext, botId);
  assert(parsedContext, 'The actual context parser must accept the fixture payload');
  assert.deepEqual(parsedContext, readPublisherPreparedDialogContext(semanticContext, botId));
  const context = {
    paddingBytes,
    inputUtf8Bytes: Buffer.byteLength(JSON.stringify(deliveryContext), 'utf8'),
    parserAccepted: true,
  } as const;
  assert(context.inputUtf8Bytes < 64 * 1024);
  activeFixture = owner;
  let cleaned = false;

  function assertActive(): void {
    assert(!cleaned && activeFixture === owner, 'Profile fixture is no longer active');
  }

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    assertActive();
    // FLAG: The caller must await its own turn before cleanup. A deadline belongs to
    // the child-process supervisor; a Promise race does not cancel active SQL.
    for (const ids of batches(chatIds)) {
      await prisma.managedBroadcastDelivery.deleteMany({
        where: { broadcastId, targetChatId: { in: ids } },
      });
      await prisma.managedBroadcastCalendarReservation.deleteMany({
        where: { broadcastId, targetChatId: { in: ids } },
      });
      await prisma.publicationTarget.deleteMany({
        where: { publicationId, targetChatId: { in: ids } },
      });
    }
    await prisma.managedBroadcast.deleteMany({ where: { id: broadcastId } });
    await prisma.publicationOccurrence.deleteMany({ where: { id: occurrenceId } });
    await prisma.publication.deleteMany({ where: { id: publicationId } });
    for (const ids of batches(chatIds)) {
      await prisma.publisherAccessRefreshObligation.deleteMany({
        where: { publisherBotId: botId, chatId: { in: ids } },
      });
      await prisma.chat.deleteMany({ where: { id: { in: ids } } });
    }
    cleaned = true;
    activeFixture = undefined;
  }

  async function reset(): Promise<void> {
    assertActive();
    // All reset work is outside the measured interval. Preserve immutable v1 context;
    // restore receipts/leases/verification as fixture data, never by running recovery.
    const anchor = new Date();
    const retryAt = new Date(anchor.getTime() + RETRY_HORIZON_MS);
    const expiresAt = new Date(anchor.getTime() + DEADLINE_HORIZON_MS);
    const historicalSentAt = new Date(anchor.getTime() - 10 * 60_000);
    for (const ids of batches(chatIds)) {
      const resetData = deliveryResetData();
      if (state === 'verification') {
        // Exact remote IDs were seeded once and the synthetic presence adapter can
        // only report present. Do not replace per-recipient immutable receipt identity.
        delete resetData.remoteMessageId;
        Object.assign(resetData, {
          status: 'SENT',
          botId,
          attemptCount: 1,
          sentAt: historicalSentAt,
          remoteMessageVerifiedAt: new Date(anchor.getTime() - 60_000),
          remoteMessageVerificationAttemptCount: 2,
          remoteMessageVerificationPresentCount: 2,
          remoteMessageVerificationAttemptedAt: new Date(anchor.getTime() - 60_000),
          remoteMessageVerificationSource: 'AUTOMATED_STABLE',
        } satisfies Prisma.ManagedBroadcastDeliveryUpdateManyMutationInput);
      } else if (state === 'future-retry') {
        resetData.nextAttemptAt = retryAt;
        resetData.waitReason = 'local_capacity';
        resetData.capacityDeferralCount = 1;
        resetData.firstDeferredAt = anchor;
        resetData.lastDeferredAt = anchor;
      }
      await prisma.managedBroadcastDelivery.updateMany({
        where: { broadcastId, targetChatId: { in: ids } },
        data: resetData,
      });
      await prisma.publisherEntityBinding.updateMany({
        where: { publisherBotId: botId, chatId: { in: ids } },
        data: {
          status: 'ACTIVE',
          botAccessState: 'CONFIRMED_ADMIN',
          permissionsSnapshot: bindingProof,
          botAccessCheckedAt: anchor,
          botAccessExpiresAt: expiresAt,
          botAccessSource: 'publisher-profile',
          botAccessLastErrorCode: null,
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastFailureAt: null,
          sendRouteLastFailureCode: null,
          sendRouteLastSuccessAt: null,
        },
      });
      await prisma.managedEntityAccessEdge.updateMany({
        where: { botId, userId: actorId, chatId: { in: ids } },
        data: {
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          checkedAt: anchor,
          lastAdminConfirmedAt: anchor,
          expiresAt,
          deniedReason: null,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
        },
      });
    }
    if (dueVerificationCount > 0) {
      await prisma.managedBroadcastDelivery.updateMany({
        where: { broadcastId, targetChatId: { in: dueVerificationTargets } },
        data: {
          remoteMessageVerifiedAt: null,
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationPresentCount: 1,
          remoteMessageVerificationAttemptedAt: new Date(anchor.getTime() - 60_000),
          remoteMessageVerificationNextAt: new Date(anchor.getTime() - 1_000),
          remoteMessageVerificationSource: null,
        },
      });
    }
    if (state === 'blocked-head') {
      const denied = chatIds.slice(0, 4);
      await denyActorTargets(denied);
      await prisma.managedBroadcastDelivery.updateMany({
        where: { broadcastId, targetChatId: { in: denied } },
        data: {
          dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
          dispatchBlockedAt: anchor,
          nextAttemptAt: retryAt,
        },
      });
    }
    // Refresh the original schedule after audience writes; ONCE cannot age out during seed.
    const scheduledAt = new Date(Date.now() - 1_000);
    const deadlineAt = new Date(
      scheduledAt.getTime() + (schedule === 'NOW' ? DEADLINE_HORIZON_MS : 5 * 60_000),
    );
    const rule: Prisma.InputJsonObject =
      schedule === 'NOW'
        ? { mode: 'now', timezone: 'UTC' }
        : { mode: 'once', timezone: 'UTC', at: scheduledAt.toISOString(), replaceConflicts: false };
    await prisma.publication.update({
      where: { id: publicationId },
      data: { lifecycle: 'ACTIVE', version: 1, canonicalContentRevisionId: revisionId },
    });
    await prisma.publicationSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'ACTIVE',
        revision: 1,
        rule,
        nextMaterializeAt: null,
        lastMaterializedAt: scheduledAt,
        lastError: null,
      },
    });
    await prisma.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: 'IN_PROGRESS',
        scheduledAt,
        scheduleRevision: 1,
        legacyBroadcastId: broadcastId,
        deliveryDeadlineAt: deadlineAt,
        retryAuthorizedAt: null,
        retryExpiresAt: null,
        dispatchBlockerCode: null,
        dispatchBlockedAt: null,
        dispatchFirstBlockedAt: null,
        accessPreflightPosition: null,
        accessPreflightCycleStartedAt: null,
        accessPreflightLastCompletedAt: null,
      },
    });
    await prisma.managedBroadcast.update({
      where: { id: broadcastId },
      data: {
        status: 'ACTIVE',
        sentCount: 0,
        nextSendAt: scheduledAt,
        lastError: null,
        lockedAt: null,
        lockToken: null,
      },
    });
    await prisma.managedBroadcastOccurrence.updateMany({
      where: { broadcastId, occurrenceIndex: 1 },
      data: { status: 'ACTIVE', scheduledAt },
    });
    for (const ids of batches(chatIds))
      await prisma.managedBroadcastCalendarReservation.updateMany({
        where: { broadcastId, targetChatId: { in: ids } },
        data: { scheduledAt },
      });
  }

  async function denyActorTargets(targetIds: readonly string[] = chatIds): Promise<void> {
    assertActive();
    for (const ids of batches(targetIds))
      await prisma.managedEntityAccessEdge.updateMany({
        where: { userId: actorId, botId, chatId: { in: ids } },
        data: { state: 'USER_DENIED', deniedReason: 'synthetic_profile_revocation' },
      });
  }

  async function setFreshDeniedHead(count = 4): Promise<void> {
    assert(Number.isSafeInteger(count) && count > 0 && count <= Math.min(size, 64));
    const ids = chatIds.slice(0, count);
    await denyActorTargets(ids);
    await prisma.managedBroadcastDelivery.updateMany({
      where: { broadcastId, targetChatId: { in: ids } },
      data: { dispatchBlockerCode: null, dispatchBlockedAt: null, nextAttemptAt: null },
    });
  }

  async function assertPostconditions(
    turn: ProfileTurn,
    snapshot: ProfileRuntimeSnapshot,
  ): Promise<ProfilePostconditions> {
    assertActive();
    assert.equal(
      snapshot.unexpectedBoundaryCount,
      0,
      'A synthetic boundary rejected unexpected work',
    );
    assert.equal(snapshot.errorCount, 0, 'Publisher logged a runtime error');
    const maintenance = turn === 'maintenance-run' || turn === 'maintenance-pause';
    const expectedNoSend = maintenance || state === 'future-retry' || state === 'verification';
    if (expectedNoSend) assert.equal(snapshot.sendCount, 0, 'Unexpected synthetic SEND');
    else if (turn === 'targeted') {
      assert(snapshot.sendCount >= Math.min(4, size) && snapshot.sendCount <= Math.min(16, size));
      assert(snapshot.sendCount % 4 === 0 || snapshot.sendCount === size);
    } else assert.equal(snapshot.sendCount, Math.min(4, size - (state === 'blocked-head' ? 4 : 0)));
    if (maintenance)
      assert.equal(snapshot.presenceCount, 0, 'Maintenance must not verify remotely');
    if (state === 'verification' && !maintenance)
      assert.equal(snapshot.presenceCount, dueVerificationCount);
    assert.equal(snapshot.sentTargetIdsTruncated, false);
    assert.equal(snapshot.sentTargetIds.length, snapshot.sendCount);
    const targetOffset = state === 'blocked-head' ? 4 : 0;
    assert.deepEqual(
      snapshot.sentTargetIds,
      expectedNoSend ? [] : chatIds.slice(targetOffset, targetOffset + snapshot.sendCount),
      'The public turn must preserve the intended recipient sequence',
    );
    if (state === 'verification' && !maintenance) {
      assert.equal(snapshot.presenceMessageIdsTruncated, false);
      assert.equal(snapshot.presenceMessageIds.length, dueVerificationCount);
      assert.deepEqual(
        snapshot.presenceMessageIds,
        dueVerificationTargets.map((chatId) => `profile-receipt-${chatId}`),
        'The verifier must preserve the enrolled receipt sequence',
      );
    }
    const deliveries: Record<ManagedBroadcastDeliveryStatus, number> = {
      PENDING: 0,
      SENDING: 0,
      SENT: 0,
      FAILED: 0,
      AMBIGUOUS: 0,
      CANCELED: 0,
    };
    const grouped = await prisma.managedBroadcastDelivery.groupBy({
      by: ['status'],
      where: { broadcastId },
      _count: { _all: true },
    });
    for (const group of grouped) deliveries[group.status] = group._count._all;
    assert.equal(
      Object.values(deliveries).reduce((sum, count) => sum + count, 0),
      size,
    );
    assert.equal(
      deliveries.SENDING + deliveries.FAILED + deliveries.AMBIGUOUS + deliveries.CANCELED,
      0,
    );
    const expectedSent = state === 'verification' ? size : snapshot.sendCount;
    assert.equal(deliveries.SENT, expectedSent);
    assert.equal(deliveries.PENDING, size - expectedSent);
    const receipts = await prisma.managedBroadcastDelivery.count({
      where: { broadcastId, remoteMessageId: { not: null } },
    });
    const attempted = await prisma.managedBroadcastDelivery.count({
      where: { broadcastId, attemptCount: { gt: 0 } },
    });
    assert.equal(
      receipts,
      expectedSent,
      'Every synthetic successful SEND must persist its receipt',
    );
    assert.equal(attempted, expectedSent);
    const receiptDigest = createHash('sha256');
    if (state === 'verification') {
      const [linkage] = await prisma.$queryRaw<{ mismatches: number }[]>(Prisma.sql`
        SELECT count(*)::int AS mismatches FROM managed_broadcast_deliveries
        WHERE broadcast_id = ${broadcastId} AND occurrence_index = 1
          AND (bot_id IS DISTINCT FROM ${botId}
            OR remote_message_id IS DISTINCT FROM ('profile-receipt-' || target_chat_id))
      `);
      assert.equal(linkage?.mismatches, 0, 'Every receipt must retain its original target and bot');
      for (let ordinal = 0; ordinal < size; ordinal++)
        receiptDigest.update(`${JSON.stringify([ordinal, 'seed-receipt', 'fixture-publisher'])}\n`);
    } else if (snapshot.sentTargetIds.length) {
      const rows = await prisma.managedBroadcastDelivery.findMany({
        where: { broadcastId, targetChatId: { in: [...snapshot.sentTargetIds] } },
        select: { targetChatId: true, remoteMessageId: true, botId: true },
      });
      assert.equal(rows.length, snapshot.sentTargetIds.length);
      const byTarget = new Map(rows.map((row) => [row.targetChatId, row]));
      for (const [index, target] of snapshot.sentTargetIds.entries()) {
        const row = byTarget.get(target);
        assert(row);
        assert.equal(row.remoteMessageId, `profile-${broadcastId}-${index + 1}`);
        assert.equal(row.botId, botId);
        receiptDigest.update(
          `${JSON.stringify([chatIds.indexOf(target), index + 1, 'fixture-publisher'])}\n`,
        );
      }
    }
    assert.equal(
      await prisma.managedBroadcastDelivery.count({
        where: { broadcastId, status: 'SENT', botId, remoteMessageId: { not: null } },
      }),
      expectedSent,
      'Receipts must retain the exact Publisher bot',
    );
    assert.equal(
      await prisma.managedBroadcastDelivery.count({
        where: { broadcastId, OR: [{ lockedAt: { not: null } }, { lockToken: { not: null } }] },
      }),
      0,
      'No recipient lease may survive a completed profile turn',
    );
    const dueVerificationRemaining =
      dueVerificationCount === 0
        ? 0
        : await prisma.managedBroadcastDelivery.count({
            where: {
              broadcastId,
              targetChatId: { in: dueVerificationTargets },
              remoteMessageVerifiedAt: null,
            },
          });
    if (state === 'verification')
      assert.equal(dueVerificationRemaining, maintenance ? dueVerificationCount : 0);
    const broadcast = await prisma.managedBroadcast.findUniqueOrThrow({
      where: { id: broadcastId },
      select: { status: true, lockedAt: true, lockToken: true },
    });
    assert.equal(broadcast.lockedAt, null);
    assert.equal(broadcast.lockToken, null);
    const occurrence = await prisma.publicationOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      select: { status: true },
    });
    return {
      deliveries,
      receipts,
      attempted,
      dueVerificationRemaining,
      broadcastStatus: broadcast.status,
      occurrenceStatus: occurrence.status,
      actionTargetOrdinals: snapshot.sentTargetIds.map((id) => chatIds.indexOf(id)),
      verificationTargetOrdinals: snapshot.presenceMessageIds.map((id) =>
        chatIds.indexOf(id.slice('profile-receipt-'.length)),
      ),
      receiptLinkage: { checked: expectedSent, normalizedSha256: receiptDigest.digest('hex') },
    };
  }

  try {
    const seedAt = new Date();
    for (const ids of batches(chatIds)) {
      await prisma.chat.createMany({ data: ids.map((id) => ({ id, title: PROFILE_TEXT })) });
      await prisma.publisherEntityBinding.createMany({
        data: ids.map(
          (chatId): Prisma.PublisherEntityBindingCreateManyInput => ({
            chatId,
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: seedAt,
            botAccessSource: 'publisher-profile',
            permissionsSnapshot: bindingProof,
          }),
        ),
      });
      await prisma.managedEntityAccessEdge.createMany({
        data: ids.map(
          (chatId): Prisma.ManagedEntityAccessEdgeCreateManyInput => ({
            chatId,
            userId: actorId,
            botId,
            entityType: 'CHAT',
            state: 'GRANTED',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
            checkedAt: seedAt,
            source: 'publisher_targeted_user_access',
            sourceVersion: token,
          }),
        ),
      });
    }
    await prisma.publication.create({
      data: {
        id: publicationId,
        actorUserId: actorId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        audienceMode: 'SNAPSHOT',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        schedule: {
          create: {
            id: scheduleId,
            mode: schedule,
            timezone: 'UTC',
            status: 'ACTIVE',
            rule:
              schedule === 'NOW'
                ? { mode: 'now', timezone: 'UTC' }
                : {
                    mode: 'once',
                    timezone: 'UTC',
                    at: seedAt.toISOString(),
                    replaceConflicts: false,
                  },
          },
        },
        contentRevisions: { create: { id: revisionId, revision: 1, text: PROFILE_TEXT } },
      },
    });
    await prisma.publicationOccurrence.create({
      data: {
        id: occurrenceId,
        publicationId,
        scheduleId,
        contentRevisionId: revisionId,
        scheduleRevision: 1,
        scheduledAt: seedAt,
        status: 'IN_PROGRESS',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        deliveryDeadlineAt: new Date(seedAt.getTime() + DEADLINE_HORIZON_MS),
      },
    });
    await prisma.managedBroadcast.create({
      data: {
        id: broadcastId,
        sourceChatId: chatIds[0]!,
        actorUserId: actorId,
        text: PROFILE_TEXT,
        targetChatIds: chatIds,
        buttons: [],
        publicationOccurrenceId: occurrenceId,
        publicationContentRevisionId: revisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: seedAt,
        scheduleMode: 'calendar',
        scheduleTimezone: 'UTC',
        occurrences: {
          create: { sourceChatId: chatIds[0]!, occurrenceIndex: 1, scheduledAt: seedAt },
        },
      },
    });
    let position = 0;
    let deliveryPosition = 0;
    for (const ids of batches(chatIds)) {
      await prisma.publicationTarget.createMany({
        data: ids.map(
          (targetChatId): Prisma.PublicationTargetCreateManyInput => ({
            publicationId,
            targetChatId,
            entityType: 'CHAT',
            position: position++,
          }),
        ),
      });
      await prisma.managedBroadcastDelivery.createMany({
        data: ids.map(
          (targetChatId): Prisma.ManagedBroadcastDeliveryCreateManyInput => ({
            // FLAG: Existing SQL tie-breaks by id; keep its fixture order tied to the
            // immutable audience ordinal across independent baseline/candidate seeds.
            id: `publisher-profile-delivery-${token}-${String(deliveryPosition++).padStart(5, '0')}`,
            broadcastId,
            targetChatId,
            occurrenceIndex: 1,
            publicationOccurrenceId: occurrenceId,
            contentRevisionId: revisionId,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            dialogBotId: botId,
            publicationPolicyRevision: 0,
            publisherDialogContext: deliveryContext,
            ...(state === 'verification'
              ? {
                  status: 'SENT',
                  botId,
                  sentAt: seedAt,
                  attemptCount: 1,
                  remoteMessageId: `profile-receipt-${targetChatId}`,
                }
              : {}),
          }),
        ),
      });
      await prisma.managedBroadcastCalendarReservation.createMany({
        data: ids.map((targetChatId) => ({
          broadcastId,
          sourceChatId: chatIds[0]!,
          occurrenceIndex: 1,
          targetChatId,
          scheduledAt: seedAt,
        })),
      });
    }
    await reset();
    assert.equal(
      await prisma.publisherEntityBinding.count({ where: { publisherBotId: botId } }),
      size,
    );
    assert.equal(
      await prisma.managedEntityAccessEdge.count({ where: { botId, userId: actorId } }),
      size,
    );
    assert.equal(await prisma.publicationTarget.count({ where: { publicationId } }), size);
    assert.equal(await prisma.managedBroadcastDelivery.count({ where: { broadcastId } }), size);
    assert.equal(
      await prisma.managedBroadcastCalendarReservation.count({ where: { broadcastId } }),
      size,
    );
    return {
      prisma,
      botId,
      actorId,
      publicationId,
      occurrenceId,
      broadcastId,
      revisionId,
      scheduleId,
      chatIds,
      size,
      state,
      schedule,
      dueVerificationCount,
      context,
      reset,
      cleanup,
      assertPostconditions,
      denyActorTargets,
      setFreshDeniedHead,
      cancelPublication: async () => {
        assertActive();
        await prisma.publication.update({
          where: { id: publicationId },
          data: { lifecycle: 'CANCELED' },
        });
      },
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Profile seed and cleanup failed');
    }
    throw error;
  }
}
