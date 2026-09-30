import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';
import { digestDuplicateContent } from './message-duplicate-content';
import { buildMessageDuplicateJobId } from './message-duplicate.queue';
import {
  buildMessageScopedModerationActionClaimKey,
  type ModerationMessageActionClaimData,
} from '../moderation-message-action-claim';
import {
  MessageDuplicateAuthorizationService,
  duplicateRevocationKey,
} from './message-duplicate-authorization.service';
import {
  MESSAGE_DUPLICATE_CLAIM_PREFIX,
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  MESSAGE_DUPLICATE_SOURCE,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)(
  'duplicate authorization and message claim PostgreSQL races',
  () => {
    let prisma: PrismaClient;
    let intents: ModerationDeleteIntentService;
    const chatId = `duplicate-claim-${randomUUID()}`;
    const claim = (
      messageId: string,
      ruleCode = 'DUPLICATE_MESSAGE_ACTION',
    ): ModerationMessageActionClaimData => ({
      dedupeKey: `${chatId}:${messageId}:${ruleCode}`,
      messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, messageId),
      chatId,
      userId: 'user',
      messageId,
      ruleCode,
      updateType: 'message_action',
    });
    const canonicalClaim = (messageId: string) => {
      const own = claim(messageId);
      own.dedupeKey = `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([chatId, own.userId, messageId])}`;
      return own;
    };
    const jobFor = (own: ModerationMessageActionClaimData, eventTimestampMs = Date.now()) => ({
      chatId,
      messageId: own.messageId,
      eventTimestampMs,
      deadlineAtMs: eventTimestampMs + 600000,
      idempotencyKey: buildMessageDuplicateJobId(chatId, own.messageId, eventTimestampMs),
    });
    const bindingFor = (
      own: ModerationMessageActionClaimData,
      eventTimestampMs: number,
    ): MessageDuplicateBinding => {
      const hash = 'a'.repeat(64);
      return {
        version: 3,
        enforcementScope: 'delete_only',
        lifecycleRevision: hash,
        policyRevision: 0,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600000 },
        original: {
          member: hash,
          author: hash,
          messageId: 'original',
          senderId: own.userId,
          publishedAtMs: eventTimestampMs - 1000,
          observedAtMs: eventTimestampMs - 1000,
          expiresAtMs: eventTimestampMs + 600000,
          sourceDigest: hash,
          contentDigest: hash,
          mediaHashes: [],
          epoch: 0,
          revision: hash,
          originalId: hash,
        },
        senderId: own.userId,
        messageId: own.messageId,
        eventTimestampMs,
        controlRevision: 1,
        settingsDigest: hash,
        sourceDigest: hash,
        contentDigest: hash,
        fingerprint: hash,
        compareMode: 'TEXT',
        mediaHashes: [],
        mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
        hasPhotos: false,
        photoControlRevision: null,
        windowSeconds: 600,
        requiredCount: 2,
      };
    };
    const handoffFor = (
      own: ModerationMessageActionClaimData,
      binding: MessageDuplicateBinding,
    ) => ({
      claim: own,
      intent: {
        chatId,
        messageId: own.messageId,
        subjectUserId: own.userId,
        entityType: 'CHAT' as const,
        messageAuthorKind: 'user' as const,
        ruleCode: 'DUPLICATE_DELETE',
        reasonKey: `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}`,
        retryUntilAt: new Date(binding.authorization!.deadlineAtMs),
        event: {
          userId: own.userId,
          eventType: 'MESSAGE' as const,
          metadata: {
            duplicateSource: MESSAGE_DUPLICATE_SOURCE,
            messageDuplicate: binding,
            enforcementScope: binding.enforcementScope,
          },
        },
      },
    });
    const serviceFor = (database: unknown = prisma) => {
      const service = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(service, {
        prisma: database,
        getRolloutForRule: () => 'execute',
        getRolloutForInput: () => 'execute',
        enqueueCurrentWakeup: jest.fn(async () => undefined),
        // Keep the real handoff transaction; unrelated persistence routing is reduced to SQL.
        persistIntent: async (
          input: EnsureModerationDeleteIntentInput,
          _enqueue: boolean,
          tx: Prisma.TransactionClient,
        ) => {
          const intent = await tx.moderationDeleteIntent.create({
            data: {
              id: `${chatId}:${input.messageId}`,
              chatId,
              messageId: input.messageId,
              subjectUserId: input.subjectUserId,
              retryUntilAt: new Date(input.retryUntilAt!),
            },
          });
          return { intentId: intent.id, status: intent.status, rollout: 'execute' };
        },
      });
      return service;
    };
    const pauseFirstTransactionRead = (
      model: 'moderationEvent' | 'moderationViolationMessageClaim',
    ) => {
      let observed!: () => void;
      let proceed!: () => void;
      const reached = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const continued = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      let paused = false;
      let attempts = 0;
      return {
        reached,
        proceed: () => proceed(),
        attempts: () => attempts,
        database: {
          moderationViolationMessageClaim: prisma.moderationViolationMessageClaim,
          $transaction: (
            operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options: { isolationLevel?: Prisma.TransactionIsolationLevel },
          ) => {
            attempts += 1;
            return prisma.$transaction(async (tx) => {
              const reader = new Proxy(tx[model], {
                get(target, key) {
                  if (key !== 'findFirst') return Reflect.get(target, key);
                  return async (input: unknown) => {
                    const result = await Reflect.apply(Reflect.get(target, key), target, [input]);
                    if (!paused) {
                      paused = true;
                      observed();
                      await continued;
                    }
                    return result;
                  };
                },
              });
              return operation(
                new Proxy(tx, {
                  get(target, key) {
                    return key === model ? reader : Reflect.get(target, key);
                  },
                }),
              );
            }, options);
          },
        },
      };
    };

    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Duplicate claim races require a disposable local race_test database');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Duplicate race test' } });
      intents = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(intents, { prisma });
      jest.spyOn(intents, 'getRolloutForRule').mockReturnValue('execute');
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      if (!prisma) return;
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.$disconnect();
    });

    it('gives concurrent rules one durable owner before any stage can be reserved', async () => {
      const duplicate = claim('race');
      const other = claim('race', 'STOP_WORD');
      const results = await Promise.all([
        intents.claimMessageActionBeforeQualification(duplicate),
        intents.claimMessageActionBeforeQualification(other),
      ]);
      expect(results.sort()).toEqual(['blocked', 'claimed']);
      const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { messageActionKey: duplicate.messageActionKey },
      });
      const winning = owner.ruleCode === duplicate.ruleCode ? duplicate : other;
      const losing = owner.ruleCode === duplicate.ruleCode ? other : duplicate;
      expect(await intents.claimMessageActionBeforeQualification(winning)).toBe('resumed');
      expect(await intents.claimMessageActionBeforeQualification(losing)).toBe('blocked');
      expect(
        await prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId: 'race' },
        }),
      ).toBe(1);
    });

    it('resumes an interrupted own claim without transferring it to another rule', async () => {
      const own = claim('crash');
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
      // A fresh service process sees the same committed owner after an interrupted qualification.
      const recovered = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(recovered, { prisma, getRolloutForRule: () => 'execute' });
      expect(await recovered.claimMessageActionBeforeQualification(own)).toBe('resumed');
      expect(await recovered.claimMessageActionBeforeQualification(claim('crash', 'OTHER'))).toBe(
        'blocked',
      );
    });

    it('releases only an unused owner and fences its old authorization before a foreign claim', async () => {
      const own = claim('unused');
      const eventTimestampMs = Date.now();
      const binding = {
        version: 3,
        messageId: own.messageId,
        senderId: own.userId,
        eventTimestampMs,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600000 },
      };
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
      expect(
        await intents.releaseUnmaterializedMessageAction({ claim: own, binding: binding as never }),
      ).toBe(true);
      const tombstone = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: own.dedupeKey },
      });
      expect(tombstone.messageActionKey).toBeNull();
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('blocked');
      expect(
        await intents.claimMessageActionBeforeQualification(claim(own.messageId, 'OTHER')),
      ).toBe('claimed');
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('blocked');
      const authorization = new MessageDuplicateAuthorizationService(prisma as never, {} as never);
      expect(await authorization.isAllowed(chatId, binding as never)).toBe(false);
      expect(
        await intents.releaseUnmaterializedMessageAction({ claim: own, binding: binding as never }),
      ).toBe(false);
    });

    it('reconciles a terminated worker without releasing a newer reservation', async () => {
      const eventTimestampMs = Date.now();
      const own = claim('terminated');
      own.dedupeKey = `message-duplicate-action:v1:${digestDuplicateContent([chatId, own.userId, own.messageId])}`;
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
      const job = {
        chatId,
        messageId: own.messageId,
        eventTimestampMs,
        deadlineAtMs: eventTimestampMs + 600000,
        idempotencyKey: buildMessageDuplicateJobId(chatId, own.messageId, eventTimestampMs),
      };
      expect(await intents.releaseTerminatedMessageDuplicateAction(job)).toBe(true);
      expect(
        await intents.claimMessageActionBeforeQualification(claim(own.messageId, 'OTHER')),
      ).toBe('claimed');
      const fresh = claim('fresh');
      fresh.dedupeKey = `message-duplicate-action:v1:${digestDuplicateContent([chatId, fresh.userId, fresh.messageId])}`;
      expect(await intents.claimMessageActionBeforeQualification(fresh)).toBe('claimed');
      const oldTimestamp = eventTimestampMs - 720000;
      expect(
        await intents.releaseTerminatedMessageDuplicateAction({
          ...job,
          messageId: fresh.messageId,
          eventTimestampMs: oldTimestamp,
          deadlineAtMs: oldTimestamp + 600000,
          idempotencyKey: buildMessageDuplicateJobId(chatId, fresh.messageId, oldTimestamp),
        }),
      ).toBe(false);
      expect(await intents.claimMessageActionBeforeQualification(fresh)).toBe('resumed');
    });

    it('retains a materialized or foreign owner during terminal cleanup', async () => {
      const own = canonicalClaim('materialized');
      const binding = {
        version: 3,
        messageId: own.messageId,
        senderId: own.userId,
        eventTimestampMs: Date.now(),
        authorization: { eventTimestampMs: Date.now(), deadlineAtMs: Date.now() + 600000 },
      };
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
      await prisma.moderationDeleteIntent.create({
        data: {
          id: `${chatId}:materialized`,
          chatId,
          messageId: own.messageId,
          retryUntilAt: new Date(Date.now() + 600000),
        },
      });
      expect(
        await intents.releaseUnmaterializedMessageAction({ claim: own, binding: binding as never }),
      ).toBe(false);
      expect(await intents.releaseTerminatedMessageDuplicateAction(jobFor(own))).toBe(false);
      expect(
        await intents.claimMessageActionBeforeQualification(claim(own.messageId, 'OTHER')),
      ).toBe('blocked');
      const foreign = claim('foreign', 'OTHER');
      expect(await intents.claimMessageActionBeforeQualification(foreign)).toBe('claimed');
      expect(
        await intents.releaseUnmaterializedMessageAction({
          claim: claim('foreign'),
          binding: { ...binding, messageId: foreign.messageId } as never,
        }),
      ).toBe(false);
      expect(await intents.releaseTerminatedMessageDuplicateAction(jobFor(foreign))).toBe(false);
      expect(await intents.claimMessageActionBeforeQualification(foreign)).toBe('resumed');
    });

    it.each(['handoff', 'cleanup'] as const)(
      'serializes concurrent cleanup and intent handoff when %s commits first',
      async (winner) => {
        const own = canonicalClaim(`concurrent-${winner}`);
        const binding = bindingFor(own, Date.now());
        const input = handoffFor(own, binding);
        expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
        const pause = pauseFirstTransactionRead(
          winner === 'handoff' ? 'moderationEvent' : 'moderationViolationMessageClaim',
        );
        const paused = serviceFor(pause.database);
        const direct = serviceFor();
        const pending =
          winner === 'handoff'
            ? paused.releaseUnmaterializedMessageAction({ claim: own, binding })
            : paused.ensureIntentWithMessageActionClaim(input);
        await pause.reached;
        let first: unknown;
        try {
          first =
            winner === 'handoff'
              ? await direct.ensureIntentWithMessageActionClaim(input)
              : await direct.releaseUnmaterializedMessageAction({ claim: own, binding });
        } finally {
          pause.proceed();
        }
        const second = await pending;
        const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
          where: { dedupeKey: own.dedupeKey },
        });
        const materialized = await prisma.moderationDeleteIntent.findUnique({
          where: { chatId_messageId: { chatId, messageId: own.messageId } },
        });
        const revoked = await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(chatId, own.messageId, binding.eventTimestampMs),
          },
        });
        expect(pause.attempts()).toBeGreaterThanOrEqual(2);
        if (winner === 'handoff') {
          expect(first).toMatchObject({ claim: 'resumed', intent: { intentId: materialized?.id } });
          expect(second).toBe(false);
          expect(materialized).not.toBeNull();
          expect(owner.messageActionKey).toBe(own.messageActionKey);
          expect(revoked).toBeNull();
          expect(await intents.claimMessageActionBeforeQualification(own)).toBe('resumed');
        } else {
          expect(first).toBe(true);
          expect(second).toEqual({ claim: 'blocked', intent: null });
          expect(materialized).toBeNull();
          expect(owner.messageActionKey).toBeNull();
          expect(revoked).not.toBeNull();
          expect(await direct.ensureIntentWithMessageActionClaim(input)).toEqual({
            claim: 'blocked',
            intent: null,
          });
          expect(
            await intents.claimMessageActionBeforeQualification(claim(own.messageId, 'OTHER')),
          ).toBe('claimed');
        }
      },
    );

    it('rolls back owner release when the durable denial writer is unavailable', async () => {
      const own = canonicalClaim('failed-cleanup');
      const binding = bindingFor(own, Date.now());
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
      const unavailable = serviceFor({
        $transaction: (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) =>
          prisma.$transaction(async (tx) => {
            const writer = new Proxy(tx.moderationViolationMessageClaim, {
              get(target, key) {
                if (key !== 'createMany') return Reflect.get(target, key);
                return async () => {
                  throw new Error('Synthetic durable denial writer unavailable');
                };
              },
            });
            return operation(
              new Proxy(tx, {
                get(target, key) {
                  return key === 'moderationViolationMessageClaim'
                    ? writer
                    : Reflect.get(target, key);
                },
              }),
            );
          }, options),
      });
      await expect(
        unavailable.releaseUnmaterializedMessageAction({ claim: own, binding }),
      ).rejects.toThrow('durable denial writer unavailable');
      const retained = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: own.dedupeKey },
      });
      expect(retained.messageActionKey).toBe(own.messageActionKey);
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('resumed');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(chatId, own.messageId, binding.eventTimestampMs),
          },
        }),
      ).toBeNull();
    });

    it('retains an event-only materialized owner during terminal cleanup', async () => {
      const own = canonicalClaim('event-only');
      const job = jobFor(own);
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('claimed');
      await prisma.moderationEvent.create({
        data: {
          chatId,
          userId: own.userId,
          messageId: own.messageId,
          eventType: 'MESSAGE',
          ruleCode: 'DUPLICATE_WARN',
          action: 'WARN',
        },
      });
      expect(await intents.releaseTerminatedMessageDuplicateAction(job)).toBe(false);
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('resumed');
    });

    it('retains a newer exact owner replacing the initially observed terminated reservation', async () => {
      const own = canonicalClaim('replaced-terminal-owner');
      const job = jobFor(own, Date.now() - 720000);
      await prisma.moderationViolationMessageClaim.create({
        data: { ...own, createdAt: new Date(job.eventTimestampMs + 1000) },
      });
      let observed!: () => void;
      let proceed!: () => void;
      const reached = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const continued = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const reader = new Proxy(prisma.moderationViolationMessageClaim, {
        get(target, key) {
          if (key !== 'findUnique') return Reflect.get(target, key);
          return async (input: unknown) => {
            const result = await Reflect.apply(Reflect.get(target, key), target, [input]);
            observed();
            await continued;
            return result;
          };
        },
      });
      const terminal = serviceFor({
        moderationViolationMessageClaim: reader,
        $transaction: prisma.$transaction.bind(prisma),
      });
      const pending = terminal.releaseTerminatedMessageDuplicateAction(job);
      await reached;
      const fresh = await prisma.$transaction(async (tx) => {
        await tx.moderationViolationMessageClaim.delete({ where: { dedupeKey: own.dedupeKey } });
        return tx.moderationViolationMessageClaim.create({ data: own });
      });
      proceed();
      expect(await pending).toBe(false);
      expect(fresh.createdAt.getTime()).toBeGreaterThan(job.deadlineAtMs);
      expect(await intents.claimMessageActionBeforeQualification(own)).toBe('resumed');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: { dedupeKey: duplicateRevocationKey(chatId, own.messageId, job.eventTimestampMs) },
        }),
      ).toBeNull();
    });

    it('records one initial admission across concurrent processes and total queue loss', async () => {
      const admission = new MessageDuplicateAdmissionService(prisma as never);
      const input = { chatId, messageId: 'admission', jobId: `${chatId}:admission` };
      const results = await Promise.all(Array.from({ length: 8 }, () => admission.register(input)));
      expect(results.filter((result) => result.registration === 'initial')).toHaveLength(1);
      expect(results.filter((result) => result.registration === 'retry')).toHaveLength(7);
      expect(new Set(results.map((result) => result.admittedAtMs)).size).toBe(1);
      const recovered = new MessageDuplicateAdmissionService(prisma as never);
      expect(await recovered.register(input)).toEqual({ ...results[0], registration: 'retry' });
      expect(
        await intents.claimMessageActionBeforeQualification(claim(input.messageId, 'OTHER')),
      ).toBe('claimed');
    });

    it('concurrent revocations survive Redis failure and never occupy the action owner', async () => {
      const eventTimestampMs = Date.now();
      const ordering = {
        revokeActionEligibility: jest.fn(async () => {
          throw new Error('Redis unavailable');
        }),
      };
      const authorization = new MessageDuplicateAuthorizationService(
        prisma as never,
        ordering as never,
      );
      const input = { chatId, messageId: 'revoked', senderId: 'user', eventTimestampMs };
      await Promise.all(Array.from({ length: 8 }, () => authorization.revoke(input)));
      const denied = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: duplicateRevocationKey(chatId, input.messageId, eventTimestampMs) },
      });
      expect(denied.messageActionKey).toBeNull();
      expect(
        await prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId: input.messageId },
        }),
      ).toBe(1);
      expect(
        await intents.claimMessageActionBeforeQualification(claim(input.messageId, 'OTHER')),
      ).toBe('claimed');
      const oldBinding = {
        version: 3,
        messageId: input.messageId,
        eventTimestampMs,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600000 },
      };
      expect(await authorization.isAllowed(chatId, oldBinding as never)).toBe(false);
      const recovered = new MessageDuplicateAuthorizationService(prisma as never, {} as never);
      expect(await recovered.isAllowed(chatId, oldBinding as never)).toBe(false);
      expect(
        await recovered.isAllowed(chatId, {
          ...oldBinding,
          authorization: {
            eventTimestampMs: eventTimestampMs + 1000,
            deadlineAtMs: eventTimestampMs + 600000,
          },
        } as never),
      ).toBe(false);
    });
  },
);
