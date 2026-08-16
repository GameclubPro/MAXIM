import {
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  ChatEntityType,
  SanctionAction,
  ModerationService,
  MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
  extractSqlText,
  userMention,
  expectImmediateDeleteMessage,
  expectImmediateKickMember,
  expectImmediateBanMember,
  createMaxApiError,
  createSettings,
  createUpdate,
  createRequiredSubscriptionRedisCounter,
  type MaxUpdate,
} from './moderation.service.spec-support';

describe('ModerationService', () => {
  describe('required subscription', () => {
    function createPrismaForRequiredSubscription(
      settingsOverrides: Record<string, unknown> = {},
      adminUserIds: string[] = [],
    ) {
      return {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings(settingsOverrides),
            domains: [],
            admins: adminUserIds.map((userId) => ({ userId })),
            rules: {
              publishedUrl: null,
              publishedMessageId: 'mid-rules-1',
            },
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          upsert: jest.fn(),
        },
        chatRules: {
          update: jest.fn(),
        },
      };
    }

    describe('moderation action fallback', () => {
      it('accepts unified moderation routes when the link service exposes them', async () => {
        const operation = jest.fn().mockResolvedValue(undefined);
        const maxBotLinkService = {
          resolveBotRoutes: jest.fn().mockResolvedValue({
            purpose: 'moderation_action',
            chatId: 'chat-route-1',
            primaryBotId: 'id613002203036_bot',
            botId: 'id613002203036_4_bot',
            candidateBotIds: ['id613002203036_4_bot'],
            reason: 'alternate_confirmed',
            action: 'delete_message',
          }),
        };
        const service = new ModerationService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-route-1',
            action: 'delete_message',
            messageId: 'message-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(maxBotLinkService.resolveBotRoutes).toHaveBeenCalledWith({
          purpose: 'moderation_action',
          chatId: 'chat-route-1',
          action: 'delete_message',
          fallbackToPrimary: true,
        });
        expect(operation).toHaveBeenCalledWith('id613002203036_4_bot');
      });

      it('refreshes bot access snapshots when stale member-moderation snapshots leave no candidates', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(['id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = new ModerationService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'moderate_member',
            userId: 'user-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
          botId: 'id613002203036_4_bot',
          bypassCache: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          timeoutMs: 1_500,
        });
        expect(prisma.chatBotMembership.updateMany).toHaveBeenCalledWith({
          where: {
            chatId: 'chat-1',
            botId: 'id613002203036_4_bot',
          },
          data: expect.objectContaining({
            lastSeenAt: expect.any(Date),
            permissionsSnapshot: expect.objectContaining({
              isAdmin: true,
              isOwner: false,
              permissions: ['add_remove_members'],
            }),
          }),
        });
        expect(operation).toHaveBeenCalledWith('id613002203036_4_bot');
      });

      it('requires read-all plus MAX write permission for refreshed chat delete access', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'write'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(['id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = new ModerationService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            messageId: 'message-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(prisma.chatBotMembership.updateMany).toHaveBeenCalledWith({
          where: {
            chatId: 'chat-1',
            botId: 'id613002203036_4_bot',
          },
          data: expect.objectContaining({
            lastSeenAt: expect.any(Date),
            permissionsSnapshot: expect.objectContaining({
              isAdmin: true,
              isOwner: false,
              permissions: ['read_all_messages', 'write'],
              health: 'ok',
            }),
          }),
        });
        expect(operation).toHaveBeenCalledWith('id613002203036_4_bot');
      });

      it('keeps stale moderation action backoff out of the hot path and schedules a recheck', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['delete_messages'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest.fn().mockResolvedValue(['id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const maxChatAdminRosterSyncService = {
          scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
        };
        const runtimeDiagnosticsService = {
          recordProblemChat: jest.fn().mockResolvedValue(undefined),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = new ModerationService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          runtimeDiagnosticsService as never,
          maxChatAdminRosterSyncService as never,
        );

        await (service as any).rememberModerationActionBotBackoff(
          'chat-1',
          'delete_message',
          'id613002203036_4_bot',
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            messageId: 'msg-1',
            operation,
          }),
        ).resolves.toBe(false);

        expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
        expect(operation).not.toHaveBeenCalled();
        expect(runtimeDiagnosticsService.recordProblemChat).toHaveBeenCalledWith({
          chatId: 'chat-1',
          botId: null,
          category: 'moderation_action_no_candidate',
          severity: 'warning',
          action: 'delete_message',
          statusCode: null,
          reason: 'all candidate bots are temporarily backed off after permission failures',
        });
        expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
          chatId: 'chat-1',
          botIds: [],
          title: null,
          entityType: null,
          source: 'moderation_destructive_path',
          retryUntilMs: null,
        });
        await expect(
          (service as any).isModerationActionBotBackoffActive(
            'chat-1',
            'delete_message',
            'id613002203036_4_bot',
          ),
        ).resolves.toBe(true);
      });

      it('does not wait indefinitely for access-loss cleanup after a terminal moderation error', async () => {
        jest.useFakeTimers();
        const runtimeDiagnosticsService = {
          recordHotPathStageOutcome: jest.fn(),
          recordProblemChat: jest.fn(),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest.fn().mockResolvedValue(['id613002203036_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const managedEntityAccessLossService = {
          recordIfManagedEntityAccessLost: jest.fn(
            () =>
              new Promise(() => {
                // Intentionally never resolves.
              }),
          ),
        };
        const terminalError = createMaxApiError(
          403,
          'Request failed with status code 403',
          'chat.denied',
        );
        const operation = jest.fn().mockRejectedValue(terminalError);
        const service = new ModerationService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          runtimeDiagnosticsService as never,
          undefined,
          undefined,
          managedEntityAccessLossService as never,
        );
        const debugSpy = jest
          .spyOn((service as any).logger, 'debug')
          .mockImplementation(() => undefined);

        try {
          const resultPromise = (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            explicitBotId: 'id613002203036_bot',
            messageId: 'message-1',
            operation,
          });

          await Promise.resolve();
          await Promise.resolve();
          await jest.advanceTimersByTimeAsync(MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS);
          expect(
            managedEntityAccessLossService.recordIfManagedEntityAccessLost,
          ).toHaveBeenCalledWith({
            chatId: 'chat-1',
            botId: 'id613002203036_bot',
            entityType: null,
            source: 'moderation_action:delete_message',
            operation: 'delete',
            error: terminalError,
          });

          await expect(resultPromise).resolves.toBe(false);
          expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
            stage: 'moderation-action-access-loss.deferred',
            outcome: 'skip',
            failOpen: true,
          });
          expect(debugSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              chatId: 'chat-1',
              botId: 'id613002203036_bot',
              action: 'delete_message',
              timeoutMs: MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
            }),
            'Moderation action access-loss recording exceeded hot-path budget; continuing detached',
          );
        } finally {
          debugSpy.mockRestore();
          jest.useRealTimers();
        }
      });

      it('refreshes candidates and retries another bot after a terminal moderation access error', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              botMemberships: [
                { botId: 'id613002203036_bot', status: 'ACTIVE' },
                { botId: 'id613002203036_4_bot', status: 'ACTIVE' },
              ],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036',
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce(['id613002203036_bot'])
            .mockResolvedValueOnce(['id613002203036_bot', 'id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const maxChatAdminRosterSyncService = {
          scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
        };
        const managedEntityAccessLossService = {
          recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
            classification: {
              kind: 'managed_entity_access_lost',
              reason: 'bot_denied',
              statusCode: 403,
              code: 'chat.denied',
              message: 'request failed with status code 403',
            },
            reason: 'bot_denied',
            recorded: {
              chatId: 'chat-1',
            },
          }),
        };
        const terminalError = createMaxApiError(
          403,
          'Request failed with status code 403',
          'chat.denied',
        );
        const operation = jest.fn().mockImplementation(async (botId?: string) => {
          if (botId === 'id613002203036_bot') {
            throw terminalError;
          }
        });
        const service = new ModerationService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          undefined,
          maxChatAdminRosterSyncService as never,
          undefined,
          managedEntityAccessLossService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'moderate_member',
            userId: 'user-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(operation.mock.calls).toEqual([['id613002203036_bot'], ['id613002203036_4_bot']]);
        expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
          botId: 'id613002203036_bot',
          bypassCache: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          timeoutMs: 1_500,
        });
        expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
          botId: 'id613002203036_4_bot',
          bypassCache: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          timeoutMs: 1_500,
        });
        expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith(
          {
            chatId: 'chat-1',
            botId: 'id613002203036_bot',
            entityType: null,
            source: 'moderation_action:moderate_member',
            operation: 'member_moderation',
            error: terminalError,
          },
        );
        expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
      });

      it('sends ban notice with the bot that won moderation fallback', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              primaryBotId: 'id613002203036_bot',
              botId: 'id613002203036_bot',
              botMemberships: [
                { botId: 'id613002203036_bot', status: 'ACTIVE' },
                { botId: 'id613002203036_4_bot', status: 'ACTIVE' },
              ],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          moderationEvent: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        };
        const terminalError = createMaxApiError(
          403,
          'Request failed with status code 403',
          'chat.denied',
        );
        const maxClient = {
          banMember: jest
            .fn()
            .mockImplementation(
              async (_chatId: string, _userId: string, options?: { botId?: string }) => {
                if (options?.botId === 'id613002203036_bot') {
                  throw terminalError;
                }
              },
            ),
          sendMessage: jest.fn().mockResolvedValue({ messageId: 'notice-1' }),
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members', 'write'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce(['id613002203036_bot'])
            .mockResolvedValueOnce(['id613002203036_bot', 'id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const managedEntityAccessLossService = {
          recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
            classification: {
              kind: 'managed_entity_access_lost',
              reason: 'bot_denied',
              statusCode: 403,
              code: 'chat.denied',
              message: 'request failed with status code 403',
            },
            reason: 'bot_denied',
            recorded: {
              chatId: 'chat-1',
            },
          }),
        };
        const service = new ModerationService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          managedEntityAccessLossService as never,
        );

        await (service as any).applySanctionAction({
          chatId: 'chat-1',
          userId: 'user-1',
          action: SanctionAction.BAN,
          userLabel: userMention('Нарушитель'),
          messageId: 'message-1',
          muteDurationHours: 1,
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 3,
          botSpeechStyle: null,
          trackAsGlobalSpammer: false,
          persistModerationEvent: jest.fn().mockResolvedValue({ id: 'sanction-event-fallback' }),
        });

        expect(maxClient.banMember).toHaveBeenCalledWith(
          'chat-1',
          'user-1',
          expect.objectContaining({ botId: 'id613002203036_bot' }),
        );
        expect(maxClient.banMember).toHaveBeenCalledWith(
          'chat-1',
          'user-1',
          expect.objectContaining({ botId: 'id613002203036_4_bot' }),
        );
        expect(maxClient.sendMessage).toHaveBeenCalledWith(
          'chat-1',
          expect.any(String),
          expect.objectContaining({
            textFormat: 'markdown',
          }),
          expect.objectContaining({
            botId: 'id613002203036_4_bot',
            sourceTag: 'moderation_notice',
          }),
        );
      });
    });

    it('passes message through when the user is subscribed to all required channels', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('checks multiple required subscription channels with bounded parallelism', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const resolvers: Array<(value: boolean | null) => void> = [];
      const membershipLookupService = {
        getMembership: jest.fn().mockImplementation(
          () =>
            new Promise<boolean | null>((resolve) => {
              resolvers.push(resolve);
            }),
        ),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      const lookupPromise = (
        service as unknown as {
          resolveRequiredSubscriptionMembership: (
            chatId: string,
            userId: string,
            requiredChannelIds: string[],
          ) => Promise<{ missingChannelIds: string[]; unresolvedChannelIds: string[] } | null>;
        }
      ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', [
        'channel-1',
        'channel-2',
        'channel-3',
      ]);
      await Promise.resolve();
      await Promise.resolve();

      expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(2);

      resolvers[0]?.(true);
      resolvers[1]?.(true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(3);

      resolvers[2]?.(true);
      await expect(lookupPromise).resolves.toEqual({
        missingChannelIds: [],
        unresolvedChannelIds: [],
        terminalChannelIds: [],
      });
    });

    it('fails open when required subscription membership checks exceed the hot-path budget', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-03T10:00:00.000Z'));
      const runtimeDiagnosticsService = {
        recordHotPathStageOutcome: jest.fn(),
      };
      const membershipLookupService = {
        getMembership: jest.fn(
          () =>
            new Promise<boolean | null>(() => {
              // Intentionally never resolves.
            }),
        ),
      };
      const service = new ModerationService(
        {} as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        {
          get: jest.fn((key: string) =>
            key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10_000 : undefined,
          ),
        } as never,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        runtimeDiagnosticsService as never,
      );
      (service as any).webhookUserFacingTimeoutMs = 10_000;
      const debugSpy = jest
        .spyOn((service as any).logger, 'debug')
        .mockImplementation(() => undefined);
      const hotPathProfile = {
        startedAtMs: Date.now() - 1_000,
        lastMarkedAtMs: Date.now() - 50,
        latestStage: 'required-subscription.membership',
        stages: new Map<string, number>(),
        stageTimelineMs: new Map<string, number>(),
        successBoundaryReached: false,
        successBoundaryStage: null,
      };

      try {
        const resultPromise = (
          service as unknown as {
            resolveRequiredSubscriptionMembershipWithHotPathBudget: (params: {
              chatId: string;
              userId: string;
              requiredChannelIds: string[];
              hotPathProfile: typeof hotPathProfile;
            }) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            } | null>;
          }
        ).resolveRequiredSubscriptionMembershipWithHotPathBudget({
          chatId: 'chat-1',
          userId: 'user-1',
          requiredChannelIds: ['channel-1', 'channel-2'],
          hotPathProfile,
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS);

        await expect(resultPromise).resolves.toBeNull();
        expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
          stage: 'required-subscription.membership.deferred',
          outcome: 'skip',
          failOpen: true,
        });
        expect(debugSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat-1',
            userId: 'user-1',
            channelCount: 2,
            timeoutMs: REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
          }),
          'Required subscription membership checks exceeded hot-path budget; continuing fail-open',
        );
      } finally {
        debugSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('does not retry a fresh missing required subscription membership resolution', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembershipResolution: jest.fn().mockResolvedValue({ membership: false, fresh: true }),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      await expect(
        (
          service as unknown as {
            resolveRequiredSubscriptionMembership: (
              chatId: string,
              userId: string,
              requiredChannelIds: string[],
            ) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            }>;
          }
        ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', ['channel-1']),
      ).resolves.toEqual({
        missingChannelIds: ['channel-1'],
        unresolvedChannelIds: [],
        terminalChannelIds: [],
      });
      expect(membershipLookupService.getMembershipResolution).toHaveBeenCalledTimes(1);
      expect(membershipLookupService.getMembershipResolution).toHaveBeenCalledWith(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        {},
      );
    });

    it('still retries a stale missing required subscription membership before enforcing', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembershipResolution: jest
          .fn()
          .mockResolvedValueOnce({ membership: false, fresh: false })
          .mockResolvedValueOnce({ membership: true, fresh: true }),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      await expect(
        (
          service as unknown as {
            resolveRequiredSubscriptionMembership: (
              chatId: string,
              userId: string,
              requiredChannelIds: string[],
            ) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            }>;
          }
        ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', ['channel-1']),
      ).resolves.toEqual({
        missingChannelIds: [],
        unresolvedChannelIds: [],
        terminalChannelIds: [],
      });
      expect(membershipLookupService.getMembershipResolution).toHaveBeenCalledTimes(2);
      expect(membershipLookupService.getMembershipResolution).toHaveBeenLastCalledWith(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true, allowStaleOnError: false },
      );
    });

    it('excludes terminal required subscription lookup issues from missing targets', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembership: jest.fn().mockResolvedValue(null),
        getLookupIssue: jest.fn().mockReturnValue({
          chatId: 'channel-1',
          policyName: 'moderation_required_subscription',
          kind: 'terminal',
          retryAfterMs: 60_000,
          observedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          statusCode: 403,
          message: 'Request failed with status code 403',
        }),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      await expect(
        (
          service as unknown as {
            resolveRequiredSubscriptionMembership: (
              chatId: string,
              userId: string,
              requiredChannelIds: string[],
            ) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            }>;
          }
        ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', ['channel-1']),
      ).resolves.toEqual({
        missingChannelIds: [],
        unresolvedChannelIds: ['channel-1'],
        terminalChannelIds: ['channel-1'],
      });
      expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(2);
      expect(membershipLookupService.getLookupIssue).toHaveBeenCalledWith(
        'channel-1',
        'moderation_required_subscription',
      );
    });

    it('checks every configured required subscription chat or channel before passing the message', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2', 'channel-3', 'channel-4'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockImplementation(async (channelId: string) => {
          return channelId !== 'channel-4';
        }),
        getChatSnapshot: jest.fn().mockImplementation(async (channelId: string) => ({
          title: channelId === 'channel-4' ? 'Нужный канал 4' : `Нужный канал ${channelId}`,
          link: `https://max.ru/channels/${channelId}`,
          participantsCount: 100,
          entityType: 'channel',
        })),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember.mock.calls.map((call) => call[0])).toEqual([
        'channel-1',
        'channel-2',
        'channel-3',
        'channel-4',
      ]);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Нужный канал 4');
      expect(noticeText).not.toContain('Нужный канал channel-1');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          buttons: [
            [
              {
                text: 'Нужный канал 4',
                url: 'https://max.ru/channels/channel-4',
              },
            ],
          ],
        }),
      );
    });

    it('caps required subscription targets read from persisted settings to the contract limit', async () => {
      const requiredSubscriptionChannelIds = Array.from(
        { length: REQUIRED_SUBSCRIPTION_MAX_CHANNELS + 2 },
        (_, index) => `channel-${index + 1}`,
      );
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds,
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        getChatSnapshot: jest.fn().mockImplementation(async (channelId: string) => ({
          title: `Нужный канал ${channelId}`,
          link: `https://max.ru/channels/${channelId}`,
          participantsCount: 100,
          entityType: 'channel',
        })),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      const expectedChannelIds = requiredSubscriptionChannelIds.slice(
        0,
        REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
      );
      expect(maxClient.getChatSnapshot.mock.calls.map((call) => call[0])).toEqual(
        expectedChannelIds,
      );
      expect(maxClient.hasChatMember.mock.calls.map((call) => call[0])).toEqual(expectedChannelIds);
      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(REQUIRED_SUBSCRIPTION_MAX_CHANNELS);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('confirms stale missing required subscription cache with a fresh lookup before deleting', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.stringCache.set('required-subscription:member:v1:channel-1:user-1', '0');
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('does not force the active bot for required subscription membership lookups', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembership: jest.fn().mockResolvedValue(true),
      };
      const maxBotContextService = {
        getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
        undefined,
        maxBotContextService as never,
      );

      await expect(
        (
          service as unknown as {
            getRequiredSubscriptionMembership: (
              channelId: string,
              userId: string,
            ) => Promise<boolean | null>;
          }
        ).getRequiredSubscriptionMembership('channel-1', 'user-1'),
      ).resolves.toBe(true);

      expect(membershipLookupService.getMembership).toHaveBeenCalledWith(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
      );
    });

    it('deletes the message, records violation, and sends buttons only for missing channels', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
        rulesAttachViolationsEnabled: true,
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest
          .fn()
          .mockResolvedValueOnce({
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          })
          .mockResolvedValueOnce({
            title: 'Афиша района',
            link: 'https://max.ru/channels/afisha',
            participantsCount: 42,
            entityType: 'channel',
          }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        }),
      });
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                chatId: 'chat-1',
                userId: 'user-1',
                messageId: 'msg-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
                action: SanctionAction.DELETE_MESSAGE,
                metadata: expect.objectContaining({
                  requiredChannelIds: ['channel-1', 'channel-2'],
                  missingChannelIds: ['channel-1', 'channel-2'],
                  missingChannelTitles: ['Новости MAX', 'Афиша района'],
                }),
              }),
            }),
          ],
          [
            expect.objectContaining({
              data: expect.objectContaining({
                chatId: 'chat-1',
                userId: 'user-1',
                messageId: 'msg-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.NONE,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 1,
                  requiredSubscriptionEscalationWindowHours: 24,
                  missingChannelTitles: ['Новости MAX', 'Афиша района'],
                }),
              }),
            }),
          ],
        ]),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeText).toContain('Афиша района');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
            [
              {
                text: 'Афиша района',
                url: 'https://max.ru/channels/afisha',
              },
            ],
          ],
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        }),
      );
    });

    it('deduplicates mirrored multi-bot required-subscription enforcement with a persisted message claim', async () => {
      const prisma = {
        ...createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          requiredSubscriptionBotMessageEnabled: true,
        }),
        moderationViolationMessageClaim: {
          createMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-owner-required-subscription-1',
        botId: 'bot-1',
      });
      await service.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-standby-required-subscription-1',
        botId: 'bot-2',
      });

      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 'msg-1',
            ruleCode: 'REQUIRED_SUBSCRIPTION',
            updateType: 'message_action',
          }),
        ],
        skipDuplicates: true,
      });
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('renders markdown-heavy required subscription templates as html without visible markers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageText:
          '👋 {user}, приветствую. **Ваша публикация удалена.**\n\n**✏️ Что-бы иметь возможность писать сообщения в группе, задавать вопросы, необходимо выполнить условие. **\n\n**💙 **Нужно подписаться на {channels}',
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Нижегородский районный чат',
          link: 'https://max.ru/channels/nizhegorodskiy-chat',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeOptions).toEqual(expect.objectContaining({ textFormat: 'html' }));
      expect(noticeText).toContain('<strong>Ваша публикация удалена.</strong>');
      expect(noticeText).toContain('<a href="max://user/user-1">Алексей</a>');
      expect(noticeText).toContain('Нижегородский районный чат');
      expect(noticeText).not.toMatch(/(?:\*\*|__|\+\+|~~|\^\^)/u);
    });

    it('retries a required-subscription delete with the next eligible bot after a terminal 403', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest
          .fn()
          .mockRejectedValueOnce(
            createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
          )
          .mockResolvedValueOnce(undefined),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const maxBotLinkService = {
        getDefaultBotId: jest.fn().mockReturnValue('id613002203036_bot'),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: 'id613002203036_bot',
          label: 'Майор Максимов',
          characterName: 'Майор Максимов',
          speechPersona: 'male',
        }),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        resolveBotId: jest.fn().mockResolvedValue(null),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
        resolveBotIdsForModerationAction: jest
          .fn()
          .mockResolvedValue(['id613002203036_bot', 'id613002203036_4_bot']),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await expect(service.handleUpdate(createUpdate())).resolves.toBeUndefined();

      expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(1, 'chat-1', 'msg-1', {
        botId: 'id613002203036_bot',
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      });
      expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(2, 'chat-1', 'msg-1', {
        botId: 'id613002203036_4_bot',
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      });
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        expect.any(String),
        expect.objectContaining({ textFormat: 'html' }),
        expect.objectContaining({
          botId: 'id613002203036_4_bot',
          sourceTag: 'moderation_notice',
        }),
      );
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) => args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION_DELETE',
        ),
      ).toBe(true);
    });

    it('fails open for required-subscription deletes after terminal 403 errors from every candidate bot', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest
          .fn()
          .mockRejectedValue(
            createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
          ),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const maxBotLinkService = {
        getDefaultBotId: jest.fn().mockReturnValue('id613002203036_bot'),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: 'id613002203036_bot',
          label: 'Майор Максимов',
          characterName: 'Майор Максимов',
          speechPersona: 'male',
        }),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        resolveBotId: jest.fn().mockResolvedValue(null),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
        resolveBotIdsForModerationAction: jest
          .fn()
          .mockResolvedValue(['id613002203036_bot', 'id613002203036_4_bot']),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await expect(service.handleUpdate(createUpdate())).resolves.toBeUndefined();

      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        }),
      });
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) => args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION_DELETE',
        ),
      ).toBe(false);
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) =>
            args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION' &&
            args?.data?.action === SanctionAction.NONE,
        ),
      ).toBe(true);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('refreshes fallback required subscription metadata before naming channels in the bot notice', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Канал channel-1',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
      );

      const channels = await (
        service as unknown as {
          resolveRequiredSubscriptionChannels: (
            channelIds: string[],
            options: { allowRemoteFetch: boolean },
          ) => Promise<Array<{ id: string; title: string; link: string | null; usable: boolean }>>;
        }
      ).resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: true,
      });

      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          accessDiagnostics: expect.objectContaining({
            state: 'ok',
            lastDetectedAt: null,
            lostBots: [],
          }),
        }),
      );
      expect(channels).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
    });

    it('uses the bound channel bot when refreshing required subscription metadata', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Канал channel-1',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
      };
      const maxBotLinkService = {
        resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      const channels = await (
        service as unknown as {
          resolveRequiredSubscriptionChannels: (
            channelIds: string[],
            options: { allowRemoteFetch: boolean },
          ) => Promise<Array<{ id: string; title: string; link: string | null; usable: boolean }>>;
        }
      ).resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: true,
      });

      expect(maxBotLinkService.resolveBotId).toHaveBeenCalledWith({
        chatId: 'channel-1',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
        botId: 'id613002203036_bot',
      });
      expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          primaryBotId: 'id613002203036_bot',
          assignedBots: [],
          sharedMode: 'owned',
          accessDiagnostics: expect.objectContaining({
            state: 'ok',
            lastDetectedAt: null,
            lostBots: [],
          }),
        }),
      );
      expect(channels).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
    });

    it('reuses recent required subscription channel metadata in memory for ordinary moderation lookups', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        chatContextCache as never,
      );

      const resolver = service as unknown as {
        resolveRequiredSubscriptionChannels: (
          channelIds: string[],
          options?: { allowRemoteFetch?: boolean },
        ) => Promise<
          Array<{
            id: string;
            title: string;
            link: string | null;
            usable: boolean;
            checkMembership: boolean;
          }>
        >;
      };

      const first = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: false,
      });
      const second = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: false,
      });

      expect(first).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
      expect(second).toEqual(first);
      expect(prisma.chat.findMany).toHaveBeenCalledTimes(1);
      expect(chatContextCache.getManagedEntityHeader).toHaveBeenCalledTimes(1);
    });

    it('does not let a cached local fallback suppress a later remote metadata refresh', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue(null),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
      );

      const resolver = service as unknown as {
        resolveRequiredSubscriptionChannels: (
          channelIds: string[],
          options?: { allowRemoteFetch?: boolean },
        ) => Promise<Array<{ id: string; title: string; link: string | null; usable: boolean }>>;
      };

      const first = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: false,
      });
      const second = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: true,
      });

      expect(first).toEqual([
        {
          id: 'channel-1',
          title: 'Канал channel-1',
          link: null,
          usable: false,
          checkMembership: true,
        },
      ]);
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(second).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
    });

    it('prefers cached required subscription metadata from chat context cache without remote metadata fetch', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            rulesAttachViolationsEnabled: true,
          }),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
          ],
        }),
      );
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('refreshes cold required subscription metadata before sending the user notice', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            rulesAttachViolationsEnabled: true,
          }),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
        getManagedEntityHeader: jest.fn().mockResolvedValue(null),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
          ],
        }),
      );
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
        }),
      );
    });

    it('keeps required subscription notices out of the generic bot-notice bucket', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.incrementWithTtl.mockResolvedValue(999);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(redisCounter.incrementWithTtl).not.toHaveBeenCalledWith(
        'moderation:bot-notice-bucket:v1:chat-1',
        60,
      );
    });

    it('prefers a cached required subscription channel header over a stale persisted chat entity type', async () => {
      const prisma = createPrismaForRequiredSubscription();
      prisma.chat.findMany.mockResolvedValue([
        {
          id: 'channel-1',
          title: 'Старое имя чата',
          entityType: ChatEntityType.CHAT,
        },
      ]);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            rulesAttachViolationsEnabled: true,
          }),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('does not resolve rules links during ordinary chat context loads from cache', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.resolveMessageLink).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('checks chats and channels in required subscription config', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['chat-2', 'channel-1'],
        requiredSubscriptionButtonText: 'Подписаться',
      });
      prisma.chat.findMany.mockResolvedValue([
        {
          id: 'chat-2',
          title: 'Общий чат',
          entityType: ChatEntityType.CHAT,
        },
      ]);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => {
          if (chatId === 'chat-2') {
            return {
              title: 'Общий чат',
              link: 'https://max.ru/chats/chat-2',
              participantsCount: 120,
              entityType: 'chat',
            };
          }

          return {
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          };
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
      expect(maxClient.hasChatMember).toHaveBeenNthCalledWith(1, 'chat-2', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(maxClient.hasChatMember).toHaveBeenNthCalledWith(2, 'channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
      expect(maxClient.getChatSnapshot).toHaveBeenNthCalledWith(1, 'chat-2', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenNthCalledWith(2, 'channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeText).toContain('Общий чат');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          buttons: [
            [
              {
                text: 'Подписаться',
                url: 'https://max.ru/chats/chat-2',
              },
            ],
            [
              {
                text: 'Подписаться',
                url: 'https://max.ru/channels/news-max',
              },
            ],
          ],
        }),
      );
    });

    it('enforces required subscription with a generic notice when metadata cannot produce a channel button and title', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: '',
          link: null,
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('обязательные чаты или каналы');
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces required subscription with a generic notice when metadata only resolves an english fallback title', async () => {
      const channelId = '-71476678048456';
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: [channelId],
      });
      prisma.chat.findMany.mockResolvedValue([
        {
          id: channelId,
          title: `Chat ${channelId}`,
          entityType: ChatEntityType.CHANNEL,
        },
      ]);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: '',
          link: 'https://max.ru/join/fcg899ueBbNlZawe6eDPbUQALPBuNU6A7OHommknuqI',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(channelId, {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.hasChatMember).toHaveBeenCalledWith(channelId, 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('обязательные чаты или каналы');
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('suppresses repeated notice during cooldown and reuses membership cache', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      await service.handleUpdate(secondUpdate);

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(2);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(4);
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        expect.stringContaining('required-subscription:notice:v1:chat-1:user-1'),
        '1',
        15 * 60,
      );
    });

    it('sends the required subscription explanation again after the notice cooldown expires', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      prisma.violation.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.incrementWithTtl.mockResolvedValue(2);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      redisCounter.stringCache.delete('required-subscription:notice:v1:chat-1:user-1');
      await service.handleUpdate(secondUpdate);

      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(prisma.violation.count).toHaveBeenCalledTimes(1);
      expect(redisCounter.incrementWithTtl).toHaveBeenCalledWith(
        expect.stringContaining(
          'moderation:violation-count:v1:chat-1:user-1:REQUIRED_SUBSCRIPTION',
        ),
        24 * 60 * 60 + 60,
      );
      const secondNoticeText = maxClient.sendMessage.mock.calls[1]?.[1] ?? '';
      expect(secondNoticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.NONE,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 2,
                }),
              }),
            }),
          ],
        ]),
      );
    });

    it('ignores legacy required subscription expiry and keeps enforcing selected sources', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-16T12:00:00.000Z'));

      try {
        const prisma = createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          requiredSubscriptionExpiresAt: '2026-04-10T12:00:00.000Z',
        });
        const ruleEngine = {
          detect: jest.fn().mockResolvedValue({ violations: [] }),
        };
        const maxClient = {
          hasChatMember: jest.fn().mockResolvedValue(false),
          getChatSnapshot: jest.fn().mockResolvedValue({
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          }),
          deleteMessage: jest.fn(),
          sendMessage: jest.fn(),
          kickMember: jest.fn(),
          banMember: jest.fn(),
          notifyModerators: jest.fn(),
          resolveMessageLink: jest.fn().mockResolvedValue(null),
        };

        const service = new ModerationService(
          prisma as never,
          ruleEngine as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
        );

        await service.handleUpdate(createUpdate());

        expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
          trafficClass: 'critical',
          timeoutMs: 2_000,
          sourceTag: 'required_subscription_membership',
        });
        expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
          trafficClass: 'background',
          timeoutMs: 2_500,
          sourceTag: 'required_subscription_metadata',
        });
        expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1', expect.any(Object));
        expect(maxClient.sendMessage).toHaveBeenCalled();
        expect(prisma.violation.create).toHaveBeenCalled();
        expect(ruleEngine.detect).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('enforces required subscription while degraded under pressure', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getSnapshot: jest.fn().mockReturnValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'queue lag 42s',
          updatedAt: '2026-03-30T14:55:00.000Z',
          manualMode: null,
          queueLagSec: 42,
          action: {
            windowSec: 60,
            total: 0,
            success: 0,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          degraded: true,
        }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('retries sending the explanation on the next message when the first send fails', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest
          .fn()
          .mockRejectedValueOnce(new Error('MAX send failed'))
          .mockResolvedValueOnce(undefined),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      await service.handleUpdate(secondUpdate);

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);

      const noticeCooldownWrites = redisCounter.setStringWithTtl.mock.calls.filter(
        ([key]) =>
          typeof key === 'string' && key.includes('required-subscription:notice:v1:chat-1:user-1'),
      );
      expect(noticeCooldownWrites).toHaveLength(1);
      expect(noticeCooldownWrites[0]).toEqual([
        expect.stringContaining('required-subscription:notice:v1:chat-1:user-1'),
        '1',
        15 * 60,
      ]);
    });

    it('issues WARN on second required subscription violation in 24h when warning stage is enabled', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('предупреждение');
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.WARN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 2,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
    });

    it('issues BAN on third required subscription violation without adding the user to global spammers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionBanEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(3);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('бан');
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.BAN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 3,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    });

    it('issues BAN on fourth required subscription violation without adding the user to global spammers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionBanEnabled: true,
        requiredSubscriptionMuteEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(4);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.BAN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 4,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    });

    it('fails open for terminal required subscription membership errors', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const terminalError = createMaxApiError(
        403,
        'Request failed with status code 403',
        'chat.denied',
      );
      const maxClient = {
        hasChatMember: jest.fn().mockRejectedValue(terminalError),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('enforces required subscription when the system is under pressure', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 42.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 42,
          action: {
            windowSec: 60,
            total: 50,
            success: 45,
            failure: 5,
            critical: 0,
            errorRate: 0.1,
            criticalRate: 0,
          },
        }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );

      await service.handleUpdate(createUpdate());

      expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces required subscription before skipping a chat in webhook hot-timeout backoff', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('keeps ordinary message moderation active for a hot chat while the system is healthy', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings(),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('keeps duplicate detection and known-spammer checks while skipping cross-chat tracking under pressure', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const redisCounter = {
        addToSetWithTtl: jest.fn(),
        incrementWithTtl: jest.fn(),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
        undefined,
        redisCounter as never,
      );
      const trackingSpy = jest.spyOn(
        service as any,
        'trackAndRegisterGlobalSpammerWithHotPathBudget',
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
      expect(redisCounter.addToSetWithTtl).not.toHaveBeenCalled();
      expect(trackingSpy).not.toHaveBeenCalled();
      expect(prisma.globalSpammer.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.findFirst).toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    });

    it('enforces a local admin block for a degraded hot chat without cross-chat tracking', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        },
        adminGlobalSpammerExemption: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: 'user-1',
              decision: 'BLOCK',
              updatedAt: new Date(),
            },
          ]),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );
      const trackingSpy = jest.spyOn(
        service as any,
        'trackAndRegisterGlobalSpammerWithHotPathBudget',
      );
      const ensureDeleteIntent = jest
        .spyOn(service as any, 'ensureModerationDeleteIntent')
        .mockResolvedValue(undefined);
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);
      const update = createUpdate();
      update.message!.createdAt = '2026-08-15T09:37:00.000Z';

      await service.handleUpdate(update);

      expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledTimes(1);
      expect(trackingSpy).not.toHaveBeenCalled();
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-1');
      expect(ensureDeleteIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleCode: 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
          sourceMessageAt: update.message!.createdAt,
        }),
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'LOCAL_ADMIN_BLOCK',
          action: SanctionAction.KICK,
        }),
      });
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces an already-known spammer for a degraded hot chat without cross-chat tracking', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };
      const globalSpammerIntelligence = {
        evaluatePolicy: jest.fn().mockResolvedValue({ action: 'DELETE_AND_KICK' }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );
      (service as any).globalSpammerIntelligence = globalSpammerIntelligence;
      const trackingSpy = jest.spyOn(
        service as any,
        'trackAndRegisterGlobalSpammerWithHotPathBudget',
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(trackingSpy).not.toHaveBeenCalled();
      expect(globalSpammerIntelligence.evaluatePolicy).toHaveBeenCalledWith({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-1');
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'GLOBAL_SPAMMER_KICK',
          action: SanctionAction.KICK,
        }),
      });
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('keeps duplicate state and the known-spammer check near the hot-path deadline', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
            rules: {
              publishedUrl: null,
              publishedMessageId: null,
            },
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const redisCounter = {
        addToSetWithTtl: jest.fn(),
        incrementWithTtl: jest.fn(),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 12.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 12,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
        undefined,
        redisCounter as never,
      );
      const hotPathProfile = (service as any).createWebhookHotPathProfile();
      hotPathProfile.startedAtMs = Date.now() - 9_300;
      hotPathProfile.lastMarkedAtMs = hotPathProfile.startedAtMs;

      await service.handleUpdate(createUpdate(), hotPathProfile);

      expect(redisCounter.addToSetWithTtl).toHaveBeenCalled();
      expect(prisma.globalSpammer.findUnique).toHaveBeenCalledTimes(1);
      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
    });

    it('keeps local message moderation active for a hot chat while optional stages are throttled', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ antiDuplicateEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('keeps admin bypass ahead of required subscription checks', async () => {
      const prisma = createPrismaForRequiredSubscription(
        {
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
        },
        ['user-1'],
      );
      const ruleEngine = {
        detect: jest.fn(),
      };
      const maxClient = {
        hasChatMember: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).not.toHaveBeenCalled();
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    });
  });
  it('throttles channel auto-post scans instead of pausing them completely when the runtime governor returns slow', async () => {
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'background share 67.2%',
        retryAfterMs: 45_000,
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const loggerSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});

    const plan = await (service as any).resolveChannelAutoPostExecutionPlan();

    expect(plan).toEqual({
      batchSize: 4,
      interChannelDelayMs: 500,
      maxNewMessagesPerScan: 1,
    });
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'moderation',
      sourceTag: 'channel_auto_post',
      allowQueueLagSlowPathBelowSec: 5,
    });
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'channel-auto-post-buttons',
        action: 'slow',
        reason: 'background share 67.2%',
        retryAfterMs: 45_000,
        batchSize: 4,
        maxNewMessagesPerScan: 1,
      }),
      'Throttled moderation background work because the runtime governor detected pressure',
    );
  });

  it('pauses channel auto-post scans when the runtime governor is unavailable', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn(),
      },
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const loggerSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    const beforeScanMs = Date.now();

    await expect((service as any).processChannelAutoPostButtons()).resolves.toBeUndefined();

    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'moderation',
      sourceTag: 'channel_auto_post',
      allowQueueLagSlowPathBelowSec: 5,
    });
    expect(prisma.channelSettings.findMany).not.toHaveBeenCalled();
    expect((service as any).channelAutoPostBackoffUntilMs).toBeGreaterThanOrEqual(
      beforeScanMs + 180_000,
    );
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'channel-auto-post-buttons',
        retryAfterMs: 180_000,
        err: 'timeout exceeded when trying to connect',
      }),
      'Paused moderation background work because the runtime governor is unavailable',
    );
  });

  it('loads full channel auto-post contexts only for the selected scan batch', async () => {
    const candidateChannels = [
      { chatId: 'channel-1' },
      { chatId: 'channel-2' },
      { chatId: 'channel-3' },
      { chatId: 'channel-4' },
      { chatId: 'channel-5' },
      { chatId: 'channel-6' },
    ];
    const channelBatch = ['channel-1', 'channel-2', 'channel-3', 'channel-4'];
    const prisma = {
      channelSettings: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(candidateChannels)
          .mockResolvedValueOnce(
            channelBatch.map((chatId) => ({
              chatId,
              updatedAt: new Date('2026-04-13T00:00:00.000Z'),
              commentsEnabled: true,
              commentsAdminsEnabled: true,
              commentsAllEnabled: false,
              postSuggestionsEnabled: false,
              chat: {
                admins: [{ userId: 'admin-1' }],
              },
            })),
          ),
      },
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'background share 67.2%',
        retryAfterMs: 45_000,
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    jest.spyOn(service as any, 'processManagedChannelAutoPostButtons').mockResolvedValue(undefined);

    await (service as any).processChannelAutoPostButtons();

    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        select: {
          chatId: true,
        },
      }),
    );
    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId: {
            in: channelBatch,
          },
        },
      }),
    );
    expect((service as any).processManagedChannelAutoPostButtons).toHaveBeenCalledTimes(4);
  });

  it('uses the resolved scan bot when auto-attaching channel buttons during poll repair', async () => {
    const prisma = {
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('scan-bot-2'),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || 'scan-bot-2')}?startapp=${startParam}`,
        ),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) => `https://max.ru/test-bot?startapp=${startParam}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'scan-bot-2' ? '990002' : null,
      ),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }
          if (key === 'APP_BASE_URL') {
            return 'https://major-maksimov.ru';
          }
          return undefined;
        }),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-1',
      text: 'Пост канала',
      linkType: null,
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-04-13T00:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: null,
    });

    expect(maxBotLinkService.resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'channel-1',
      capability: 'background_scans',
    });
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Пост канала',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              url: expect.stringContaining('https://max.ru/test-bot?startapp='),
            }),
          ],
        ],
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: 'scan-bot-2',
      },
    );
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveContactIdSync).toHaveBeenCalledWith('scan-bot-2');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-1',
          source: 'poll',
          botId: 'scan-bot-2',
        }),
      }),
    });
  });

  it('persists forwarded channel replacement cleanup as a durable delete intent', async () => {
    const prisma = {
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-copy-1',
        url: 'https://max.ru/chats/channel-1/message/mid-channel-copy-1',
      }),
      deleteMessage: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('scan-bot-2'),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      buildMiniappStartUrlSync: jest.fn().mockReturnValue('https://max.ru/bot?startapp=comments'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/entry-bot?startapp=comments'),
      resolveContactIdSync: jest.fn().mockReturnValue('990002'),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-chat-copy-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'pending',
        confirmed: false,
        intentId: 'intent-channel-copy-1',
        status: 'RETRYABLE',
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-original-1',
      text: 'Forwarded post',
      linkType: 'forward',
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-04-13T00:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: 'admin-1',
    });

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'mid-channel-original-1',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'scan-bot-2',
        routingPolicy: 'origin_only',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
      }),
      undefined,
    );
    expect(deleteIntents.ensureIntent.mock.calls[0]?.[0]).not.toHaveProperty('sourceMessageAt');
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'mid-channel-original-1',
          replacementMessageId: 'mid-channel-copy-1',
          originalDeleted: false,
        }),
      }),
    });
  });

  it('passes the channel webhook message timestamp into replacement cleanup', async () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    jest.spyOn(service as any, 'resolveSystemModeSnapshot').mockResolvedValue({ mode: 'normal' });
    jest.spyOn(service as any, 'resolveSenderChatAdminCheck').mockResolvedValue({
      isAdmin: true,
      source: 'remote',
    });
    const attach = jest
      .spyOn(service as any, 'tryAutoAttachChannelMessageButtons')
      .mockResolvedValue('attached');
    const sourceMessageAt = '2026-08-15T09:40:00.000Z';
    const update: MaxUpdate = {
      updateId: 'channel-webhook-source-time-1',
      type: 'message_created',
      message: {
        chatId: 'channel-1',
        messageId: 'mid-channel-original-1',
        senderId: 'admin-1',
        text: 'Forwarded post',
        createdAt: sourceMessageAt,
      },
      raw: {},
    };

    await (service as any).handleChannelUpdate(update, {
      channelSettings: {
        commentsEnabled: true,
        postSuggestionsEnabled: false,
        postSuggestionsButtonText: '',
      },
      adminUserIds: ['admin-1'],
    });

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'webhook',
        sourceMessageAt,
      }),
    );
  });

  it('publishes admin chat comments as a strict-routed reply without cleanup intent', async () => {
    const prisma = {
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-reply-1',
        url: 'https://max.ru/chats/chat-1/message/mid-chat-reply-1',
      }),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'chat-bot-2',
        botId: 'chat-bot-2',
        candidateBotIds: ['chat-bot-2'],
        reason: 'primary_confirmed',
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: [],
        retryAt: null,
      }),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-chat-copy-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'waiting_capability',
        confirmed: false,
        intentId: 'intent-chat-copy-1',
        status: 'WAITING_CAPABILITY',
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;
    jest.spyOn(service as any, 'buildChatDialogButton').mockReturnValue({
      type: 'link',
      text: 'Comments',
      url: 'https://max.ru/entry-bot?startapp=comments',
    });

    await (service as any).tryAutoAttachChatMessageComments({
      chatId: 'chat-1',
      messageId: 'mid-chat-original-1',
      senderId: 'admin-1',
    });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      '',
      expect.objectContaining({
        messageLink: {
          type: 'reply',
          mid: 'mid-chat-original-1',
        },
        buttons: [[expect.objectContaining({ type: 'link', text: 'Comments' })]],
      }),
      expect.objectContaining({
        botId: 'chat-bot-2',
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'comment_notification',
      }),
    );
    expect(deleteIntents.ensureIntent).not.toHaveBeenCalled();
    expect(deleteIntents.ensureAndAttempt).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'mid-chat-original-1',
          deliveryMode: 'reply_message',
          replyMessageId: 'mid-chat-reply-1',
          originalDeleted: false,
          botId: 'chat-bot-2',
        }),
      }),
    });
  });

  it('records managed channel access loss when the background auto-post scan cannot read the channel', async () => {
    const maxError = createMaxApiError(403, 'Request failed with status code 403', 'chat.denied');
    const maxClient = {
      listMessages: jest.fn().mockRejectedValue(maxError),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('scan-bot-2'),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'request failed with status code 403',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'channel-1',
        },
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    await (service as any).processManagedChannelAutoPostButtons({
      channelSettings: {
        chatId: 'channel-1',
        updatedAt: new Date('2026-04-13T00:00:00.000Z'),
        commentsEnabled: true,
        postSuggestionsEnabled: false,
      },
      adminUserIds: ['admin-1'],
    });

    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
      botId: 'scan-bot-2',
    });
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'channel-1',
      botId: 'scan-bot-2',
      entityType: ChatEntityType.CHANNEL,
      source: 'channel_auto_post:scan',
      operation: 'read',
      error: maxError,
    });
  });

  it('keeps message-not-found auto-post attach failures as per-message skips', async () => {
    const maxError = createMaxApiError(
      404,
      'Request failed with status code 404',
      'message.not.found',
    );
    const prisma = {
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(maxError),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('scan-bot-2'),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || 'scan-bot-2')}?startapp=${startParam}`,
        ),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) => `https://max.ru/test-bot?startapp=${startParam}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'scan-bot-2' ? '990002' : null,
      ),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'message_not_found',
          statusCode: 404,
          code: 'message.not.found',
          message: 'request failed with status code 404',
        },
        reason: null,
        recorded: null,
      }),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }
          if (key === 'APP_BASE_URL') {
            return 'https://major-maksimov.ru';
          }
          return undefined;
        }),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-1',
      text: 'Пост канала',
      linkType: null,
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-04-13T00:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: null,
    });

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'channel-1',
      botId: 'scan-bot-2',
      entityType: ChatEntityType.CHANNEL,
      source: 'channel_auto_post:poll_attach',
      operation: 'edit',
      error: maxError,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'system',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
        payload: expect.objectContaining({
          messageId: 'mid-channel-1',
          reason: 'terminal_delivery_failure',
          source: 'poll',
          deliveryMode: 'edit_message',
          status: 404,
        }),
      }),
    });
  });
});

describe('ModerationService participant immunity', () => {
  it('recognizes full participant protection without spending a daily limit', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ expires_at: null }]),
    };
    const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);

    const consumed = await (service as any).consumeChatParticipantModerationImmunity({
      chatId: 'chat-1',
      userId: 'user-1',
      nightModeTimezone: 'Europe/Moscow',
    });

    expect(consumed).toBe(true);
    const sqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sqlText).toContain('WITH active_immunity AS');
    expect(sqlText).toContain('limited_update AS');
    expect(sqlText).toContain('WHERE "expires_at" IS NULL');
    expect(sqlText).toContain('AND "daily_violation_limit" IS NULL');
  });

  it('bypasses ordinary moderation when participant immunity is consumed', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commentsEnabled: false,
          }),
          domains: [],
          admins: [],
          rules: {
            publishedUrl: null,
            publishedMessageId: null,
          },
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'PROFANITY',
            score: 0.91,
            reason: 'мат',
            metadata: null,
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    const immunitySpy = jest
      .spyOn(service as any, 'consumeChatParticipantModerationImmunity')
      .mockResolvedValue(true);

    await service.handleUpdate(createUpdate());

    expect(immunitySpy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      nightModeTimezone: 'Europe/Moscow',
    });
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });
});
