import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { managedEntityHeaderSchema } from '@maxim/contracts/managed-entities';
import { NetworkSettingsMetadataService } from './network-settings-metadata.service';
import { NetworkAuthorizationService } from './network-authorization.service';
import type { ManagedEntityNetworksService } from './managed-entity-networks.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { MaxClientService } from '../max/max-client.service';
import type { AdminSettingsService } from './admin-settings.service';
import type { PrismaService } from '../prisma/prisma.service';
const user = { userId: 'metadata-actor', username: null, displayName: null };
function fixture() {
  const selection = jest
    .fn<
      ReturnType<ManagedEntityNetworksService['resolveSelection']>,
      Parameters<ManagedEntityNetworksService['resolveSelection']>
    >()
    .mockResolvedValue({ entityIds: ['a', 'b', 'c'], compositionVersion: 'v1', label: 'Важное' });
  const access = jest
    .fn<
      ReturnType<ManagedEntitiesService['assertManagedEntityReadAccess']>,
      Parameters<ManagedEntitiesService['assertManagedEntityReadAccess']>
    >()
    .mockResolvedValue(undefined);
  const epochs = jest
    .fn<
      ReturnType<NetworkAuthorizationService['readEpochs']>,
      Parameters<NetworkAuthorizationService['readEpochs']>
    >()
    .mockImplementation(async (_g, ids) => new Map(ids.map((id) => [id, 'epoch-1'])));
  const page = jest
    .fn<
      ReturnType<MaxClientService['getChatAdminMembersPage']>,
      Parameters<MaxClientService['getChatAdminMembersPage']>
    >()
    .mockResolvedValue({
      members: [
        {
          userId: 'human_bot',
          displayName: 'Human',
          username: 'human_bot',
          profileUrl: 'https://max.ru/human_bot',
          avatarUrl: null,
          isBot: false,
        },
        {
          userId: 'unknown',
          displayName: 'Unknown',
          username: 'unknown',
          profileUrl: 'https://max.ru/unknown',
          avatarUrl: null,
          isBot: null,
        },
        {
          userId: 'machine',
          displayName: 'Bot',
          username: 'machine',
          profileUrl: 'https://max.ru/machine',
          avatarUrl: null,
          isBot: true,
        },
      ],
      complete: false,
    });
  const resolver = jest
    .fn<
      ReturnType<AdminSettingsService['resolveRequiredSubscriptionChannelReference']>,
      Parameters<AdminSettingsService['resolveRequiredSubscriptionChannelReference']>
    >()
    .mockResolvedValue(
      managedEntityHeaderSchema.parse({
        id: 'required',
        title: 'Required',
        entityType: 'channel',
        link: 'https://max.ru/required',
        participantsCount: null,
      }),
    );
  const networks = { resolveSelection: selection } satisfies Pick<
    ManagedEntityNetworksService,
    'resolveSelection'
  >;
  const managed = {
    assertManagedEntityReadAccess: access,
    resolveManagedEntityReadBotId: async () => 'bot',
  } satisfies Pick<
    ManagedEntitiesService,
    'assertManagedEntityReadAccess' | 'resolveManagedEntityReadBotId'
  >;
  const authorization = {
    acquireSlot: async () => () => undefined,
    readEpochs: epochs,
  } satisfies Pick<NetworkAuthorizationService, 'acquireSlot' | 'readEpochs'>;
  const max = { getChatAdminMembersPage: page } satisfies Pick<
    MaxClientService,
    'getChatAdminMembersPage'
  >;
  const settings = {
    resolveRequiredSubscriptionChannelReference: resolver,
    resolveLocalChatUserProfiles: async () => new Map(),
  } satisfies Pick<
    AdminSettingsService,
    'resolveRequiredSubscriptionChannelReference' | 'resolveLocalChatUserProfiles'
  >;
  const service = new NetworkSettingsMetadataService(
    networks,
    managed,
    authorization,
    max,
    settings,
  );
  const scope = {
    entityType: 'chat',
    target: { mode: 'category', favoriteType: 'important' },
    section: 'links',
    compositionVersion: 'v1',
    requestId: randomUUID(),
  } as const;
  return { service, selection, access, epochs, page, resolver, scope };
}
describe('source-free network metadata', () => {
  it('scans two sources progressively, preserves incomplete coverage, and never treats unknown bots as humans', async () => {
    const f = fixture();
    const first = await f.service.readAdminContacts(user, f.scope);
    expect(first.scannedSources).toBe(2);
    expect(first.nextCursor).toBe(first.sessionId);
    expect(first.items).toEqual([
      expect.objectContaining({ userId: 'human_bot', sources: ['a', 'b'] }),
    ]);
    const last = await f.service.readAdminContacts(user, { ...f.scope, cursor: first.nextCursor });
    expect(last.scannedSources).toBe(3);
    expect(last.nextCursor).toBeNull();
    expect(last.complete).toBe(false);
    expect(last.incompleteSources).toEqual(['a', 'b', 'c']);
    expect(f.page).toHaveBeenCalledTimes(3);
  });
  it('binds contact sessions to actor, request, section and composition', async () => {
    const f = fixture();
    const first = await f.service.readAdminContacts(user, f.scope);
    for (const request of [
      { ...f.scope, requestId: randomUUID() },
      { ...f.scope, section: 'phones' },
      { ...f.scope, compositionVersion: 'v2' },
    ])
      await expect(
        f.service.readAdminContacts(user, { ...request, cursor: first.sessionId }),
      ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      f.service.readAdminContacts(
        { ...user, userId: 'other' },
        { ...f.scope, cursor: first.sessionId },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.page).toHaveBeenCalledTimes(2);
  });
  it('revalidates explicit human provenance before accepting a selected contact', async () => {
    const f = fixture();
    const first = await f.service.readAdminContacts(user, f.scope);
    const selected = await f.service.resolveAdminContact(user, {
      ...f.scope,
      cursor: first.sessionId,
      sourceEntityId: 'a',
      userId: 'human_bot',
    });
    expect(selected.contact.userId).toBe('human_bot');
    f.page.mockResolvedValueOnce({ members: [], complete: true });
    await expect(
      f.service.resolveAdminContact(user, {
        ...f.scope,
        cursor: first.sessionId,
        sourceEntityId: 'a',
        userId: 'human_bot',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects a denial epoch that changes after a subscription lookup and tries another bounded witness', async () => {
    const f = fixture();
    f.access.mockRejectedValueOnce(new ForbiddenException());
    f.epochs.mockImplementation(
      async (_g, ids, fresh) => new Map(ids.map((id) => [id, fresh ? 'epoch-1' : 'epoch-2'])),
    );
    await expect(
      f.service.resolveRequiredSubscription(user, {
        ...f.scope,
        section: 'requiredSubscription',
        value: 'https://max.ru/required',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.access.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
    expect(f.resolver).toHaveBeenCalledTimes(1);
  });
  it('shares two FIFO admission reservations with statistics and releases each only once', async () => {
    const prisma = {
      $queryRaw: jest.fn<never, Parameters<PrismaService['$queryRaw']>>(() => {
        throw new Error('FIFO admission must not query the database.');
      }),
    } satisfies Pick<PrismaService, '$queryRaw'>;
    const pool = new NetworkAuthorizationService(prisma);
    const a = await pool.acquireSlot();
    const b = await pool.acquireSlot();
    const order: number[] = [];
    const third = pool.acquireSlot().then((release) => {
      order.push(3);
      return release;
    });
    const fourth = pool.acquireSlot().then((release) => {
      order.push(4);
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    a();
    a();
    const c = await third;
    expect(order).toEqual([3]);
    b();
    const d = await fourth;
    expect(order).toEqual([3, 4]);
    c();
    d();
  });
});
