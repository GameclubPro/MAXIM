import { BadRequestException, ConflictException } from '@nestjs/common';
import { PublicationContentFormat } from '../prisma/prisma-client';
import { PublisherAutoReplyService } from './publisher-auto-reply.service';
import { BotCapabilityRequiredException } from './bot-capability-required.error';

const user = {
  userId: 'admin-1',
  username: 'admin',
  displayName: 'Админ',
  avatarUrl: null,
  profileUrl: null,
};

const now = new Date('2026-08-29T10:00:00.000Z');

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    chatId: 'chat-1',
    phrase: 'ПРАЙС',
    normalizedPhrase: 'прайс',
    enabled: true,
    cooldownSeconds: 30,
    version: 1,
    currentContentRevisionId: 'content-1',
    createdByUserId: user.userId,
    updatedByUserId: user.userId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    currentContentRevision: {
      id: 'content-1',
      ruleId: 'rule-1',
      revision: 1,
      text: '**Ответ**',
      textFormat: PublicationContentFormat.MARKDOWN,
      buttons: [{ text: 'Подробнее', url: 'https://example.com/help', row: 0 }],
      createdByUserId: user.userId,
      createdAt: now,
      assets: [],
    },
    ...overrides,
  };
}

function createFixture(options: { moduleEnabled?: boolean } = {}) {
  const tx = {
    publisherAutoReplyRule: {
      create: jest.fn().mockResolvedValue({ id: 'rule-1', version: 1 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'rule-1' }),
    },
    publisherAutoReplyContentRevision: {
      create: jest.fn().mockResolvedValue({ id: 'content-1' }),
    },
    publisherAutoReplyAsset: {
      findFirst: jest.fn(),
      upsert: jest.fn(),
    },
    publisherAutoReplyContentAsset: { create: jest.fn() },
    publisherAutoReplyMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    publisherEntitySettings: {
      upsert: jest.fn().mockResolvedValue({ revision: 4 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    publisherAutoReplyRule: {
      findMany: jest.fn().mockResolvedValue([ruleRow()]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue(ruleRow()),
    },
    publisherAutoReplyAsset: { findFirst: jest.fn() },
    publisherAutoReplyMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest
      .fn()
      .mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const policy = {
    getEntity: jest.fn().mockResolvedValue({
      id: 'chat-1',
      moduleSettings: { autoRepliesEnabled: options.moduleEnabled ?? false },
    }),
    assertBotCapabilityForFeatureEnablement: jest.fn().mockResolvedValue(undefined),
  };
  const maxClient = { validateMediaUploadPayload: jest.fn() };
  const service = new PublisherAutoReplyService(
    prisma as never,
    policy as never,
    maxClient as never,
  );
  return { service, prisma, tx, policy, maxClient };
}

describe('PublisherAutoReplyService', () => {
  it('creates a normalized immutable rule and atomically enables its chat module', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.create('chat-1', user, {
        requestId: 'request_create_1',
        phrase: '  ПРАЙС\n ',
        content: {
          text: '**Ответ**',
          textFormat: 'markdown',
          buttons: [{ text: 'Подробнее', url: 'https://example.com/help', row: 0 }],
        },
      }),
    ).resolves.toMatchObject({
      id: 'rule-1',
      phrase: 'ПРАЙС',
      content: {
        revision: 1,
        text: '**Ответ**',
        textFormat: 'markdown',
        buttons: [{ text: 'Подробнее', url: 'https://example.com/help', row: 0 }],
      },
    });

    expect(fixture.policy.getEntity).toHaveBeenCalledWith('chat', 'chat-1', user);
    expect(fixture.policy.assertBotCapabilityForFeatureEnablement).toHaveBeenCalledWith(
      'chat',
      'chat-1',
      ['enabled', 'autoRepliesEnabled'],
    );
    expect(fixture.tx.publisherAutoReplyRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        phrase: 'ПРАЙС',
        normalizedPhrase: 'прайс',
        cooldownSeconds: 30,
        enabled: true,
      }),
      select: { id: true, version: true },
    });
    expect(fixture.tx.publisherAutoReplyContentRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleId: 'rule-1',
        revision: 1,
        text: '**Ответ**',
        textFormat: PublicationContentFormat.MARKDOWN,
        buttons: [{ text: 'Подробнее', url: 'https://example.com/help', row: 0 }],
      }),
      select: { id: true },
    });
    expect(fixture.tx.publisherEntitySettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1' },
        create: expect.objectContaining({ autoRepliesEnabled: true }),
        update: expect.objectContaining({ autoRepliesEnabled: true }),
      }),
    );
    expect(fixture.tx.auditLog.create).toHaveBeenCalledTimes(2);
    const audit = fixture.tx.auditLog.create.mock.calls[1]?.[0]?.data?.payload;
    expect(audit).toMatchObject({
      ruleId: 'rule-1',
      version: 1,
      phrase: { length: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      content: {
        revision: 1,
        textLength: 9,
        textSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        buttonCount: 1,
        images: [],
      },
      autoRepliesModuleEnabled: true,
      moduleSettingsRevision: 4,
    });
    expect(JSON.stringify(audit)).not.toContain('ПРАЙС');
    expect(JSON.stringify(audit)).not.toContain('Ответ');
    expect(JSON.stringify(audit)).not.toContain('Подробнее');
    expect(JSON.stringify(audit)).not.toContain('example.com');
  });

  it('does not churn the module revision when it is already enabled', async () => {
    const fixture = createFixture({ moduleEnabled: true });

    await fixture.service.create('chat-1', user, {
      requestId: 'request_create_2',
      phrase: 'Контакты',
      content: { text: 'Ответ' },
    });

    expect(fixture.tx.publisherEntitySettings.upsert).not.toHaveBeenCalled();
    expect(fixture.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fixture.policy.assertBotCapabilityForFeatureEnablement).toHaveBeenCalledWith(
      'chat',
      'chat-1',
      ['enabled'],
    );
  });

  it('rejects an ordinary enabled create before content preparation or writes', async () => {
    const fixture = createFixture();
    fixture.policy.assertBotCapabilityForFeatureEnablement.mockRejectedValueOnce(
      new BotCapabilityRequiredException({
        missingPermissions: ['write'],
        featureKeys: ['enabled', 'autoRepliesEnabled'],
      }),
    );

    await expect(
      fixture.service.create('chat-1', user, {
        requestId: 'request_create_blocked',
        phrase: 'Прайс',
        content: { text: 'Ответ' },
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_REQUIRED',
        featureKeys: ['enabled', 'autoRepliesEnabled'],
      }),
    });

    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.tx.publisherAutoReplyRule.create).not.toHaveBeenCalled();
  });

  it('preflights a disabled-to-enabled rule update before its transaction', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    fixture.prisma.publisherAutoReplyRule.findFirst.mockResolvedValue(
      ruleRow({ enabled: false }),
    );
    fixture.policy.assertBotCapabilityForFeatureEnablement.mockRejectedValueOnce(
      new BotCapabilityRequiredException({
        missingPermissions: ['write'],
        featureKeys: ['enabled'],
      }),
    );

    await expect(
      fixture.service.update('chat-1', 'rule-1', user, {
        requestId: 'request_update_blocked',
        expectedVersion: 1,
        enabled: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_REQUIRED',
        featureKeys: ['enabled'],
      }),
    });

    expect(fixture.policy.assertBotCapabilityForFeatureEnablement).toHaveBeenCalledWith(
      'chat',
      'chat-1',
      ['enabled'],
    );
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preflights module activation even when the rule was already enabled', async () => {
    const fixture = createFixture({ moduleEnabled: false });
    fixture.policy.assertBotCapabilityForFeatureEnablement.mockRejectedValueOnce(
      new BotCapabilityRequiredException({
        missingPermissions: ['write'],
        featureKeys: ['autoRepliesEnabled'],
      }),
    );

    await expect(
      fixture.service.update('chat-1', 'rule-1', user, {
        requestId: 'request_update_module_blocked',
        expectedVersion: 1,
        enabled: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_REQUIRED',
        featureKeys: ['autoRepliesEnabled'],
      }),
    });

    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists bot-authored prepared content as an archived immutable draft', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.createFromPreparedContent({
        chatId: 'chat-1',
        actorUserId: user.userId,
        requestId: 'authoring_request_1',
        sessionId: 'session-1',
        phrase: ' ПРАЙС ',
        normalizedPhrase: 'прайс',
        content: { text: '**Ответ**', textFormat: 'markdown', images: [], buttons: [] },
      }),
    ).resolves.toEqual({ ruleId: 'rule-1', contentRevisionId: 'content-1', version: 1 });

    expect(fixture.tx.publisherAutoReplyRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        phrase: 'ПРАЙС',
        normalizedPhrase: 'прайс',
        enabled: false,
        archivedAt: expect.any(Date),
      }),
      select: { id: true, version: true },
    });
    expect(fixture.tx.publisherEntitySettings.upsert).not.toHaveBeenCalled();
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CREATE_PUBLISHER_AUTO_REPLY_DRAFT',
        payload: expect.objectContaining({
          ruleId: 'rule-1',
          sessionId: 'session-1',
          phrase: { length: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        }),
      }),
    });
  });

  it('returns a version conflict before writing mutation or audit records', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    fixture.tx.publisherAutoReplyRule.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.update('chat-1', 'rule-1', user, {
        requestId: 'request_update_1',
        expectedVersion: 1,
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(fixture.tx.publisherAutoReplyMutationRecord.create).not.toHaveBeenCalled();
    expect(fixture.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent active-phrase uniqueness violation to a focused conflict', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    fixture.prisma.$transaction.mockRejectedValue({ code: 'P2002' });

    await expect(
      fixture.service.create('chat-1', user, {
        requestId: 'request_create_3',
        phrase: 'Прайс',
        content: { text: 'Ответ' },
      }),
    ).rejects.toMatchObject({
      response: { code: 'PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT' },
    });
  });

  it('rejects retained assets outside the exact Publisher chat', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    fixture.tx.publisherAutoReplyAsset.findFirst.mockResolvedValue(null);

    await expect(
      fixture.service.persistPreparedContentRevision(fixture.tx as never, {
        ruleId: 'rule-1',
        chatId: 'chat-1',
        revision: 2,
        actorUserId: user.userId,
        content: {
          text: '',
          textFormat: 'plain',
          buttons: [],
          images: [{ kind: 'reference', assetId: 'foreign-asset' }],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.tx.publisherAutoReplyAsset.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-asset', chatId: 'chat-1' },
      select: { id: true, sha256: true, mimeType: true, sizeBytes: true },
    });
  });

  it('scopes image previews through both chat access and rule content ownership', async () => {
    const fixture = createFixture();
    fixture.prisma.publisherAutoReplyAsset.findFirst.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: 'image/png',
    });

    await expect(fixture.service.getAsset('chat-1', 'rule-1', 'asset-1', user)).resolves.toEqual({
      bytes: Buffer.from([1, 2, 3]),
      mimeType: 'image/png',
    });
    expect(fixture.prisma.publisherAutoReplyAsset.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-1',
        chatId: 'chat-1',
        contentLinks: { some: { contentRevision: { ruleId: 'rule-1' } } },
      },
      select: { bytes: true, mimeType: true },
    });
  });

  it('rejects reuse of a request id for a different payload', async () => {
    const fixture = createFixture();
    fixture.prisma.publisherAutoReplyMutationRecord.findUnique.mockResolvedValue({
      ruleId: 'rule-1',
      requestHash: 'different-hash',
    });

    await expect(
      fixture.service.update('chat-1', 'rule-1', user, {
        requestId: 'request_update_2',
        expectedVersion: 1,
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });
});
