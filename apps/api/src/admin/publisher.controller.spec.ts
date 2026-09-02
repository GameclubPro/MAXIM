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
      [PublisherController.prototype.createPostImport, 'post-imports', RequestMethod.POST],
      [PublisherController.prototype.getPostImport, 'post-imports', RequestMethod.GET],
      [PublisherController.prototype.getActivePostImport, 'post-imports/active', RequestMethod.GET],
      [
        PublisherController.prototype.getPostImportByToken,
        'post-imports/by-token/:startToken',
        RequestMethod.GET,
      ],
      [PublisherController.prototype.cancelPostImport, 'post-imports', RequestMethod.DELETE],
      [
        PublisherController.prototype.listAutoReplies,
        'entities/chat/:entityId/auto-replies',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.getAutoReply,
        'entities/chat/:entityId/auto-replies/:ruleId',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.previewAutoReplyMatch,
        'entities/chat/:entityId/auto-replies/match-preview',
        RequestMethod.POST,
      ],
      [
        PublisherController.prototype.createAutoReply,
        'entities/chat/:entityId/auto-replies',
        RequestMethod.POST,
      ],
      [
        PublisherController.prototype.updateAutoReply,
        'entities/chat/:entityId/auto-replies/:ruleId',
        RequestMethod.PATCH,
      ],
      [
        PublisherController.prototype.archiveAutoReply,
        'entities/chat/:entityId/auto-replies/:ruleId',
        RequestMethod.DELETE,
      ],
      [
        PublisherController.prototype.createAutoReplyAuthoringSession,
        'entities/chat/:entityId/auto-replies/authoring-sessions',
        RequestMethod.POST,
      ],
      [
        PublisherController.prototype.getCurrentAutoReplyAuthoringSession,
        'entities/chat/:entityId/auto-replies/authoring-sessions/current',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.cancelCurrentAutoReplyAuthoringSession,
        'entities/chat/:entityId/auto-replies/authoring-sessions/current',
        RequestMethod.DELETE,
      ],
      [
        PublisherController.prototype.getPostImportAsset,
        'post-imports/:sessionId/assets/:assetId',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.listSuggestions,
        'entities/channel/:entityId/suggestions',
        RequestMethod.GET,
      ],
      [
        PublisherController.prototype.reviewSuggestion,
        'entities/channel/:entityId/suggestions/:suggestionId/review',
        RequestMethod.POST,
      ],
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
        PublisherController.prototype.updateModules,
        'entities/:entityType/:entityId/modules',
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

  it('keeps the catalog publisher-only and exposes only exact policy handlers to moderation', () => {
    expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController)).toEqual([
      'publisher',
    ]);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.updatePolicy),
    ).toEqual(['moderation']);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.getPolicy),
    ).toEqual(['moderation']);
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.updateModules),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherController.prototype.refreshEntity),
    ).toBeUndefined();
  });

  it('normalizes entity types before routing reads and writes to the policy service', async () => {
    const policy = {
      publikEnabled: true,
      revision: 1,
      updatedAt: '2026-08-26T10:00:00.000Z',
    };
    const moduleSettings = {
      revision: 2,
      chatComments: null,
      autoRepliesEnabled: null,
      channelSuggestionsEnabled: true,
    };
    const policyService = {
      listEntities: jest.fn().mockResolvedValue({ items: [] }),
      getEntity: jest.fn().mockResolvedValue({ id: 'channel-1', policy }),
      getPolicyForModeration: jest.fn().mockResolvedValue(policy),
      updatePolicy: jest.fn().mockResolvedValue(policy),
      updateModuleSettings: jest.fn().mockResolvedValue(moduleSettings),
      resolveEntities: jest.fn().mockResolvedValue({ items: [] }),
    };
    const entityRefreshService = {
      requestRefresh: jest.fn().mockResolvedValue({ accepted: true }),
      requestBulkRefresh: jest.fn().mockResolvedValue({ accepted: true, queuedCount: 2 }),
    };
    const suggestionService = {
      list: jest.fn().mockResolvedValue({ items: [] }),
      review: jest.fn().mockResolvedValue({ suggestion: { id: 'suggestion-1' } }),
    };
    const postImportService = {};
    const autoReplyService = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      get: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      create: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      update: jest.fn().mockResolvedValue({ id: 'rule-1', version: 2 }),
      archive: jest.fn().mockResolvedValue({ id: 'rule-1', archived: true }),
      previewMatch: jest.fn().mockResolvedValue({ outcome: 'no_match', selected: null }),
    };
    const autoReplyAuthoringService = {
      create: jest
        .fn()
        .mockResolvedValue({ session: { id: 'session-1' }, botUrl: 'https://max.ru' }),
      getCurrent: jest.fn().mockResolvedValue({ session: { id: 'session-1' }, botUrl: null }),
      cancelCurrent: jest.fn().mockResolvedValue({ session: { id: 'session-1' }, botUrl: null }),
    };
    const controller = new PublisherController(
      policyService as never,
      entityRefreshService as never,
      suggestionService as never,
      postImportService as never,
      autoReplyService as never,
      autoReplyAuthoringService as never,
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
    await expect(controller.getPolicy('channel', 'channel-1', user)).resolves.toEqual(policy);
    await expect(controller.updatePolicy('chat', 'chat-1', user, body)).resolves.toEqual(policy);
    const publisherBody = { expectedRevision: 2, channelSuggestionsEnabled: true };
    await expect(
      controller.updateModules('channel', 'channel-1', user, publisherBody),
    ).resolves.toEqual(moduleSettings);
    await expect(controller.listSuggestions('channel-1', user)).resolves.toEqual({ items: [] });
    await expect(
      controller.reviewSuggestion('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({ suggestion: { id: 'suggestion-1' } });
    await expect(controller.refreshEntity('chat', 'chat-1', user)).resolves.toEqual({
      accepted: true,
    });
    await expect(controller.listAutoReplies('chat-1', user)).resolves.toEqual({
      items: [],
      total: 0,
    });
    await expect(controller.getAutoReply('chat-1', 'rule-1', user)).resolves.toEqual({
      id: 'rule-1',
    });
    const autoReplyBody = { requestId: 'request_123', phrase: 'Прайс', content: { text: 'Да' } };
    await controller.createAutoReply('chat-1', user, autoReplyBody);
    await controller.updateAutoReply('chat-1', 'rule-1', user, autoReplyBody);
    await controller.archiveAutoReply('chat-1', 'rule-1', user, autoReplyBody);
    await expect(
      controller.previewAutoReplyMatch('chat-1', user, { message: 'прайс' }, '2'),
    ).resolves.toEqual({ outcome: 'no_match', selected: null });

    expect(policyService.listEntities).toHaveBeenCalledWith(user, listQuery);
    expect(policyService.resolveEntities).toHaveBeenCalledWith(user, resolveBody);
    expect(entityRefreshService.requestBulkRefresh).toHaveBeenCalledWith(user);
    expect(policyService.getEntity).toHaveBeenCalledTimes(1);
    expect(policyService.getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(policyService.getPolicyForModeration).toHaveBeenCalledTimes(1);
    expect(policyService.getPolicyForModeration).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(policyService.updatePolicy).toHaveBeenCalledWith('chat', 'chat-1', user, body);
    expect(policyService.updateModuleSettings).toHaveBeenCalledWith(
      'channel',
      'channel-1',
      user,
      publisherBody,
    );
    expect(suggestionService.list).toHaveBeenCalledWith('channel-1', user, undefined);
    expect(suggestionService.review).toHaveBeenCalledWith('channel-1', 'suggestion-1', user, {
      action: 'publish',
    });
    expect(entityRefreshService.requestRefresh).toHaveBeenCalledWith('chat', 'chat-1', user);
    expect(autoReplyService.list).toHaveBeenCalledWith('chat-1', user, 1);
    expect(autoReplyService.get).toHaveBeenCalledWith('chat-1', 'rule-1', user, 1);
    expect(autoReplyService.create).toHaveBeenCalledWith('chat-1', user, autoReplyBody, 1);
    expect(autoReplyService.update).toHaveBeenCalledWith(
      'chat-1',
      'rule-1',
      user,
      autoReplyBody,
      1,
    );
    expect(autoReplyService.archive).toHaveBeenCalledWith('chat-1', 'rule-1', user, autoReplyBody);
    expect(autoReplyService.previewMatch).toHaveBeenCalledWith('chat-1', user, {
      message: 'прайс',
    });
    await controller.createAutoReplyAuthoringSession('chat-1', user, autoReplyBody);
    await controller.getCurrentAutoReplyAuthoringSession('chat-1', user);
    await controller.cancelCurrentAutoReplyAuthoringSession('chat-1', user);
    expect(policyService.getEntity).toHaveBeenCalledWith('chat', 'chat-1', user);
    expect(autoReplyAuthoringService.create).toHaveBeenCalledWith(user, 'chat-1', autoReplyBody);
    expect(autoReplyAuthoringService.getCurrent).toHaveBeenCalledWith(user, 'chat-1');
    expect(autoReplyAuthoringService.cancelCurrent).toHaveBeenCalledWith(user, 'chat-1');
  });

  it('rejects unsupported entity types before calling the policy service', () => {
    const policyService = {
      getEntity: jest.fn(),
      updatePolicy: jest.fn(),
      updateModuleSettings: jest.fn(),
    };
    const entityRefreshService = { requestRefresh: jest.fn() };
    const suggestionService = { list: jest.fn(), review: jest.fn() };
    const postImportService = {};
    const autoReplyService = {};
    const controller = new PublisherController(
      policyService as never,
      entityRefreshService as never,
      suggestionService as never,
      postImportService as never,
      autoReplyService as never,
      {} as never,
    );

    expect(() => controller.getEntity('group', 'group-1', user)).toThrow(BadRequestException);
    expect(() =>
      controller.updatePolicy('group', 'group-1', user, {
        expectedRevision: 0,
        publikEnabled: true,
      }),
    ).toThrow(BadRequestException);
    expect(() => controller.refreshEntity('group', 'group-1', user)).toThrow(BadRequestException);
    expect(() => controller.listAutoReplies('chat-1', user, '3')).toThrow(BadRequestException);
    expect(() => controller.previewAutoReplyMatch('chat-1', user, { message: 'test' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      controller.updateModules('group', 'group-1', user, {
        expectedRevision: 0,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: true,
          commentsChatBroadcastsEnabled: false,
        },
      }),
    ).toThrow(BadRequestException);
    expect(policyService.getEntity).not.toHaveBeenCalled();
    expect(policyService.updatePolicy).not.toHaveBeenCalled();
    expect(policyService.updateModuleSettings).not.toHaveBeenCalled();
    expect(entityRefreshService.requestRefresh).not.toHaveBeenCalled();
  });
});
