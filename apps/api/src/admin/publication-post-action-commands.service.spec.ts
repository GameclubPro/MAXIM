import { ConflictException } from '@nestjs/common';
import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import type { ManagedBroadcastDelivery } from '../prisma/prisma-client';
import {
  buildPublicationPostActionChange,
  PublicationPostActionCommandsService,
} from './publication-post-action-commands.service';
import { PublicationPostActionsController } from './publication-post-actions.controller';
import {
  allowedPublicationPostActions,
  publicationPostActionsVersion,
} from './publication-post-actions';

const now = new Date('2026-09-09T12:00:00Z');
const policy = { pin: 'notify', deleteAfterMinutes: 60 };
const makeRow = (overrides = {}) =>
  ({
    id: 'delivery',
    status: 'SENT',
    botId: 'publik',
    requiredBotId: 'publik',
    targetChatId: 'chat',
    remoteMessageId: 'mid',
    updatedAt: now,
    postActionsToken: null,
    postActionsNextAt: now,
    pinStatus: 'DONE',
    pinAttemptCount: 1,
    deleteStatus: 'PENDING',
    deleteAttemptCount: 0,
    deleteAt: new Date(now.getTime() + 3_600_000),
    deletedAt: null,
    ...overrides,
  }) as ManagedBroadcastDelivery;
const request = { requestId: 'action-request', expectedVersion: '0'.repeat(64) };
const owner = { userId: 'owner', username: null, displayName: null };

describe('publication post-action commands', () => {
  it('keeps the HTTP route Publisher-only', () => {
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublicationPostActionsController),
    ).toEqual(['publisher']);
  });

  it('cancels a pending timer without changing the sent message or pin', () => {
    expect(
      buildPublicationPostActionChange(
        makeRow(),
        { ...request, action: 'cancel_delete' },
        policy,
        now,
      ),
    ).toEqual({
      deleteStatus: 'SKIPPED',
      deleteError: null,
      postActionsToken: null,
      postActionsNextAt: null,
    });
  });

  it('keeps an outstanding pin runnable after timer cancellation', () => {
    expect(
      buildPublicationPostActionChange(
        makeRow({ pinStatus: 'PENDING' }),
        { ...request, action: 'cancel_delete' },
        policy,
        now,
      ),
    ).toMatchObject({ postActionsNextAt: new Date(now.getTime() - 1) });
  });

  it.each([
    { postActionsToken: 'claimed' },
    { pinStatus: 'RUNNING' },
    { deleteStatus: 'RUNNING' },
    { deleteStatus: 'DONE' },
    { status: 'AMBIGUOUS' },
    { remoteMessageId: null },
  ])('rejects unsafe action state %j', (override) => {
    expect(() =>
      buildPublicationPostActionChange(
        makeRow(override),
        { ...request, action: 'cancel_delete' },
        policy,
        now,
      ),
    ).toThrow(ConflictException);
  });

  it('can schedule deletion for an already published post without rewriting its content', () => {
    const deleteAt = new Date(now.getTime() + 60_000);
    expect(
      buildPublicationPostActionChange(
        makeRow({ deleteAt: null, deleteStatus: 'NONE' }),
        { ...request, action: 'reschedule_delete', deleteAt: deleteAt.toISOString() },
        {},
        now,
      ),
    ).toEqual({
      postActionsToken: null,
      postActionsNextAt: deleteAt,
      deleteAt,
      deleteStatus: 'PENDING',
      deleteAttemptCount: 0,
      deleteError: null,
    });
  });

  it.each([-1, 0, 29_999, 31 * 24 * 3_600_000])(
    'rejects invalid future deletion delay %s',
    (offset) => {
      expect(() =>
        buildPublicationPostActionChange(
          makeRow(),
          {
            ...request,
            action: 'reschedule_delete',
            deleteAt: new Date(now.getTime() + offset).toISOString(),
          },
          policy,
          now,
        ),
      ).toThrow();
    },
  );

  it('never offers a blind retry of an ambiguous pin', () => {
    expect(
      allowedPublicationPostActions(makeRow({ pinStatus: 'AMBIGUOUS' }), policy, now.getTime()),
    ).not.toContain('retry_pin');
    expect(
      allowedPublicationPostActions(makeRow({ pinStatus: 'FAILED' }), policy, now.getTime()),
    ).toContain('retry_pin');
    expect(
      allowedPublicationPostActions(makeRow({ pinStatus: 'FAILED' }), {}, now.getTime()),
    ).not.toContain('retry_pin');
  });

  it('versions change even when two updates share a millisecond', () => {
    expect(publicationPostActionsVersion(makeRow())).not.toBe(
      publicationPostActionsVersion(makeRow({ deleteAt: null, deleteStatus: 'SKIPPED' })),
    );
  });

  function setup() {
    const row = {
      ...makeRow(),
      broadcast: { entityType: 'CHAT' },
      contentRevision: { postPublish: policy },
    };
    const records = new Map<string, unknown>();
    const prisma = {
      publication: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'publication', version: 1, requiredBotId: 'publik' }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn(async () => ({ ...row })),
        updateMany: jest.fn(async ({ data }: any) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      publicationMutationRecord: {
        findUnique: jest.fn(
          async ({ where }: any) => records.get(where.actorUserId_requestId.requestId) ?? null,
        ),
        create: jest.fn(async ({ data }: any) => {
          records.set(data.requestId, data);
          return data;
        }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    const access = { getEntity: jest.fn().mockResolvedValue({}) };
    const service = new PublicationPostActionCommandsService(prisma as any, access as any);
    const body = {
      ...request,
      action: 'cancel_delete',
      expectedVersion: publicationPostActionsVersion(row),
    };
    return { row, prisma, access, service, body };
  }

  it('authorizes the exact owner and entity, and replays a lost acknowledgement without repeating the mutation', async () => {
    const { service, body, prisma, access } = setup();
    await service.execute('publication', 'delivery', owner, body);
    await service.execute('publication', 'delivery', owner, body);
    expect(access.getEntity).toHaveBeenCalledWith('chat', 'chat', owner);
    expect(prisma.publication.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'publication', actorUserId: 'owner', dispatchProfile: 'PUBLIK_V1' },
      }),
    );
    expect(prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'SENT',
          postActionsToken: null,
          deleteStatus: 'PENDING',
        }),
      }),
    );
  });

  it('does not mutate another owner publication or a stale version', async () => {
    const { service, body, prisma } = setup();
    await expect(
      service.execute('publication', 'delivery', owner, {
        ...body,
        expectedVersion: 'f'.repeat(64),
      }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    prisma.publication.findFirst.mockResolvedValue(null);
    await expect(
      service.execute('publication', 'delivery', { ...owner, userId: 'other' }, body),
    ).rejects.toThrow('Публикация не найдена');
  });

  it('rejects a worker claim race instead of reporting a false cancellation', async () => {
    const { service, body, prisma } = setup();
    prisma.managedBroadcastDelivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.execute('publication', 'delivery', owner, body)).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.publicationMutationRecord.create).not.toHaveBeenCalled();
  });
});
