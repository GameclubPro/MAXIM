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
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-1' }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((write: (tx: typeof prisma) => Promise<unknown>) =>
    write(prisma),
  );
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
  it('never writes, removes malformed rows, or invalidates cache while reading legacy entries', async () => {
    const early = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 120_000);
    const { runtime, prisma, chatContextCache } = createRuntime([
      { domain: 'example.com/path', removeAfterAt: early },
      { domain: 'https://example.com/path', removeAfterAt: later },
      { domain: 'invalid' },
      { domain: 'domain:expired.example', removeAfterAt: new Date(0) },
    ]);

    expect(await runtime.getDomainAllowlistDetails('chat-1', ADMIN_USER)).toEqual([
      expect.objectContaining({
        normalizedValue: 'https://example.com/path',
        removeAfterAt: later.toISOString(),
      }),
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.domainAllowlist.upsert).not.toHaveBeenCalled();
    expect(prisma.domainAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('preserves expiry when a request to add an existing rule is retried', async () => {
    const removeAfterAt = new Date(Date.now() + 60_000);
    const { runtime, prisma } = createRuntime([{ domain: 'domain:example.com', removeAfterAt }]);
    await runtime.addDomain('chat-1', ADMIN_USER, { domain: 'example.com', kind: 'WEB_DOMAIN' });
    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { removeAfterAt } }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.domainAllowlist.findMany.mock.invocationCallOrder[0]!,
    );
  });

  it('propagates transaction failures without publishing cache invalidation', async () => {
    const { runtime, prisma, chatContextCache } = createRuntime();
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      runtime.addDomain('chat-1', ADMIN_USER, { domain: 'example.com', kind: 'WEB_DOMAIN' }),
    ).rejects.toThrow('audit unavailable');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('round trips legacy domain identifiers without deleting an exact root rule', async () => {
    const { runtime, prisma } = createRuntime([
      { domain: 'domain:example.com' },
      { domain: 'https://example.com' },
    ]);
    await runtime.removeDomain('chat-1', ADMIN_USER, 'example.com');
    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', domain: { in: ['domain:example.com'] } },
    });
    await runtime.scheduleDomainRemoval('chat-1', ADMIN_USER, 'example.com', {
      removeAfterAt: null,
    });
    expect(prisma.domainAllowlist.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: { in: ['domain:example.com'] },
        OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: expect.any(Date) } }],
      },
      data: { removeAfterAt: null },
    });
    expect(prisma.domainAllowlist.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          chatId: 'chat-1',
          OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: expect.any(Date) } }],
        },
      }),
    );
  });

  it('does not mutate when access or scheduling validation fails', async () => {
    const { runtime, prisma, assertChatAdmin } = createRuntime();
    await expect(
      runtime.scheduleDomainRemoval('chat-1', ADMIN_USER, 'domain:example.com', {
        removeAfterAt: new Date(0).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    assertChatAdmin.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      runtime.addDomain('chat-1', ADMIN_USER, { domain: 'example.com' }),
    ).rejects.toThrow('forbidden');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects adversarial legacy identifiers without a backtracking host expression', async () => {
    const { runtime, prisma } = createRuntime();
    const domain = `${'".'.repeat(50_000)}/`;
    await expect(runtime.removeDomain('chat-1', ADMIN_USER, domain)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not report success or write audit when a rule expires during scheduling', async () => {
    const { runtime, prisma, chatContextCache } = createRuntime([{ domain: 'domain:example.com' }]);
    prisma.domainAllowlist.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      runtime.scheduleDomainRemoval('chat-1', ADMIN_USER, 'example.com', { removeAfterAt: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });

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
        where: expect.objectContaining({ chatId: 'chat-1', domain: { in: [stored] } }),
      }),
    );
  });
});
