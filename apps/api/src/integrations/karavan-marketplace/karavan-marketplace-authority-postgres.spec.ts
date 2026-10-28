import { karavanMarketplaceSetupSchema } from '@maxim/contracts/karavan-marketplace';
import {
  KaravanCommandUnavailable,
  KaravanMarketplaceProxyService,
} from './karavan-marketplace-proxy.service';
import { KaravanMarketplaceBindingStatusService } from './karavan-marketplace-binding-status.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MaxClientService } from '../../max/max-client.service';
import type { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import { MiniappSessionService } from '../../auth/miniapp-session.service';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
  type KaravanPrincipal,
} from './karavan-marketplace-authority.service';
import { KaravanMarketplacePublicationPolicyService } from './karavan-marketplace-publication-policy.service';
import { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('Karavan exact authority and actor-bound handoffs', () => {
  let db: PrismaClient;
  let service: KaravanMarketplaceAuthorityService;
  let handoffs: KaravanMarketplaceHandoffService;
  let chatId: string;
  const actorMaxUserId = '123456789';
  const botId = 'synthetic_major_bot';
  const principal: KaravanPrincipal = {
    source: 'session',
    principalKey: 'a'.repeat(64),
    launchBotId: botId,
  };
  const max = {
    getExactMessageRow: jest.fn(),
    getChatSnapshot: jest.fn(),
    getCurrentChatMemberAccess: jest.fn(),
    getChatMemberAccess: jest.fn(),
  };
  const sessions = { isPrincipalActive: jest.fn() };
  const registry = {
    getActionableBots: () => [{ id: botId }],
    getValidationTokensForBot: () => ['synthetic-only'],
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10_000 }),
    });
    await db.$connect();
    const config = new ConfigService({
      KARAVAN_MARKETPLACE_ENABLED: true,
      KARAVAN_MARKETPLACE_AUTHORITY_TOKEN: 'test-authority-secret-'.repeat(3),
      KARAVAN_SELLER_BOT_USERNAME: 'synthetic_seller_bot',
    });
    service = new KaravanMarketplaceAuthorityService(
      db as PrismaService,
      max as unknown as MaxClientService,
      registry as unknown as MaxBotRegistryService,
      sessions as unknown as MiniappSessionService,
      config,
      new KaravanMarketplacePublicationPolicyService(
        db as PrismaService,
        max as unknown as MaxClientService,
        registry as unknown as MaxBotRegistryService,
      ),
    );
    handoffs = new KaravanMarketplaceHandoffService(db as PrismaService, service, config);
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    chatId = `-${Date.now()}${Math.floor(Math.random() * 100000)}`;
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Synthetic authority test',
        entityType: 'CHAT',
        primaryBotId: botId,
      },
    });
    await db.chatBotMembership.create({
      data: { chatId, botId, status: 'ACTIVE', botAccessState: 'CONFIRMED_ADMIN' },
    });
    max.getChatSnapshot.mockResolvedValue({ chatId, entityType: 'chat', title: 'Synthetic' });
    max.getCurrentChatMemberAccess.mockResolvedValue({
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      userId: botId,
      isBot: true,
    });
    max.getChatMemberAccess.mockResolvedValue({
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      userId: actorMaxUserId,
      isBot: false,
    });
    sessions.isPrincipalActive.mockResolvedValue(true);
  });
  afterEach(async () => {
    await db.karavanMarketplaceConnectionOperation.deleteMany({ where: { actorMaxUserId } });
    await db.karavanMarketplaceChatEnrollment.deleteMany({ where: { chatId } });
    await db.karavanMarketplaceBindingWitness.deleteMany({ where: { chatId } });
    await db.karavanMarketplaceAuthorityGrant.deleteMany({ where: { chatId } });
    await db.karavanMarketplaceHandoff.deleteMany({ where: { chatId } });
    await db.chatMembershipActivityEvent.deleteMany({ where: { chatId } });
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  function scope() {
    return {
      actorMaxUserId,
      chatId,
      commandId: randomUUID(),
      action: 'read_chat_module' as const,
      marketplaceId: null,
      expectedBindingGeneration: null,
      payloadHash: karavanHash({ chatId }),
    };
  }

  it('replays exact proof without consumption but rejects changed actor/payload and revoked session', async () => {
    const input = scope();
    const proof = await service.issue(input, principal);
    expect(await service.issue(input, principal)).toEqual(proof);
    expect(await service.introspect(proof)).toMatchObject({
      provider: 'maxim',
      botId,
      actorMaxUserId,
      chatId,
    });
    expect(await service.introspect(proof)).toMatchObject({ commandId: input.commandId });
    await expect(service.introspect({ ...proof, actorMaxUserId: '987' })).rejects.toThrow();
    await expect(
      service.issue({ ...input, payloadHash: 'b'.repeat(64) }, principal),
    ).rejects.toThrow();
    sessions.isPrincipalActive.mockResolvedValue(false);
    await expect(service.introspect(proof)).rejects.toThrow('Сессия завершена');
  });

  it('fences denial committed while the remote human probe was in flight', async () => {
    max.getChatMemberAccess.mockImplementationOnce(async () => {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM chats WHERE id=${chatId} FOR UPDATE`;
        await tx.managedEntityAccessEdge.create({
          data: {
            chatId,
            userId: actorMaxUserId,
            botId,
            state: 'USER_DENIED',
            userRole: 'MEMBER',
            botRole: 'ADMIN',
            checkedAt: new Date(Date.now() + 5),
          },
        });
      });
      return {
        isAdmin: true,
        isOwner: false,
        explicitPrivilegeEvidence: true,
        userId: actorMaxUserId,
        isBot: false,
      };
    });
    await expect(service.issue(scope(), principal)).rejects.toThrow('Права изменились');
    expect(await db.karavanMarketplaceAuthorityGrant.count({ where: { chatId } })).toBe(0);
  });

  it('revokes an issued proof on local route generation changes and exact-bot removal', async () => {
    const proof = await service.issue(scope(), principal);
    await db.chat.update({ where: { id: chatId }, data: { routingVersion: { increment: 1 } } });
    await expect(service.introspect(proof)).rejects.toThrow('Права или подключение');
    const next = await service.issue(scope(), principal);
    await db.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: { status: 'REMOVED', lifecycleEventAt: new Date() },
    });
    await expect(service.introspect(next)).rejects.toThrow('Подключение чата изменилось');
  });

  it('does not infer permission from unknown bot/human responses or publisher entities', async () => {
    max.getChatMemberAccess.mockResolvedValueOnce(null);
    await expect(service.issue(scope(), principal)).rejects.toThrow('MAX пока не подтвердил');
    max.getChatMemberAccess.mockResolvedValueOnce({
      isAdmin: true,
      isOwner: false,
      userId: actorMaxUserId,
      isBot: false,
    });
    await expect(service.issue(scope(), principal)).rejects.toThrow('Нужны права администратора');
    await db.chat.update({ where: { id: chatId }, data: { entityType: 'CHANNEL' } });
    await expect(service.issue(scope(), principal)).rejects.toThrow('Нужен подключённый чат');
  });

  it('attests publication for a normal seller without granting marketplace management', async () => {
    await db.chatSettings.create({
      data: { chatId, karavanStorefrontEnabled: true, karavanStorefrontAdminsOnly: false },
    });
    max.getChatMemberAccess.mockResolvedValue({
      userId: actorMaxUserId,
      isBot: false,
      isAdmin: false,
      isOwner: false,
      explicitPrivilegeEvidence: false,
    });
    const sourceMessageId = 'synthetic-dollar-message';
    max.getExactMessageRow.mockResolvedValue({
      body: { mid: sourceMessageId, text: '$Мой товар' },
      sender: { user_id: actorMaxUserId, is_bot: false },
    });
    const input = { ...scope(), action: 'resolve_publication' as const };
    const proof = await service.issuePublication(input, {
      sourceMessageId,
      subjectMaxUserId: actorMaxUserId,
      botId,
    });
    expect(await service.introspect(proof.authority)).toMatchObject({
      action: 'resolve_publication',
      actorMaxUserId,
    });
    await expect(service.issue(scope(), principal)).rejects.toThrow('Нужны права администратора');
    await db.chatSettings.update({
      where: { chatId },
      data: { karavanStorefrontAdminsOnly: true },
    });
    await expect(service.introspect(proof.authority)).rejects.toThrow();
  });

  it('binds forwarded subject, live source content and current publication allowlist independently', async () => {
    await db.chatSettings.create({
      data: { chatId, karavanStorefrontEnabled: true, karavanStorefrontAdminsOnly: true },
    });
    await db.karavanStorefrontAllowlistEntry.create({
      data: { chatId, userId: actorMaxUserId, createdByUserId: '222' },
    });
    const subjectMaxUserId = '987654321';
    const sourceMessageId = 'synthetic-forward';
    const message = {
      body: { mid: sourceMessageId, text: '' },
      sender: { user_id: actorMaxUserId, is_bot: false },
      link: {
        type: 'forward',
        sender: { user_id: subjectMaxUserId },
        message: { body: { text: '$Витрина' } },
      },
    };
    max.getExactMessageRow.mockResolvedValue(message);
    const input = { ...scope(), action: 'resolve_publication' as const };
    await expect(
      service.issuePublication(input, { sourceMessageId, subjectMaxUserId: actorMaxUserId, botId }),
    ).rejects.toThrow('не подтверждает продавца');
    const issued = await service.issuePublication(input, {
      sourceMessageId,
      subjectMaxUserId,
      botId,
    });
    max.getExactMessageRow.mockResolvedValue({
      ...message,
      link: { ...message.link, message: { body: { text: '$Изменено' } } },
    });
    await expect(service.introspect(issued.authority)).rejects.toThrow('Публикация изменилась');
    max.getExactMessageRow.mockResolvedValue(message);
    await db.karavanStorefrontAllowlistEntry.deleteMany({ where: { chatId } });
    await expect(service.introspect(issued.authority)).rejects.toThrow('Публикация изменилась');
  });

  it('invalidates an outstanding proof after real Redis session logout', async () => {
    const realSessions = new MiniappSessionService(
      new ConfigService({ REDIS_URL: process.env.REDIS_URL }),
    );
    try {
      const user = {
        userId: actorMaxUserId,
        launchBotId: botId,
        username: null,
        displayName: null,
      };
      const created = await realSessions.create(user);
      const resolved = (await realSessions.resolve(created.sessionToken))!;
      const realPrincipal: KaravanPrincipal = {
        source: 'session',
        principalKey: resolved.keyHash,
        launchBotId: botId,
      };
      const original = sessions.isPrincipalActive.getMockImplementation();
      sessions.isPrincipalActive.mockImplementation(
        (...args: Parameters<MiniappSessionService['isPrincipalActive']>) =>
          realSessions.isPrincipalActive(...args),
      );
      const proof = await service.issue(scope(), realPrincipal);
      await realSessions.destroyResolved(created.sessionToken, resolved);
      await expect(service.introspect(proof)).rejects.toThrow('Сессия завершена');
      sessions.isPrincipalActive.mockImplementation(original);
    } finally {
      await realSessions.onModuleDestroy();
    }
  });

  function bindingStatus() {
    return new KaravanMarketplaceBindingStatusService(
      db as PrismaService,
      max as unknown as MaxClientService,
      registry as unknown as MaxBotRegistryService,
      new ConfigService({ KARAVAN_MARKETPLACE_ENABLED: true }),
    );
  }
  async function bound() {
    const proof = await service.issue(
      { ...scope(), action: 'bind_chat', marketplaceId: randomUUID() },
      principal,
    );
    const evidence = await service.introspect(proof);
    return {
      chatId,
      botId,
      authorityEpoch: evidence.authorityEpoch,
      verifiedAt: evidence.checkedAt,
    };
  }
  it('enrolls only explicit binding intent before remote commit, never reads or publication proofs', async () => {
    await service.issue(scope(), principal);
    expect(await db.karavanMarketplaceChatEnrollment.findUnique({ where: { chatId } })).toBeNull();
    await bound();
    expect(
      await db.karavanMarketplaceChatEnrollment.findUnique({ where: { chatId } }),
    ).toMatchObject({ phase: 'pending' });
    await db.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: { status: 'REMOVED' },
    });
    expect(
      await db.karavanMarketplaceChatEnrollment.findUnique({ where: { chatId } }),
    ).toMatchObject({ phase: 'pending' });
  });

  it('public status has no human admin dependency and fences bot switch-away-and-back even in the positive cache', async () => {
    const input = await bound();
    const status = bindingStatus();
    max.getChatMemberAccess.mockClear();
    expect(await status.status(input)).toMatchObject({ active: true });
    expect(max.getChatMemberAccess).not.toHaveBeenCalled();
    await db.chat.update({
      where: { id: chatId },
      data: { primaryBotId: 'other_bot', routingVersion: { increment: 1 } },
    });
    await db.chat.update({
      where: { id: chatId },
      data: { primaryBotId: botId, routingVersion: { increment: 1 } },
    });
    expect(await status.status(input)).toMatchObject({ active: false, reason: 'binding_changed' });
  });
  it('persists denial-restoration epoch and requires explicit fresh binding recovery', async () => {
    const input = await bound();
    const status = bindingStatus();
    expect(await status.status(input)).toMatchObject({ active: true });
    await db.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: { botAccessState: 'DENIED', botAccessCheckedAt: new Date() },
    });
    await db.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: { botAccessState: 'CONFIRMED_ADMIN', botAccessCheckedAt: new Date() },
    });
    expect(
      (await db.chatBotMembership.findUniqueOrThrow({ where: { chatId_botId: { chatId, botId } } }))
        .commerceRevocationEpoch,
    ).toBe(1);
    expect(await status.status(input)).toMatchObject({ active: false });
    expect(await status.status(await bound())).toMatchObject({ active: true });
  });
  it('distinguishes unknown MAX status from proven denial and never revives a denied witness', async () => {
    const input = await bound();
    const status = bindingStatus();
    max.getCurrentChatMemberAccess.mockRejectedValueOnce(new Error('Synthetic timeout'));
    await expect(status.status(input)).rejects.toThrow('MAX не подтвердил');
    expect(
      (await db.karavanMarketplaceBindingWitness.findFirstOrThrow({ where: { chatId } })).revokedAt,
    ).toBeNull();
    max.getCurrentChatMemberAccess.mockResolvedValueOnce({
      isAdmin: false,
      isOwner: false,
      explicitPrivilegeEvidence: false,
    });
    expect(await status.status(input)).toMatchObject({ active: false, reason: 'bot_unavailable' });
    expect(await status.status(input)).toMatchObject({ active: false, reason: 'binding_changed' });
    expect(
      await status.status({
        ...input,
        verifiedAt: new Date(Date.parse(input.verifiedAt) + 1).toISOString(),
      }),
    ).toMatchObject({ active: false });
  });

  it('reconciles unknown create with the same command and durable create→bind checkpoints', async () => {
    const marketplaceId = randomUUID();
    const marketplace = {
      id: marketplaceId,
      networkId: randomUUID(),
      publicSlug: 'synthetic',
      name: 'Synthetic',
      description: null,
      kind: 'chat',
      status: 'draft',
      admissionPolicy: 'applications',
      logoImageUrl: null,
      coverImageUrl: null,
      editRevision: 1,
      policyRevision: 1,
      orderRevision: 1,
      visibilityRevision: 1,
    };
    const input = {
      operationId: randomUUID(),
      chatIds: [chatId],
      create: {
        name: 'Synthetic',
        rules: { text: 'Rules', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
      },
    };
    const proxy = new KaravanMarketplaceProxyService(
      db as PrismaService,
      service,
      new ConfigService({
        KARAVAN_MARKETPLACE_API_BASE_URL: 'https://synthetic.invalid',
        KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic-only',
      }),
    );
    const calls: Array<{
      authority: { commandId: string; payloadHash: string };
      payload: unknown;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) throw new Error('Synthetic response lost after remote commit');
      if (calls.length === 2) return new Response('{}', { status: 403 });
      return new Response(
        JSON.stringify(
          calls.length === 3
            ? { marketplace }
            : { marketplace, bindingId: randomUUID(), generation: 1 },
        ),
        { status: 200 },
      );
    });
    try {
      expect((await proxy.setup(actorMaxUserId, input, principal)).state).toBe('unknown');
      // A later rights denial cannot prove that the first remote transaction did not commit.
      expect((await proxy.setup(actorMaxUserId, input, principal)).state).toBe('unknown');
      expect((await proxy.setup(actorMaxUserId, input, principal)).state).toBe('pending');
      expect((await proxy.setup(actorMaxUserId, input, principal)).state).toBe('complete');
      expect(calls[0]!.authority.commandId).toBe(calls[1]!.authority.commandId);
      expect(calls[0]!.payload).toEqual(calls[1]!.payload);
      for (const call of calls) expect(call.authority.payloadHash).toBe(karavanHash(call.payload));
      expect(
        await db.karavanMarketplaceChatEnrollment.findUnique({ where: { chatId } }),
      ).toMatchObject({ phase: 'connected', marketplaceId });
      await expect(
        proxy.setup(
          actorMaxUserId,
          { ...input, create: { ...input.create, name: 'Changed' } },
          principal,
        ),
      ).rejects.toThrow('другими параметрами');
      await expect(proxy.status(input.operationId, '987')).rejects.toThrow('недоступно');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('coalesces simultaneous first tabs and restores the immutable active setup on another device', async () => {
    const marketplace = {
      id: randomUUID(),
      networkId: randomUUID(),
      publicSlug: 'synthetic',
      name: 'Synthetic',
      description: null,
      kind: 'chat',
      status: 'draft',
      admissionPolicy: 'applications',
      logoImageUrl: null,
      coverImageUrl: null,
      editRevision: 1,
      policyRevision: 1,
      orderRevision: 1,
      visibilityRevision: 1,
    };
    const config = new ConfigService({
      KARAVAN_MARKETPLACE_API_BASE_URL: 'https://synthetic.invalid',
      KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic-only',
    });
    const proxy = new KaravanMarketplaceProxyService(db as PrismaService, service, config);
    const first = karavanMarketplaceSetupSchema.parse({
      operationId: randomUUID(),
      chatIds: [chatId],
      create: {
        name: 'Synthetic',
        rules: { text: 'Rules', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
      },
    });
    let release!: () => void;
    let reached!: () => void;
    const remoteStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const remoteReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(async () => {
      reached();
      await remoteReleased;
      return new Response(JSON.stringify({ marketplace }), { status: 200 });
    });
    globalThis.fetch = fetchMock;
    let pending: Promise<unknown> | undefined;
    try {
      pending = proxy.setup(actorMaxUserId, first, principal);
      await remoteStarted;
      const second = await proxy.setup(
        actorMaxUserId,
        { ...first, operationId: randomUUID() },
        principal,
      );
      expect(second.operationId).toBe(first.operationId);
      expect(second.state).toBe('unknown');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const anotherDevice = new KaravanMarketplaceProxyService(
        db as PrismaService,
        service,
        config,
      );
      expect((await anotherDevice.activeSetup(actorMaxUserId, chatId))?.request).toEqual(first);
      expect(await anotherDevice.activeSetup('987', chatId)).toBeNull();
      await expect(
        proxy.setup(
          actorMaxUserId,
          { ...first, operationId: randomUUID(), create: { ...first.create, name: 'Different' } },
          principal,
        ),
      ).rejects.toThrow('другими настройками');
      expect(
        await db.karavanMarketplaceConnectionOperation.count({
          where: { actorMaxUserId, anchorChatId: chatId },
        }),
      ).toBe(1);
      release();
      await pending;
      expect(
        (await anotherDevice.activeSetup(actorMaxUserId, chatId))?.checkpoints.marketplaceId,
      ).toBe(marketplace.id);
    } finally {
      release();
      await pending;
      globalThis.fetch = originalFetch;
    }
  });

  it('continues independent pending chats before retrying a failed binding', async () => {
    const marketplace = {
      id: randomUUID(),
      networkId: randomUUID(),
      publicSlug: 'synthetic',
      name: 'Synthetic',
      description: null,
      kind: 'chat' as const,
      status: 'draft' as const,
      admissionPolicy: 'applications' as const,
      logoImageUrl: null,
      coverImageUrl: null,
      editRevision: 1,
      policyRevision: 1,
      orderRevision: 1,
      visibilityRevision: 1,
    };
    const secondChat = '-991234567890';
    const input = karavanMarketplaceSetupSchema.parse({
      operationId: randomUUID(),
      chatIds: [chatId, secondChat],
      create: {
        name: 'Synthetic',
        rules: { text: 'Rules', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
      },
    });
    await db.karavanMarketplaceConnectionOperation.create({
      data: {
        id: input.operationId,
        actorMaxUserId,
        requestHash: karavanHash(input),
        request: input,
        anchorChatId: chatId,
        activeScopeKey: `${actorMaxUserId}:${chatId}`,
        state: 'partial',
        checkpoints: {
          marketplaceId: marketplace.id,
          bindings: [
            { chatId, state: 'failed', bindingId: null, generation: null },
            { chatId: secondChat, state: 'pending', bindingId: null, generation: null },
          ],
        },
      },
    });
    const proxy = new KaravanMarketplaceProxyService(
      db as PrismaService,
      service,
      new ConfigService(),
    );
    const binding = jest
      .spyOn(proxy, 'binding')
      .mockResolvedValue({ marketplace, bindingId: randomUUID(), generation: 1 });
    const result = await proxy.setup(actorMaxUserId, input, principal);
    expect(binding).toHaveBeenCalledTimes(1);
    expect(binding.mock.calls[0]![2]).toMatchObject({
      chatId: secondChat,
      commandId: `${input.operationId}:bind:1`,
    });
    expect(result.state).toBe('partial');
    expect(result.checkpoints.bindings.map((item) => item.state)).toEqual(['failed', 'connected']);
  });

  it('connects multiple chats to an existing reviewed marketplace without creating a second store', async () => {
    const input = karavanMarketplaceSetupSchema.parse({
      operationId: randomUUID(),
      chatIds: [chatId, '-9923456790'],
      existingMarketplaceId: randomUUID(),
      expectedPolicyRevision: 7,
      bindingExpectations: [
        { chatId, generation: null, action: 'bind_chat' },
        { chatId: '-9923456790', generation: 4, action: 'transfer_chat' },
      ],
    });
    const proxy = new KaravanMarketplaceProxyService(
      db as PrismaService,
      service,
      new ConfigService(),
    );
    const command = jest
      .spyOn(proxy, 'command')
      .mockRejectedValue(new Error('Creation must not run'));
    const binding = jest.spyOn(proxy, 'binding').mockResolvedValue({
      marketplace: { id: input.existingMarketplaceId } as never,
      bindingId: randomUUID(),
      generation: 5,
    });
    const first = await proxy.setup(actorMaxUserId, input, principal);
    expect(first.state).toBe('pending');
    const second = await proxy.setup(actorMaxUserId, input, principal);
    expect(second.state).toBe('complete');
    expect(command).not.toHaveBeenCalled();
    expect(binding).toHaveBeenCalledTimes(2);
    expect(binding.mock.calls[0]![0]).toBe(input.existingMarketplaceId);
    expect(binding.mock.calls[1]![2]).toMatchObject({
      chatId: '-9923456790',
      expectedBindingGeneration: 4,
      expectedPolicyRevision: 7,
      action: 'transfer_chat',
      commandId: `${input.operationId}:bind:1`,
    });
    expect((await proxy.setup(actorMaxUserId, input, principal)).state).toBe('complete');
    expect(binding).toHaveBeenCalledTimes(2);
  });

  it('cannot reinterpret an unknown remote binding as rejected after later rights loss', async () => {
    const input = karavanMarketplaceSetupSchema.parse({
      operationId: randomUUID(),
      chatIds: [chatId],
      existingMarketplaceId: randomUUID(),
      expectedPolicyRevision: 1,
    });
    const proxy = new KaravanMarketplaceProxyService(
      db as PrismaService,
      service,
      new ConfigService(),
    );
    jest
      .spyOn(proxy, 'binding')
      .mockImplementationOnce(async () => {
        const persisted = await proxy.status(input.operationId, actorMaxUserId);
        expect(persisted.checkpoints.bindings[0]?.state).toBe('unknown');
        throw new KaravanCommandUnavailable('unknown');
      })
      .mockRejectedValueOnce(new KaravanCommandUnavailable('rejected'));
    expect(
      (await proxy.setup(actorMaxUserId, input, principal)).checkpoints.bindings[0]?.state,
    ).toBe('unknown');
    expect(
      (await proxy.setup(actorMaxUserId, input, principal)).checkpoints.bindings[0]?.state,
    ).toBe('unknown');
    await expect(proxy.cancelSetup(input.operationId, actorMaxUserId, chatId)).rejects.toThrow(
      'Сначала проверьте',
    );
  });

  it('cancels only known idle setup and preserves successful remote checkpoints', async () => {
    const input = karavanMarketplaceSetupSchema.parse({
      operationId: randomUUID(),
      chatIds: [chatId, '-9923456789'],
      existingMarketplaceId: randomUUID(),
      expectedPolicyRevision: 4,
      bindingExpectations: [
        { chatId, generation: null, action: 'bind_chat' },
        { chatId: '-9923456789', generation: 1, action: 'transfer_chat' },
      ],
    });
    const checkpoints = {
      marketplaceId: input.existingMarketplaceId!,
      bindings: [
        { chatId, state: 'connected', bindingId: randomUUID(), generation: 1 },
        { chatId: '-9923456789', state: 'failed', bindingId: null, generation: null },
      ],
    };
    await db.karavanMarketplaceConnectionOperation.create({
      data: {
        id: input.operationId,
        actorMaxUserId,
        anchorChatId: chatId,
        activeScopeKey: `${actorMaxUserId}:${chatId}`,
        requestHash: karavanHash(input),
        request: input,
        checkpoints,
        state: 'partial',
      },
    });
    const proxy = new KaravanMarketplaceProxyService(
      db as PrismaService,
      service,
      new ConfigService(),
    );
    await expect(proxy.cancelSetup(input.operationId, 'other', chatId)).rejects.toThrow();
    await db.karavanMarketplaceConnectionOperation.update({
      where: { id: input.operationId },
      data: { leaseId: randomUUID(), leaseUntil: new Date(Date.now() - 1000) },
    });
    await expect(proxy.cancelSetup(input.operationId, actorMaxUserId, chatId)).rejects.toThrow(
      'Сначала проверьте',
    );
    await db.karavanMarketplaceConnectionOperation.update({
      where: { id: input.operationId },
      data: { leaseId: null, leaseUntil: null, state: 'unknown' },
    });
    await expect(proxy.cancelSetup(input.operationId, actorMaxUserId, chatId)).rejects.toThrow(
      'Сначала проверьте',
    );
    await db.karavanMarketplaceConnectionOperation.update({
      where: { id: input.operationId },
      data: { state: 'partial' },
    });
    const cancelled = await proxy.cancelSetup(input.operationId, actorMaxUserId, chatId);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.checkpoints).toEqual(checkpoints);
    expect(await proxy.activeSetup(actorMaxUserId, chatId)).toBeNull();
    expect((await proxy.cancelSetup(input.operationId, actorMaxUserId, chatId)).state).toBe(
      'cancelled',
    );
    expect((await proxy.setup(actorMaxUserId, input, principal)).state).toBe('cancelled');
  });

  it('exchanges once for the same actor, permits exact retry, and never transfers Major credentials', async () => {
    const input = { commandId: randomUUID(), marketplaceId: randomUUID(), destination: 'manage' };
    const result = await handoffs.issue(chatId, actorMaxUserId, input, principal);
    const code = new URL(result.url).searchParams.get('startapp')!.slice('community_h_'.length);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const exchangeId = randomUUID();
    await expect(handoffs.exchange({ code, actorMaxUserId: '987', exchangeId })).rejects.toThrow();
    const evidence = await handoffs.exchange({ code, actorMaxUserId, exchangeId });
    expect(evidence).toMatchObject({
      marketplaceId: input.marketplaceId,
      actorMaxUserId,
      exchangeId,
    });
    expect(evidence).not.toHaveProperty('principal');
    expect(await handoffs.exchange({ code, actorMaxUserId, exchangeId })).toEqual(evidence);
    await expect(
      handoffs.exchange({ code, actorMaxUserId, exchangeId: randomUUID() }),
    ).rejects.toThrow('уже использован');
  });

  it('serializes two different concurrent exchange IDs and rejects expired proof', async () => {
    const { url } = await handoffs.issue(
      chatId,
      actorMaxUserId,
      { commandId: randomUUID(), marketplaceId: randomUUID(), destination: 'manage' },
      principal,
    );
    const code = new URL(url).searchParams.get('startapp')!.slice('community_h_'.length);
    const results = await Promise.allSettled([
      handoffs.exchange({ code, actorMaxUserId, exchangeId: randomUUID() }),
      handoffs.exchange({ code, actorMaxUserId, exchangeId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const proof = await service.issue(scope(), principal);
    await db.karavanMarketplaceAuthorityGrant.updateMany({
      where: { chatId },
      data: { checkedAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(service.introspect(proof)).rejects.toThrow('устарело');
  });
});
