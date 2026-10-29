import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { chatRulesSchema, chatSettingsSchema } from '@maxim/contracts';
import type {
  NetworkSettingsChange,
  NetworkSettingsSection,
} from '@maxim/contracts/network-settings';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { AdminSettingsService } from './admin-settings.service';
import type { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import type { MaxClientService } from '../max/max-client.service';
import { AdminMessageRetentionService } from './admin-message-retention.service';
import { AdvertisingPlacementService } from './advertising-placement.service';
import { NetworkSettingsService } from './network-settings.service';
import { NetworkNavigationAllowlist } from './network-navigation-allowlist';
import { saveChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';
import { saveChatRulesDraft, writeNetworkChatRulesDraft } from './admin-chat-rules';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('supplemental network settings with PostgreSQL', () => {
  let db: PrismaClient;
  let service: NetworkSettingsService;
  let retention: AdminMessageRetentionService;
  let advertising: AdvertisingPlacementService;
  const suffix = randomUUID();
  const number = BigInt(`0x${suffix.replaceAll('-', '').slice(0, 13)}`);
  const ids = [`-${number}`, `-${number + 1n}`];
  const operations: string[] = [];
  const user = { userId: '323459159', username: null, displayName: null };
  const cache = { invalidate: async () => undefined };
  const access = {
    assertChatAdminAccess: jest.fn(async () => undefined),
    assertManagedEntityAdminAccess: jest.fn(async () => undefined),
  } satisfies Pick<
    ManagedEntitiesService,
    'assertChatAdminAccess' | 'assertManagedEntityAdminAccess'
  >;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15_000 }),
    });
    for (const [index, id] of ids.entries()) {
      await db.chat.create({
        data: {
          id,
          title: `Supplemental ${suffix} ${index}`,
          entityType: 'CHAT',
          settings: {
            create: { greetingBotMessageText: `Own greeting ${index}`, botSpeechStyle: 'FRIENDLY' },
          },
          rules: {
            create: {
              text: `Own rules ${index}`,
              publishedMessageId: `receipt-${index}`,
              publishedUrl: `https://max.ru/rules${index}`,
            },
          },
        },
      });
      await db.messageRetentionPolicy.create({
        data: {
          chatId: id,
          hours: index === 0 ? 24 : 48,
          activationId: randomUUID(),
          quotaShard: 0,
        },
      });
      await db.advertisingPlacement.create({
        data: { chatId: id, enabled: true, listingId: randomUUID() },
      });
    }
    const prisma = db as PrismaService;
    retention = new AdminMessageRetentionService(
      prisma,
      access as unknown as ManagedEntitiesService,
      {
        allows: () => true,
        mode: 'on',
        diagnostics: async () => ({ oldestDueAt: null, blockerStatus: null }),
      } as unknown as MessageRetentionStore,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher' }),
    );
    advertising = new AdvertisingPlacementService(
      prisma,
      access as unknown as ManagedEntitiesService,
      {} as MaxClientService,
      new ConfigService({}),
    );
    const settings = {
      commercialAiModerationMode: () => 'DELETE_ONLY' as const,
      getSettings: async (id: string) => {
        const row = await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } });
        return {
          ...chatSettingsSchema.parse(sanitizeStoredChatSettings(row)),
          settingsRevision: row.updatedAt.toISOString(),
        };
      },
      updateNetworkChatSettings: async (id, actor, body, networkWrite) =>
        saveChatSettings({
          prisma,
          chatContextCache: cache,
          chatId: id,
          actorUserId: actor.userId,
          body,
          source: 'miniapp',
          networkWrite,
          resolveBotAssignmentData: () => ({}),
          assertRequiredSubscriptionSettings: async () => undefined,
          assertBotCapabilities: async () => undefined,
          refreshExecutionReadiness: async () => undefined,
        }),
      finishNetworkSettingsFollowup: async () => undefined,
      buildNetworkRulesText: async (id: string) =>
        `Generated ${(await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } })).greetingBotMessageText}`,
    } satisfies Pick<
      AdminSettingsService,
      | 'commercialAiModerationMode'
      | 'getSettings'
      | 'updateNetworkChatSettings'
      | 'finishNetworkSettingsFollowup'
      | 'buildNetworkRulesText'
    >;
    service = new NetworkSettingsService(
      prisma,
      {} as never,
      access as unknown as ManagedEntitiesService,
      settings as unknown as AdminSettingsService,
      {} as never,
      {} as never,
      new NetworkNavigationAllowlist(prisma),
      retention,
      advertising,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.networkSettingsOperation.deleteMany({ where: { id: { in: operations } } });
    await db.auditLog.deleteMany({ where: { chatId: { in: ids } } });
    await db.messageRetentionPolicy.deleteMany({ where: { chatId: { in: ids } } });
    await db.advertisingPlacement.deleteMany({ where: { chatId: { in: ids } } });
    await db.chat.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  async function previewed(section: NetworkSettingsSection, changes: NetworkSettingsChange[]) {
    const scope = {
      entityType: 'chat' as const,
      section,
      target: { mode: 'selected' as const, entityIds: ids },
    };
    const read = await service.read(user, scope);
    const operationId = randomUUID();
    operations.push(operationId);
    const result = await service.preview(user, {
      ...scope,
      operationId,
      changes,
      compositionVersion: read.compositionVersion,
      recipients: read.recipients,
    });
    for (let i = 0; i < 8 && (await service.status(user, operationId)).status === 'PREVIEWING'; i++)
      await service.tick(1);
    return { operationId, previewHash: result.previewHash };
  }
  async function prepared(section: NetworkSettingsSection, changes: NetworkSettingsChange[]) {
    const input = await previewed(section, changes);
    expect((await service.status(user, input.operationId)).status).toBe('PREPARED');
    return input;
  }
  async function apply(input: { operationId: string; previewHash: string }) {
    await service.apply(user, input);
    for (let i = 0; i < 12; i++) {
      const state = await service.status(user, input.operationId);
      if (['COMPLETE', 'PARTIAL', 'FAILED'].includes(state.status)) return state;
      await service.tick(1);
    }
    throw new Error('Operation did not settle within its bounded tick count');
  }

  it('applies speech style and a rules flag while preserving each draft, media and published receipt', async () => {
    expect(
      (
        await apply(
          await prepared('speechStyle', [{ path: 'botSpeechStyle', op: 'set', value: 'IRONIC' }]),
        )
      ).status,
    ).toBe('COMPLETE');
    const input = await prepared('rules', [
      { path: 'rulesAttachViolationsEnabled', op: 'set', value: true },
    ]);
    expect((await apply(input)).status).toBe('COMPLETE');
    expect((await service.apply(user, input)).status).toBe('COMPLETE');
    for (const [index, id] of ids.entries()) {
      expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } })).toMatchObject({
        botSpeechStyle: 'IRONIC',
        greetingBotMessageText: `Own greeting ${index}`,
        rulesAttachViolationsEnabled: true,
      });
      expect(await db.chatRules.findUniqueOrThrow({ where: { chatId: id } })).toMatchObject({
        text: `Own rules ${index}`,
        publishedMessageId: `receipt-${index}`,
      });
    }
    expect(
      await db.networkSettingsOperationTarget.count({
        where: { operationId: input.operationId, status: 'COMPLETE' },
      }),
    ).toBe(2);
  });
  it('rejects retention writes without Lastik, preserves legacy durations, and commits advertising without sending', async () => {
    const input = await previewed('messageRetention', [
      { path: 'messageRetention.enabled', op: 'set', value: true },
    ]);
    const preview = await service.status(user, input.operationId);
    expect(preview.status).toBe('FAILED');
    expect(preview.outcomes).toHaveLength(2);
    expect(preview.outcomes.every((target) => target.status === 'FAILED')).toBe(true);
    expect(preview.outcomes.map((target) => target.failureCode)).toEqual(
      expect.arrayContaining(['TRANSIENT', 'PREFLIGHT_ABORTED']),
    );
    expect((await apply(input)).status).toBe('FAILED');
    for (const [index, id] of ids.entries())
      expect(
        await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: id } }),
      ).toMatchObject({ enabled: false, hours: index === 0 ? 24 : 48, revision: 0 });
    expect(
      (
        await apply(
          await prepared('advertising', [{ path: 'advertising.enabled', op: 'set', value: false }]),
        )
      ).status,
    ).toBe('COMPLETE');
    expect(await db.advertisingPlacementSend.count({ where: { chatId: { in: ids } } })).toBe(0);
  });
  it('generates each rules draft from its own confirmed settings', async () => {
    expect(
      (
        await apply(
          await prepared('rules', [{ path: 'rules.autoTextEnabled', op: 'set', value: true }]),
        )
      ).status,
    ).toBe('COMPLETE');
    for (const [index, id] of ids.entries())
      expect(await db.chatRules.findUniqueOrThrow({ where: { chatId: id } })).toMatchObject({
        text: `Generated Own greeting ${index}`,
        autoTextEnabled: true,
        publishedMessageId: `receipt-${index}`,
      });
  });
  it('rejects a changed independent advertising policy after confirmation and leaves every target untouched', async () => {
    await db.advertisingPlacement.updateMany({
      where: { chatId: { in: ids } },
      data: { enabled: true, listingId: randomUUID() },
    });
    const input = await prepared('advertising', [
      { path: 'advertising.enabled', op: 'set', value: false },
    ]);
    await db.advertisingPlacement.update({
      where: { chatId: ids[0]! },
      data: { revision: { increment: 1 } },
    });
    const current = await db.advertisingPlacement.findMany({
      where: { chatId: { in: ids } },
      orderBy: { chatId: 'asc' },
    });
    expect((await apply(input)).status).toBe('FAILED');
    expect(
      await db.advertisingPlacement.findMany({
        where: { chatId: { in: ids } },
        orderBy: { chatId: 'asc' },
      }),
    ).toEqual(current);
    expect(await db.advertisingPlacementSend.count({ where: { chatId: { in: ids } } })).toBe(0);
  });
  it('cannot change a legacy policy or audit when Lastik is unavailable', async () => {
    const id = ids[1]!;
    const current = await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: id } });
    const auditCount = await db.auditLog.count({
      where: { chatId: id, action: 'UPDATE_MESSAGE_RETENTION' },
    });
    await expect(
      retention.update(
        id,
        user,
        { enabled: false, hours: 24, expectedRevision: current.revision },
        {
          onCommitted: async () => {
            throw new Error('receipt rejected');
          },
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: id } })).toEqual(
      current,
    );
    expect(
      await db.auditLog.count({ where: { chatId: id, action: 'UPDATE_MESSAGE_RETENTION' } }),
    ).toBe(auditCount);
  });
  it('allows only one concurrent rules writer at a shared revision and preserves publication state', async () => {
    const id = ids[0]!;
    const row = await db.chatRules.findUniqueOrThrow({ where: { chatId: id } });
    const draft = chatRulesSchema.parse({ ...row, publishedAt: null });
    const writes = await Promise.allSettled([
      db.$transaction((tx) =>
        writeNetworkChatRulesDraft(
          tx,
          id,
          user.userId,
          { ...draft, text: 'Group draft' },
          row.updatedAt.toISOString(),
          ['rules.text'],
        ),
      ),
      saveChatRulesDraft({
        prisma: db as PrismaService,
        chatContextCache: cache,
        chatId: id,
        actorUserId: user.userId,
        source: 'miniapp',
        body: { ...draft, text: 'Single draft', expectedRevision: row.updatedAt.toISOString() },
      }),
    ]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (await db.chatRules.findUniqueOrThrow({ where: { chatId: id } })).publishedMessageId,
    ).toBe(row.publishedMessageId);
  });
});
