import { BadRequestException } from '@nestjs/common';

import { AdminDomainAllowlistRuntime } from './admin-domain-allowlist-runtime';

const ADMIN_USER = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

function createRuntime(rows: Array<{ domain: string; removeAfterAt?: Date | null }> = []) {
  const prisma = {
    domainAllowlist: {
      findMany: jest.fn().mockResolvedValue(
        rows.map((row) => ({
          domain: row.domain,
          removeAfterAt: row.removeAfterAt ?? null,
        })),
      ),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const chatContextCache = {
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const assertChatAdmin = jest.fn().mockResolvedValue(undefined);
  const runtime = new AdminDomainAllowlistRuntime({
    prisma,
    chatContextCache,
    assertChatAdmin,
  } as never);

  return { runtime, prisma, chatContextCache, assertChatAdmin };
}

describe('AdminDomainAllowlistRuntime typed navigation targets', () => {
  it.each([
    {
      kind: 'WEB_DOMAIN',
      input: 'https://Docs.MAX.ru/mini-apps/start',
      target: 'docs.max.ru',
      stored: 'domain:docs.max.ru',
      matchType: 'DOMAIN',
    },
    {
      kind: 'WEB_EXACT',
      input: 'https://Example.com/path',
      target: 'https://example.com/path',
      stored: 'https://example.com/path',
      matchType: 'EXACT',
    },
    {
      kind: 'MAX_PROFILE',
      input: 'max://user/42',
      target: 'user-id:42',
      stored: 'max-profile:user-id%3A42',
      matchType: 'EXACT',
    },
    {
      kind: 'MAX_ENTITY',
      input: 'http://www.max.ru/chats/Team-Room/?utm_source=test',
      target: 'url:https://max.ru/chats/Team-Room',
      stored: 'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fchats%2FTeam-Room',
      matchType: 'EXACT',
    },
    {
      kind: 'MINI_APP',
      input: 'https://max.ru/MajorBot?startapp=chat-settings-42',
      target: 'bot:majorbot',
      stored: 'mini-app:bot%3Amajorbot',
      matchType: 'EXACT',
    },
  ] as const)(
    'canonicalizes and stores a $kind target',
    async ({ kind, input, target, stored, matchType }) => {
      const { runtime, prisma } = createRuntime();

      await runtime.addDomain('chat-1', ADMIN_USER, { domain: input, kind });

      expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
        where: {
          chatId_domain: {
            chatId: 'chat-1',
            domain: stored,
          },
        },
        create: {
          chatId: 'chat-1',
          domain: stored,
        },
        update: {
          removeAfterAt: null,
        },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ADD_DOMAIN',
          payload: {
            domain: target,
            target,
            kind,
            matchType,
            normalizedValue: stored,
            source: 'miniapp',
          },
        }),
      });
    },
  );

  it.each([
    {
      body: { domain: 'docs.max.ru', matchType: 'DOMAIN' },
      stored: 'domain:docs.max.ru',
    },
    {
      body: { domain: 'https://max.ru/news', matchType: 'EXACT' },
      stored: 'https://max.ru/news',
    },
    {
      body: { domain: 'docs.max.ru' },
      stored: 'domain:docs.max.ru',
    },
  ] as const)('preserves legacy request/storage behavior for $stored', async ({ body, stored }) => {
    const { runtime, prisma } = createRuntime();

    await runtime.addDomain('chat-1', ADMIN_USER, body);

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_domain: {
            chatId: 'chat-1',
            domain: stored,
          },
        },
      }),
    );
  });

  it('rejects a new MAX entity rule that only contains an internal chat ID', async () => {
    const { runtime, prisma } = createRuntime();

    await expect(
      runtime.addDomain('chat-1', ADMIN_USER, {
        domain: '-42',
        kind: 'MAX_ENTITY',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.domainAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('returns canonical kind and target metadata for typed and legacy rows', async () => {
    const { runtime, prisma } = createRuntime([
      { domain: 'max-profile:user-id%3A42' },
      { domain: 'max-entity:chat-id%3A-42' },
      { domain: 'mini-app:bot%3Amajorbot' },
      { domain: 'domain:docs.max.ru' },
      { domain: 'https://example.com/path' },
    ]);

    const result = await runtime.getDomainAllowlistDetails('chat-1', ADMIN_USER);

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: 'user-id:42',
          target: 'user-id:42',
          kind: 'MAX_PROFILE',
          matchType: 'EXACT',
          normalizedValue: 'max-profile:user-id%3A42',
        }),
        expect.objectContaining({
          target: 'chat-id:-42',
          kind: 'MAX_ENTITY',
        }),
        expect.objectContaining({
          target: 'bot:majorbot',
          kind: 'MINI_APP',
        }),
        expect.objectContaining({
          target: 'docs.max.ru',
          kind: 'WEB_DOMAIN',
        }),
        expect.objectContaining({
          target: 'https://example.com/path',
          kind: 'WEB_EXACT',
        }),
      ]),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the legacy GET response usable as the legacy DELETE identifier', async () => {
    const stored = 'max-profile:user-id%3A42';
    const { runtime, prisma } = createRuntime([{ domain: stored }]);

    const response = await runtime.getDomainAllowlist('chat-1', ADMIN_USER);
    expect(response).toEqual([stored]);

    await runtime.removeDomain('chat-1', ADMIN_USER, response[0] as string);

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: { in: [stored] },
      },
    });
  });

  it('keeps legacy domain GET values free of typed storage prefixes', async () => {
    const { runtime } = createRuntime([{ domain: 'domain:docs.max.ru' }]);

    await expect(runtime.getDomainAllowlist('chat-1', ADMIN_USER)).resolves.toEqual([
      'docs.max.ru',
    ]);
  });

  it('preserves percent escapes across GET, DELETE, and removal scheduling', async () => {
    const stored = 'https://example.com/a%2Fb?label=hello%20world&literal=%2525';
    const { runtime, prisma } = createRuntime([{ domain: stored }]);

    const response = await runtime.getDomainAllowlistDetails('chat-1', ADMIN_USER);
    expect(response).toEqual([
      expect.objectContaining({ normalizedValue: stored, target: stored }),
    ]);

    await runtime.removeDomain('chat-1', ADMIN_USER, stored);
    await runtime.scheduleDomainRemoval('chat-1', ADMIN_USER, stored, {
      removeAfterAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', domain: { in: [stored] } },
    });
    expect(prisma.domainAllowlist.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1', domain: { in: [stored] } },
      }),
    );
  });
});
