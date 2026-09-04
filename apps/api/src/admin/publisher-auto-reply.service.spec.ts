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

function triggerRow(
  position = 0,
  phrase = 'ПРАЙС',
  normalizedPhrase = 'прайс',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: position === 0 ? 'primary:rule-1' : `trigger-${position}`,
    chatId: 'chat-1',
    ruleId: 'rule-1',
    position,
    phrase,
    normalizedPhrase,
    archivedAt: null,
    createdAt: now,
    ...overrides,
  };
}

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    chatId: 'chat-1',
    phrase: 'ПРАЙС',
    normalizedPhrase: 'прайс',
    matchInContext: false,
    fuzzyMatch: false,
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
    triggers: [triggerRow()],
    ...overrides,
  };
}

function createFixture(
  options: {
    moduleEnabled?: boolean;
    extendedMatchingMode?: 'off' | 'shadow' | 'on';
  } = {},
) {
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
    publisherAutoReplyTrigger: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publisherAutoReplyMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    publisherEntitySettings: {
      upsert: jest
        .fn()
        .mockImplementation(async (args: { select?: Record<string, unknown> }) =>
          args.select?.autoReplyConfigRevision ? { autoReplyConfigRevision: 5 } : { revision: 4 },
        ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    publisherAutoReplyRule: {
      findMany: jest.fn().mockResolvedValue([ruleRow()]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue(ruleRow()),
    },
    publisherAutoReplyAsset: { findFirst: jest.fn() },
    publisherAutoReplyTrigger: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
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
    {
      get: jest.fn((_key: string, fallback: unknown) => options.extendedMatchingMode ?? fallback),
    } as never,
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

    expect(fixture.tx.publisherEntitySettings.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.tx.publisherEntitySettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ autoReplyConfigRevision: { increment: 1 } }),
        select: { autoReplyConfigRevision: true },
      }),
    );
    expect(fixture.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fixture.policy.assertBotCapabilityForFeatureEnablement).toHaveBeenCalledWith(
      'chat',
      'chat-1',
      ['enabled'],
    );
  });

  it('presents ordered phrases and matching modes only through the v2 read contract', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    const advanced = ruleRow({
      matchInContext: true,
      fuzzyMatch: true,
      triggers: [triggerRow(), triggerRow(1, 'Стоимость', 'стоимость')],
    });
    fixture.prisma.publisherAutoReplyRule.findMany.mockResolvedValue([advanced]);
    fixture.prisma.publisherAutoReplyRule.findFirst.mockResolvedValue(advanced);

    const listed = await fixture.service.list('chat-1', user, 2);
    const fetched = await fixture.service.get('chat-1', 'rule-1', user, 2);

    expect(listed).toMatchObject({
      items: [
        expect.objectContaining({
          phrases: ['ПРАЙС', 'Стоимость'],
          matchInContext: true,
          fuzzyMatch: true,
        }),
      ],
      total: 1,
    });
    expect(fetched).toMatchObject({
      phrases: ['ПРАЙС', 'Стоимость'],
      matchInContext: true,
      fuzzyMatch: true,
    });
    expect(listed.items[0]).not.toHaveProperty('phrase');
    expect(fetched).not.toHaveProperty('phrase');
  });

  it('creates a v2 rule with aliases, matching modes, and one config revision bump', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    const joinLink = 'https://max.ru/join/test_invite-token_123';
    fixture.prisma.publisherAutoReplyRule.findFirst.mockResolvedValue(
      ruleRow({
        phrase: 'Каталог',
        normalizedPhrase: 'каталог',
        matchInContext: true,
        fuzzyMatch: true,
        triggers: [triggerRow(0, 'Каталог', 'каталог'), triggerRow(1, 'Стоимость', 'стоимость')],
      }),
    );

    await expect(
      fixture.service.create(
        'chat-1',
        user,
        {
          requestId: 'request_create_v2',
          phrases: [' Каталог ', ' Стоимость '],
          matchInContext: true,
          fuzzyMatch: true,
          content: { text: joinLink },
        },
        2,
      ),
    ).resolves.toMatchObject({
      phrases: ['Каталог', 'Стоимость'],
      matchInContext: true,
      fuzzyMatch: true,
    });

    expect(fixture.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.tx.publisherAutoReplyContentRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ text: joinLink }),
      select: { id: true },
    });
    expect(fixture.tx.publisherAutoReplyTrigger.count).toHaveBeenCalledTimes(2);
    expect(fixture.tx.publisherAutoReplyRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phrase: 'Каталог',
        normalizedPhrase: 'каталог',
        matchInContext: true,
        fuzzyMatch: true,
      }),
      select: { id: true, version: true },
    });
    expect(fixture.tx.publisherAutoReplyTrigger.createMany).toHaveBeenCalledWith({
      data: [
        {
          ruleId: 'rule-1',
          chatId: 'chat-1',
          position: 1,
          phrase: 'Стоимость',
          normalizedPhrase: 'стоимость',
          archivedAt: null,
        },
      ],
    });
    expect(fixture.tx.publisherEntitySettings.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.tx.publisherEntitySettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ select: { autoReplyConfigRevision: true } }),
    );
    expect(fixture.tx.auditLog.create.mock.calls[0]?.[0]?.data?.payload).toMatchObject({
      phrases: [
        { length: 7, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        { length: 9, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      ],
      matchInContext: true,
      fuzzyMatch: true,
    });
  });

  it('atomically replaces v2 aliases and bumps config revision on matching changes', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    const existing = ruleRow();
    const updated = ruleRow({
      phrase: 'Каталог',
      normalizedPhrase: 'каталог',
      matchInContext: true,
      fuzzyMatch: true,
      version: 2,
      triggers: [triggerRow(0, 'Каталог', 'каталог'), triggerRow(1, 'Стоимость', 'стоимость')],
    });
    fixture.prisma.publisherAutoReplyRule.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValue(updated);

    await expect(
      fixture.service.update(
        'chat-1',
        'rule-1',
        user,
        {
          requestId: 'request_update_v2',
          expectedVersion: 1,
          phrases: ['Каталог', 'Стоимость'],
          matchInContext: true,
          fuzzyMatch: true,
        },
        2,
      ),
    ).resolves.toMatchObject({
      version: 2,
      phrases: ['Каталог', 'Стоимость'],
      matchInContext: true,
      fuzzyMatch: true,
    });

    expect(fixture.tx.publisherAutoReplyRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ matchInContext: true, fuzzyMatch: true }),
      }),
    );
    expect(fixture.tx.publisherAutoReplyTrigger.deleteMany).toHaveBeenCalledWith({
      where: { ruleId: 'rule-1', position: { gt: 0 } },
    });
    expect(fixture.tx.publisherAutoReplyRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rule-1' },
        data: { phrase: 'Каталог', normalizedPhrase: 'каталог' },
      }),
    );
    expect(fixture.tx.publisherAutoReplyTrigger.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ position: 1 })] }),
    );
    expect(fixture.tx.publisherEntitySettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ select: { autoReplyConfigRevision: true } }),
    );
  });

  it('previews a draft context match without persisting it', async () => {
    const fixture = createFixture({ moduleEnabled: true });

    await expect(
      fixture.service.previewMatch('chat-1', user, {
        message: 'Подскажите, пожалуйста, прайс сегодня',
        draft: {
          phrases: ['Прайс'],
          matchInContext: true,
          fuzzyMatch: false,
        },
      }),
    ).resolves.toEqual({
      outcome: 'matched',
      selected: {
        ruleId: null,
        phrase: 'Прайс',
        matchKind: 'exact_context',
        distance: 0,
        matchedDraft: true,
      },
    });
    expect(fixture.prisma.publisherAutoReplyTrigger.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        archivedAt: null,
        rule: {
          is: {
            enabled: true,
            archivedAt: null,
            currentContentRevisionId: { not: null },
          },
        },
      },
      orderBy: [{ ruleId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
      take: 201,
      select: {
        id: true,
        ruleId: true,
        position: true,
        phrase: true,
        normalizedPhrase: true,
        rule: { select: { matchInContext: true, fuzzyMatch: true } },
      },
    });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('excludes the edited rule from the bounded preview query', async () => {
    const fixture = createFixture({ moduleEnabled: true });

    await fixture.service.previewMatch('chat-1', user, {
      message: 'Прайс',
      draft: {
        ruleId: 'rule-1',
        phrases: ['Прайс'],
        matchInContext: false,
        fuzzyMatch: false,
      },
    });

    expect(fixture.prisma.publisherAutoReplyTrigger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ruleId: { not: 'rule-1' } }),
        take: 201,
      }),
    );
  });

  it('does not match a draft that will be saved disabled', async () => {
    const fixture = createFixture({ moduleEnabled: true });

    await expect(
      fixture.service.previewMatch('chat-1', user, {
        message: 'Прайс',
        draft: {
          ruleId: 'rule-1',
          phrases: ['Прайс'],
          matchInContext: false,
          fuzzyMatch: false,
          enabled: false,
        },
      }),
    ).resolves.toEqual({ outcome: 'no_match', selected: null });
  });

  it('uses the production exact fallback when a legacy chat exceeds the matcher budget', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    fixture.prisma.publisherAutoReplyTrigger.findMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({
        ...triggerRow(index, `Фраза ${index}`, `фраза ${index}`, {
          id: `trigger-${index}`,
          ruleId: `rule-${index}`,
        }),
        rule: { matchInContext: false, fuzzyMatch: false },
      })),
    );
    fixture.prisma.publisherAutoReplyTrigger.findFirst.mockResolvedValue({
      ...triggerRow(0, 'Прайс', 'прайс', { id: 'trigger-exact', ruleId: 'rule-exact' }),
      rule: { matchInContext: false, fuzzyMatch: false },
    });

    await expect(
      fixture.service.previewMatch('chat-1', user, { message: 'ПРАЙС' }),
    ).resolves.toEqual({
      outcome: 'matched',
      selected: {
        ruleId: 'rule-exact',
        phrase: 'Прайс',
        matchKind: 'exact_full',
        distance: 0,
        matchedDraft: false,
      },
    });
    expect(fixture.prisma.publisherAutoReplyTrigger.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ normalizedPhrase: 'прайс' }),
      }),
    );
  });

  it.each(['off', 'shadow'] as const)(
    'previews only enforced exact matches while extended matching is %s',
    async (extendedMatchingMode) => {
      const fixture = createFixture({ moduleEnabled: true, extendedMatchingMode });
      fixture.prisma.publisherAutoReplyTrigger.findMany.mockResolvedValue([
        {
          ...triggerRow(0, 'Прайс', 'прайс'),
          rule: { matchInContext: true, fuzzyMatch: true },
        },
      ]);

      await expect(
        fixture.service.previewMatch('chat-1', user, { message: 'Подскажите прайс' }),
      ).resolves.toEqual({ outcome: 'no_match', selected: null });
    },
  );

  it.each([
    {
      label: 'all trigger capacity',
      counts: [200, 0],
      phrases: ['Каталог'],
      fuzzyMatch: false,
      code: 'PUBLISHER_AUTO_REPLY_TRIGGER_LIMIT',
    },
    {
      label: 'fuzzy trigger capacity',
      counts: [0, 49],
      phrases: ['Каталог', 'Стоимость'],
      fuzzyMatch: true,
      code: 'PUBLISHER_AUTO_REPLY_FUZZY_TRIGGER_LIMIT',
    },
  ])('rejects v2 create above $label', async ({ counts, phrases, fuzzyMatch, code }) => {
    const fixture = createFixture({ moduleEnabled: true });
    fixture.tx.publisherAutoReplyTrigger.count
      .mockResolvedValueOnce(counts[0])
      .mockResolvedValueOnce(counts[1]);

    await expect(
      fixture.service.create(
        'chat-1',
        user,
        {
          requestId: `request_capacity_${fuzzyMatch ? 'fuzzy' : 'all'}`,
          phrases,
          fuzzyMatch,
          content: { text: 'Ответ' },
        },
        2,
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code }) });

    expect(fixture.tx.publisherAutoReplyRule.create).not.toHaveBeenCalled();
  });

  it('allows an over-capacity legacy rule to reduce its phrase contribution', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    const existing = ruleRow({
      triggers: Array.from({ length: 10 }, (_, index) =>
        triggerRow(index, `Фраза ${index}`, `фраза ${index}`),
      ),
    });
    const updated = ruleRow({ version: 2, triggers: [triggerRow(0, 'Фраза 0', 'фраза 0')] });
    fixture.prisma.publisherAutoReplyRule.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValue(updated);
    fixture.tx.publisherAutoReplyTrigger.count.mockResolvedValueOnce(240).mockResolvedValueOnce(0);

    await expect(
      fixture.service.update(
        'chat-1',
        'rule-1',
        user,
        {
          requestId: 'request_heal_total_capacity',
          expectedVersion: 1,
          phrases: ['Фраза 0'],
        },
        2,
      ),
    ).resolves.toMatchObject({ version: 2, phrases: ['Фраза 0'] });

    expect(fixture.tx.publisherAutoReplyRule.updateMany).toHaveBeenCalledTimes(1);
  });

  it('allows fuzzy mode to be disabled while grandfathered totals remain above both caps', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    const triggers = [triggerRow(), triggerRow(1, 'Стоимость', 'стоимость')];
    const existing = ruleRow({ fuzzyMatch: true, triggers });
    const updated = ruleRow({ version: 2, fuzzyMatch: false, triggers });
    fixture.prisma.publisherAutoReplyRule.findFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValue(updated);
    fixture.tx.publisherAutoReplyTrigger.count.mockResolvedValueOnce(199).mockResolvedValueOnce(55);

    await expect(
      fixture.service.update(
        'chat-1',
        'rule-1',
        user,
        {
          requestId: 'request_heal_fuzzy_capacity',
          expectedVersion: 1,
          fuzzyMatch: false,
        },
        2,
      ),
    ).resolves.toMatchObject({ version: 2, fuzzyMatch: false });

    expect(fixture.tx.publisherAutoReplyRule.updateMany).toHaveBeenCalledTimes(1);
  });

  it('still blocks a non-healing update while a legacy chat remains over capacity', async () => {
    const fixture = createFixture({ moduleEnabled: true });
    const triggers = [triggerRow(), triggerRow(1, 'Стоимость', 'стоимость')];
    fixture.prisma.publisherAutoReplyRule.findFirst.mockResolvedValue(ruleRow({ triggers }));
    fixture.tx.publisherAutoReplyTrigger.count.mockResolvedValueOnce(199).mockResolvedValueOnce(0);

    await expect(
      fixture.service.update(
        'chat-1',
        'rule-1',
        user,
        {
          requestId: 'request_non_healing_capacity',
          expectedVersion: 1,
          phrases: ['Каталог', 'Стоимость'],
        },
        2,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLISHER_AUTO_REPLY_TRIGGER_LIMIT' }),
    });

    expect(fixture.tx.publisherAutoReplyRule.updateMany).not.toHaveBeenCalled();
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
    fixture.prisma.publisherAutoReplyRule.findFirst.mockResolvedValue(ruleRow({ enabled: false }));
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
          phrases: [{ length: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }],
          matchInContext: false,
          fuzzyMatch: false,
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
    fixture.prisma.$transaction.mockRejectedValue({
      code: 'P2002',
      meta: { target: 'publisher_auto_reply_triggers_active_phrase_key' },
    });

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
