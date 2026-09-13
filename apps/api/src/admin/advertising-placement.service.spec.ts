import { ConfigService } from '@nestjs/config';
import { AdvertisingPlacementService } from './advertising-placement.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { AdvertisingPlacement, AdvertisingPlacementSend } from '../prisma/prisma-client';
import type { MaxClientService, MaxActionDispatchOptions } from '../max/max-client.service';

const pilot: AuthUser = { userId: '323459159', username: null, displayName: null };
const listingId = '10000000-0000-4000-8000-000000000001';
const sendId = '20000000-0000-4000-8000-000000000001';
const nextId = '20000000-0000-4000-8000-000000000002';
const chatId = '-100';
const listing = {
  id: listingId,
  chatId,
  title: 'Synthetic',
  url: `https://max.ru/id613000037577_3_bot?startapp=listing_${listingId}`,
};
const lookup = {
  listing,
  connectUrl: 'https://max.ru/id613000037577_3_bot?startapp=connect_chat_-100',
};

function fixture() {
  let settings: AdvertisingPlacement | null = {
    chatId,
    listingId,
    enabled: true,
    revision: 1,
    lastSendId: null,
    updatedAt: new Date(),
  };
  const sends = new Map<string, AdvertisingPlacementSend>();
  const entities = { assertChatAdminAccess: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    advertisingPlacement: {
      findUnique: jest.fn(async () => settings),
      upsert: jest.fn(
        async () =>
          (settings ??= {
            chatId,
            enabled: false,
            listingId: null,
            revision: 0,
            lastSendId: null,
            updatedAt: new Date(),
          }),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { revision: number };
          data: { enabled: boolean; listingId: string | null };
        }) => {
          if (!settings || settings.revision !== where.revision) return { count: 0 };
          settings = { ...settings, ...data, revision: settings.revision + 1 };
          return { count: 1 };
        },
      ),
      update: jest.fn(async ({ data }: { data: { lastSendId: string } }) => {
        settings = { ...settings!, ...data };
        return settings;
      }),
    },
    advertisingPlacementSend: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => sends.get(where.id) ?? null,
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<AdvertisingPlacementSend, 'status' | 'remoteMessageId' | 'createdAt'>;
        }) => {
          const row = { ...data, status: 'SENDING', remoteMessageId: null, createdAt: new Date() };
          sends.set(row.id, row);
          return row;
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<AdvertisingPlacementSend>;
        }) => {
          const row = { ...sends.get(where.id)!, ...data };
          sends.set(row.id, row);
          return row;
        },
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  let transaction = Promise.resolve();
  const prisma = {
    ...tx,
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => {
      const pending = transaction.then(() => fn(tx));
      transaction = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
  const max = {
    sendMessage: jest.fn(
      async (
        _chat: string,
        _text: string,
        _options: unknown,
        options: MaxActionDispatchOptions,
      ) => {
        await options.beforeImmediateSendMutation?.();
        return { messageId: 'receipt' };
      },
    ),
  };
  const config = { get: jest.fn(() => 'a'.repeat(64)) };
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(lookup)));
  const service = new AdvertisingPlacementService(
    prisma as unknown as PrismaService,
    entities as unknown as ManagedEntitiesService,
    max as unknown as MaxClientService,
    config as unknown as ConfigService,
  );
  return {
    service,
    tx,
    max,
    entities,
    config,
    fetcher,
    sends,
    setSettings: (value: AdvertisingPlacement | null) => {
      settings = value;
    },
    settings: () => settings!,
    input: { requestId: sendId, revision: 1, previousSendId: null },
  };
}

afterEach(() => jest.restoreAllMocks());

it('exposes a replaced listing as an outdated binding until explicitly rebound', async () => {
  const f = fixture();
  f.setSettings({ ...f.settings(), listingId: '10000000-0000-4000-8000-000000000002' });
  expect(await f.service.state(chatId, pilot)).toMatchObject({
    enabled: true,
    bindingCurrent: false,
  });
  await expect(f.service.send(chatId, pilot, f.input)).rejects.toThrow('изменились');
  const state = await f.service.update(chatId, pilot, { enabled: true, revision: 1 });
  expect(state).toMatchObject({ enabled: true, bindingCurrent: true, revision: 2 });
});

it('denies nonpilot identities on every operation before chat, database or external access', async () => {
  const f = fixture();
  const user = { ...pilot, userId: '777' };
  expect(f.service.isPilot(user)).toBe(false);
  expect(f.service.isPilot(pilot)).toBe(true);
  await expect(f.service.state(chatId, user)).rejects.toThrow('недоступен');
  await expect(f.service.update(chatId, user, {})).rejects.toThrow('недоступен');
  await expect(f.service.send(chatId, user, {})).rejects.toThrow('недоступен');
  expect(f.entities.assertChatAdminAccess).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.max.sendMessage).not.toHaveBeenCalled();
});

