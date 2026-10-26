import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { EraserControlService } from './eraser-control.service';
import { retentionBindingQuery } from './message-retention-binding';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

native('independent Lastik bridge with PostgreSQL', () => {
  let db: PrismaClient;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('A disposable local race_test PostgreSQL is required');
    db = createPrismaClient(databaseUrl, { max: 4 });
    await db.$connect();
  });
  afterAll(async () => db?.$disconnect());
  afterEach(() => jest.restoreAllMocks());

  async function isolated(
    run: (
      tx: Prisma.TransactionClient,
      service: EraserControlService,
      chatId: string,
    ) => Promise<void>,
  ) {
    const rollback = new Error('rollback Lastik fixture');
    try {
      await db.$transaction(
        async (tx) => {
          const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 13)}`)}`;
          await tx.chat.create({ data: { id: chatId, title: 'Lastik isolated fixture' } });
          await tx.messageRetentionPolicy.create({
            data: { chatId, enabled: true, hours: 24, activationId: randomUUID(), quotaShard: 0 },
          });
          let nested = 0;
          const scoped = {
            $transaction: async <T>(work: (client: Prisma.TransactionClient) => Promise<T>) => {
              const name = `eraser_fixture_${++nested}`;
              await tx.$executeRaw(Prisma.raw(`SAVEPOINT ${name}`));
              try {
                const result = await work(tx);
                await tx.$executeRaw(Prisma.raw(`RELEASE SAVEPOINT ${name}`));
                return result;
              } catch (error) {
                await tx.$executeRaw(Prisma.raw(`ROLLBACK TO SAVEPOINT ${name}`));
                await tx.$executeRaw(Prisma.raw(`RELEASE SAVEPOINT ${name}`));
                throw error;
              }
            },
            $queryRaw: tx.$queryRaw.bind(tx),
            $executeRaw: tx.$executeRaw.bind(tx),
            messageRetentionPolicy: tx.messageRetentionPolicy,
            chatRules: tx.chatRules,
            managedGiveaway: tx.managedGiveaway,
            auditLog: tx.auditLog,
          };
          const service = new EraserControlService(
            scoped as unknown as PrismaService,
            new ConfigService({
              ERASER_ENABLED: true,
              ERASER_CONTROL_URL: 'http://eraser:3000',
              ERASER_CONTROL_TOKEN: 'a'.repeat(64),
            }),
          );
          await run(tx, service, chatId);
          throw rollback;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  function state(operationId: string, enabled = true) {
    return {
      enabled,
      hours: 168,
      revision: 1,
      status: enabled ? 'running' : 'off',
      enabledAt: null,
      captureAfter: null,
      pausedAt: null,
      pendingCount: 0,
      deletedCount: 0,
      skippedCount: 0,
      oldestDueAt: null,
      lastOperationId: operationId,
    };
  }

  it('fences legacy execution before enable and preserves uncertain deletion evidence', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      const intentId = randomUUID();
      await tx.moderationDeleteIntent.create({
        data: {
          id: intentId,
          chatId,
          messageId: 'uncertain',
          status: 'IN_PROGRESS',
          retentionOwned: true,
          deleteDispatchStartedAt: new Date(),
          deleteDispatchStartedBotId: 'legacy-retention-bot',
          retryUntilAt: new Date(Date.now() + 86_400_000),
        },
      });
      await tx.chatRules.create({ data: { chatId, publishedMessageId: 'rules-original' } });
      await tx.managedGiveaway.create({
        data: {
          sourceChatId: chatId,
          actorUserId: 'admin',
          title: 'Protected fixture',
          endsAt: new Date(),
          publicationMessageId: 'giveaway-original',
          resultsMessageId: 'giveaway-results',
        },
      });
      const calls: { path: string; body: unknown }[] = [];
      jest.spyOn(service, 'request').mockImplementation(async (path, method, body) => {
        calls.push({ path, body });
        if (path.endsWith('/policy') && method === 'PUT') {
          expect(
            (await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).enabled,
          ).toBe(false);
          return state(operationId);
        }
        return path.endsWith('/policy') ? { ...state(operationId, false), revision: 0 } : {};
      });
      const input = { enabled: true, hours: 168 as const, expectedRevision: 0, operationId };
      await expect(service.update(chatId, 'admin', input)).rejects.toMatchObject({ status: 503 });
      expect(
        calls.filter(
          (row) => row.path.endsWith('/policy') && (row.body as { enabled?: boolean })?.enabled,
        ),
      ).toHaveLength(0);
      for (let i = 0; i < 8; i++) await service.syncChat(chatId);
      // Other native source fixtures retain immutable author projections. Drain them
      // through the same bounded delivery API instead of assuming an empty fleet.
      let globalReady = false;
      for (let page = 0; page < 200 && !globalReady; page++) {
        await service.syncGlobalHolds();
        const [row] = await tx.$queryRaw<{ ready: boolean }[]>`
          SELECT bootstrap_complete AND NOT EXISTS(SELECT 1 FROM eraser_held_authors WHERE delivered = FALSE LIMIT 1) AS ready
          FROM eraser_global_hold_state WHERE id = 1`;
        globalReady = row?.ready === true;
      }
      expect(globalReady).toBe(true);
      await expect(service.update(chatId, 'admin', input)).resolves.toMatchObject({
        hours: 168,
        lastOperationId: operationId,
      });
      const registry = await tx.$queryRaw<
        { messageId: string; held: boolean }[]
      >`SELECT message_id AS "messageId", held FROM eraser_protected_messages WHERE chat_id = ${chatId}`;
      expect(registry).toEqual(
        expect.arrayContaining([
          { messageId: 'rules-original', held: false },
          { messageId: 'giveaway-original', held: false },
          { messageId: 'giveaway-results', held: false },
          { messageId: 'uncertain', held: true },
        ]),
      );
      const [binding] = await tx.$queryRaw<{ eraserOwned: boolean }[]>(
        retentionBindingQuery(intentId),
      );
      expect(binding?.eraserOwned).toBe(true);
      const intent = await tx.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(intent.status).toBe('IN_PROGRESS');
      expect(intent.deleteDispatchStartedAt).not.toBeNull();
    }));

  it('captures replaced/deleted protected IDs transactionally and keeps source uncertainty below the watermark', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      const snapshots: Record<string, unknown>[] = [];
      jest.spyOn(service, 'request').mockImplementation(async (path, method, body) => {
        if (path.endsWith('/protection')) snapshots.push(body as Record<string, unknown>);
        return path.endsWith('/policy') ? state(operationId, false) : {};
      });
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 48,
        expectedRevision: 0,
        operationId,
      });
      const fenceAt = new Date(Date.now() - 3 * 86_400_000);
      await tx.chatRules.create({ data: { chatId, publishedMessageId: 'old-rules' } });
      await tx.chatRules.update({
        where: { chatId },
        data: {
          publishedMessageId: 'new-rules',
          publishOperationId: randomUUID(),
          publishSendStartedAt: fenceAt,
        },
      });
      for (let i = 0; i < 8; i++) await service.syncChat(chatId);
      expect(
        snapshots.some(
          (row) =>
            row.complete === true && Date.parse(String(row.completeThrough)) < fenceAt.getTime(),
        ),
      ).toBe(true);
      await tx.chatRules.delete({ where: { chatId } });
      const protectedIds = await tx.$queryRaw<
        { id: string }[]
      >`SELECT message_id AS id FROM eraser_protected_messages WHERE chat_id = ${chatId} ORDER BY message_id`;
      expect(protectedIds.map((row) => row.id)).toEqual(['new-rules', 'old-rules']);
    }));

  it('reuses an acknowledged remote operation when the local network receipt loses its lease', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      jest
        .spyOn(service, 'request')
        .mockImplementation(async (path) =>
          path.endsWith('/policy') ? state(operationId, false) : {},
        );
      const input = { enabled: false, hours: 168 as const, expectedRevision: 0, operationId };
      const precheck = jest.fn(async () => undefined);
      const receipt = jest.fn(async () => {
        throw new Error('lease superseded after remote acknowledgement');
      });
      await expect(
        service.update(chatId, 'admin', input, { beforeWrite: precheck, onCommitted: receipt }),
      ).rejects.toThrow('lease superseded');
      expect(precheck).toHaveBeenCalledTimes(2);
      const [unconfirmed] = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT result FROM eraser_control_operations WHERE id = ${operationId}`;
      expect(unconfirmed?.result).toBeNull();
      const committed = jest.fn(async () => undefined);
      await expect(
        service.resume(chatId, 'admin', operationId, { onCommitted: committed }),
      ).resolves.toMatchObject({ lastOperationId: operationId });
      expect(committed).toHaveBeenCalledTimes(1);
      const recorded = await tx.$queryRaw<
        { request: { operationId: string } }[]
      >`SELECT request FROM eraser_control_operations WHERE id = ${operationId}`;
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.request.operationId).toBe(operationId);
    }));

  it('imports historical human rules in bounded audit pages and captures unowned replacements', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.chatRules.create({
        data: {
          chatId,
          publishedMessageId: 'unowned-old-rules',
          publishedBotId: 'retired-module-bot',
        },
      });
      await tx.chatRules.update({
        where: { chatId },
        data: { publishedMessageId: 'unowned-new-rules' },
      });
      await tx.chatRules.delete({ where: { chatId } });
      await tx.auditLog.createMany({
        data: Array.from({ length: 501 }, (_, index) => ({
          id: randomUUID(),
          chatId,
          actorUserId: 'admin',
          action: 'ADOPT_CHAT_RULES_MESSAGE',
          createdAt: new Date(1_000_000 + index),
          payload: {
            messageId: `human-rule-${index}`,
            previousPublishedMessageId: index === 500 ? 'older-human-adopted-rules' : null,
            botId: 'historical-module-bot',
          },
        })),
      });
      const snapshots: Record<string, unknown>[] = [];
      const operationId = randomUUID();
      jest.spyOn(service, 'request').mockImplementation(async (path, _method, body) => {
        if (path.endsWith('/protection')) snapshots.push(body as Record<string, unknown>);
        return path.endsWith('/policy') ? state(operationId, false) : {};
      });
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 48,
        expectedRevision: 0,
        operationId,
      });
      const [first] = await tx.$queryRaw<
        { complete: boolean }[]
      >`SELECT rules_audit_complete AS complete FROM eraser_protection_outbox WHERE chat_id = ${chatId}`;
      expect(first?.complete).toBe(false);
      const [notYet] = await tx.$queryRaw<
        { found: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM eraser_protected_messages WHERE chat_id = ${chatId} AND message_id = 'older-human-adopted-rules') AS found`;
      expect(notYet?.found).toBe(false);
      for (let page = 0; page < 8; page++) await service.syncChat(chatId);
      expect(snapshots.flatMap((row) => row.protectedMessageIds)).toEqual(
        expect.arrayContaining([
          'unowned-old-rules',
          'unowned-new-rules',
          'human-rule-500',
          'older-human-adopted-rules',
        ]),
      );
      expect(snapshots.flatMap((row) => row.protectedBotIds)).toEqual(
        expect.arrayContaining(['retired-module-bot', 'historical-module-bot']),
      );
      const [binding] = await tx.$queryRaw<
        { createdAt: Date }[]
      >`SELECT created_at AS "createdAt" FROM eraser_chat_bindings WHERE chat_id = ${chatId}`;
      expect(snapshots.at(-1)).toMatchObject({
        complete: true,
        botHistoryCompleteFrom: binding!.createdAt.toISOString(),
      });
    }));

  it('preserves the imported 48-hour interval while saving a weekly independent policy', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.messageRetentionPolicy.update({ where: { chatId }, data: { hours: 48 } });
      const operationId = randomUUID();
      jest
        .spyOn(service, 'request')
        .mockImplementation(async (path) =>
          path.endsWith('/policy') ? state(operationId, false) : {},
        );
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 168,
        expectedRevision: 0,
        operationId,
      });
      const [binding] = await tx.$queryRaw<
        { hours: number }[]
      >`SELECT legacy_hours AS hours FROM eraser_chat_bindings WHERE chat_id = ${chatId}`;
      expect(binding?.hours).toBe(48);
    }));
});
