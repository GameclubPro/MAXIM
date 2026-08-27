import { BadRequestException, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import { PublisherController } from './publisher.controller';

describe('PublisherController', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
  };

  it('keeps the public publisher route matrix stable', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublisherController)).toBe('v1/publisher');
    const routes = [
      [PublisherController.prototype.listEntities, 'entities', RequestMethod.GET],
      [PublisherController.prototype.resolveEntities, 'entities/resolve', RequestMethod.POST],
      [PublisherController.prototype.refreshEntities, 'entities/refresh', RequestMethod.POST],
      [
        PublisherController.prototype.getEntity,
        'entities/:entityType/:entityId',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.getPolicy,
        'entities/:entityType/:entityId/policy',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.updatePolicy,
        'entities/:entityType/:entityId/policy',
        RequestMethod.PATCH,
      ],
      [
        PublisherController.prototype.refreshEntity,
        'entities/:entityType/:entityId/refresh',
        RequestMethod.POST,
      ],
    ] as const;

    for (const [handler, path, method] of routes) {
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    }
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, PublisherController.prototype.refreshEntity),
    ).toBe(202);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, PublisherController.prototype.refreshEntities),
    ).toBe(202);
  });

  it('allows both profiles to read publisher state but only moderation to change policy', () => {
    expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController)).toEqual([
      'moderation',
      'publisher',
    ]);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.updatePolicy),
    ).toEqual(['moderation']);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.getPolicy),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.refreshEntity),
    ).toBeUndefined();
  });

  it('normalizes entity types before routing reads and writes to the policy service', async () => {
    const policy = {
      publikEnabled: true,
      suggestionsViaPublik: false,
      revision: 1,
      updatedAt: '2026-08-26T10:00:00.000Z',
    };
    const policyService = {
      listEntities: jest.fn().mockResolvedValue({ items: [] }),
      getEntity: jest.fn().mockResolvedValue({ id: 'channel-1', policy }),
      getEntityForPolicy: jest.fn().mockResolvedValue({ id: 'channel-1', policy }),
      updatePolicy: jest.fn().mockResolvedValue(policy),
      resolveEntities: jest.fn().mockResolvedValue({ items: [] }),
    };
    const entityRefreshService = {
      requestRefresh: jest.fn().mockResolvedValue({ accepted: true }),
      requestBulkRefresh: jest.fn().mockResolvedValue({ accepted: true, queuedCount: 2 }),
    };
    const controller = new PublisherController(
      policyService as never,
      entityRefreshService as never,
    );
    const body = { expectedRevision: 1, publikEnabled: false };
    const listQuery = { pagination: 'cursor', limit: '25' };
    const resolveBody = { targets: [{ id: 'channel-1', entityType: 'channel' }] };

    await expect(controller.listEntities(user, listQuery)).resolves.toEqual({ items: [] });
    await expect(controller.resolveEntities(user, resolveBody)).resolves.toEqual({ items: [] });
    await expect(controller.refreshEntities(user)).resolves.toEqual({
      accepted: true,
      queuedCount: 2,
    });
    await expect(controller.getEntity('channel', 'channel-1', user)).resolves.toMatchObject({
      id: 'channel-1',
    });
    await expect(
      controller.getEntity('channel', 'channel-1', user, 'moderation'),
    ).resolves.toMatchObject({ id: 'channel-1' });
    await expect(controller.getPolicy('channel', 'channel-1', user, 'moderation')).resolves.toEqual(
      policy,
    );
    await expect(controller.updatePolicy('chat', 'chat-1', user, body)).resolves.toEqual(policy);
    await expect(controller.refreshEntity('chat', 'chat-1', user)).resolves.toEqual({
      accepted: true,
    });

    expect(policyService.listEntities).toHaveBeenCalledWith(user, listQuery);
    expect(policyService.resolveEntities).toHaveBeenCalledWith(user, resolveBody);
    expect(entityRefreshService.requestBulkRefresh).toHaveBeenCalledWith(user);
    expect(policyService.getEntity).toHaveBeenCalledTimes(1);
    expect(policyService.getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(policyService.getEntityForPolicy).toHaveBeenNthCalledWith(
      1,
      'channel',
      'channel-1',
      user,
    );
    expect(policyService.getEntityForPolicy).toHaveBeenNthCalledWith(
      2,
      'channel',
      'channel-1',
      user,
    );
    expect(policyService.updatePolicy).toHaveBeenCalledWith('chat', 'chat-1', user, body);
    expect(entityRefreshService.requestRefresh).toHaveBeenCalledWith('chat', 'chat-1', user);
  });

  it('rejects unsupported entity types before calling the policy service', () => {
    const policyService = {
      getEntity: jest.fn(),
      updatePolicy: jest.fn(),
    };
    const entityRefreshService = { requestRefresh: jest.fn() };
    const controller = new PublisherController(
      policyService as never,
      entityRefreshService as never,
    );

    expect(() => controller.getEntity('group', 'group-1', user)).toThrow(BadRequestException);
    expect(() =>
      controller.updatePolicy('group', 'group-1', user, {
        expectedRevision: 0,
        publikEnabled: true,
      }),
    ).toThrow(BadRequestException);
    expect(() => controller.refreshEntity('group', 'group-1', user)).toThrow(BadRequestException);
    expect(policyService.getEntity).not.toHaveBeenCalled();
    expect(policyService.updatePolicy).not.toHaveBeenCalled();
    expect(entityRefreshService.requestRefresh).not.toHaveBeenCalled();
  });
});