it('requires current chat admin access and rejects malformed/private chat IDs', async () => {
  const f = fixture();
  await expect(f.service.state('100', pilot)).rejects.toThrow();
  f.entities.assertChatAdminAccess.mockRejectedValue(new Error('admin denied'));
  await expect(f.service.send(chatId, pilot, f.input)).rejects.toThrow('admin denied');
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('binds lookup to the exact chat and trusted listing URL; upstream failure is not absence', async () => {
  const f = fixture();
  const state = await f.service.state(chatId, pilot);
  expect(state.listing).toEqual(listing);
  expect(f.fetcher).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      redirect: 'error',
      headers: { authorization: `Major ${'a'.repeat(64)}` },
    }),
  );
  for (const bad of [
    { ...lookup, listing: { ...listing, chatId: '-101' } },
    { ...lookup, listing: { ...listing, url: 'https://evil.example/' } },
    { ...lookup, connectUrl: 'https://evil.example' },
  ]) {
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify(bad)));
    expect((await f.service.state(chatId, pilot)).lookupFailed).toBe(true);
    await expect(f.service.send(chatId, pilot, f.input)).rejects.toThrow('проверить');
  }
  expect(f.tx.advertisingPlacementSend.create).not.toHaveBeenCalled();
});

it('can disable during lookup outage, but cannot enable without a current active listing', async () => {
  const f = fixture();
  f.fetcher.mockRejectedValue(new Error('network'));
  await f.service.update(chatId, pilot, { enabled: false, revision: 1 });
  expect(f.settings().enabled).toBe(false);
  await expect(f.service.update(chatId, pilot, { enabled: true, revision: 2 })).rejects.toThrow();
  f.fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ ...lookup, listing: null })),
  );
  await expect(f.service.update(chatId, pilot, { enabled: true, revision: 2 })).rejects.toThrow(
    'подключите',
  );
});

it('uses durable intent and exact listing button with immediate, guarded, idempotent transport', async () => {
  const f = fixture();
  const sent = await f.service.send(chatId, pilot, f.input);
  expect(sent.status).toBe('SENT');
  expect(f.sends.get(sendId)?.remoteMessageId).toBe('receipt');
  expect(f.max.sendMessage).toHaveBeenCalledWith(
    chatId,
    expect.any(String),
    { buttons: [[{ type: 'link', text: 'Рекламная площадка', url: listing.url }]] },
    expect.objectContaining({
      immediate: true,
      trafficClass: 'interactive',
      idempotencyKey: `advertising-placement:${sendId}`,
    }),
  );
  expect(f.entities.assertChatAdminAccess).toHaveBeenCalledTimes(2);
  await f.service.send(chatId, pilot, f.input);
  expect(f.max.sendMessage).toHaveBeenCalledTimes(1);
});

it('serializes duplicate concurrent requests and rejects stale tabs with different IDs', async () => {
  const f = fixture();
  await Promise.all([
    f.service.send(chatId, pilot, f.input),
    f.service.send(chatId, pilot, f.input),
  ]);
  expect(f.max.sendMessage).toHaveBeenCalledTimes(1);
  await expect(f.service.send(chatId, pilot, { ...f.input, requestId: nextId })).rejects.toThrow(
    'изменились',
  );
  expect(f.max.sendMessage).toHaveBeenCalledTimes(1);
});

it.each(['disable', 'revoke', 'listing'] as const)(
  'fences %s after claim and before MAX HTTP',
  async (change) => {
    const f = fixture();
    f.max.sendMessage.mockImplementation(async (_chat, _text, _options, options) => {
      if (change === 'disable') f.setSettings({ ...f.settings(), enabled: false, revision: 2 });
      if (change === 'revoke')
        f.entities.assertChatAdminAccess.mockRejectedValue(new Error('revoked'));
      if (change === 'listing')
        f.fetcher.mockImplementation(
          async () => new Response(JSON.stringify({ ...lookup, listing: null })),
        );
      await options.beforeImmediateSendMutation?.();
      throw new Error('must not reach HTTP');
    });
    expect((await f.service.send(chatId, pilot, f.input)).status).toBe('FAILED');
    await f.service.send(chatId, pilot, f.input).catch(() => undefined);
    expect(f.max.sendMessage).toHaveBeenCalledTimes(1);
  },
);

it('never retries after dispatch uncertainty, including loss of the database receipt write', async () => {
  const f = fixture();
  f.max.sendMessage.mockImplementation(async (_chat, _text, _options, options) => {
    await options.beforeImmediateSendMutation?.();
    throw new Error('timeout');
  });
  expect((await f.service.send(chatId, pilot, f.input)).status).toBe('UNCERTAIN');
  await f.service.send(chatId, pilot, f.input);
  await expect(
    f.service.send(chatId, pilot, { ...f.input, requestId: nextId, previousSendId: sendId }),
  ).rejects.toThrow('проверьте');
  expect(f.max.sendMessage).toHaveBeenCalledTimes(1);
});

it('retains uncertain intent if MAX succeeded but final database write failed', async () => {
  const f = fixture();
  f.tx.advertisingPlacementSend.update.mockRejectedValueOnce(new Error('database down'));
  await expect(f.service.send(chatId, pilot, f.input)).rejects.toThrow('database down');
  f.sends.get(sendId)!.createdAt = new Date(Date.now() - 100_000);
  expect((await f.service.send(chatId, pilot, f.input)).status).toBe('UNCERTAIN');
  expect(f.max.sendMessage).toHaveBeenCalledTimes(1);
});
