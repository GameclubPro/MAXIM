import { MaxBotContextService } from '../max/max-bot-context.service';
import {
  createModerationServiceWithManualBridge,
  createSettings,
  createUpdate,
} from './moderation.service.spec-support';

describe('text duplicate executor provenance', () => {
  it.each([1, 4, 9, 13])(
    'uses the executor instead of any of %s receiver identities',
    async (botCount) => {
      const context = new MaxBotContextService();
      const settings = createSettings({
        antiSpamEnabled: false,
        antiDuplicateEnabled: true,
        duplicateCompareMode: 'TEXT',
        russianProfanityFilterEnabled: false,
      });
      const prisma = {
        moderationEvent: { findFirst: jest.fn(async () => null) },
        chat: {
          upsert: jest.fn(async () => ({
            id: 'chat-1',
            title: 'Multibot',
            settings,
            domains: [],
            admins: [{ userId: 'admin-1' }],
          })),
        },
      };
      const observer = {
        observe: jest.fn(async () => undefined),
        isAuthoritative: jest.fn(async () => true),
      };
      const canonical = {
        prepareExecution: jest.fn(async (id: string) => ({
          webhookEvent: { id, botId: id },
          update: { ...createUpdate(), botId: id, executionOwnerBotId: 'executor-b' },
          activeBotId: 'executor-b',
          businessLeaseToken: null,
        })),
        completeExecution: jest.fn(async () => undefined),
        failExecution: jest.fn(async () => undefined),
      };
      const service = createModerationServiceWithManualBridge({
        prisma,
        ruleEngine: { detect: jest.fn(async () => ({ violations: [] })) },
        sanctionService: {},
        manualBridge: {},
        maxClient: { getChatAdminIds: jest.fn(async () => ['admin-1']) },
        maxBotLinkService: {
          getDefaultBotId: () => 'default',
          isKnownBotUserId: () => false,
          resolveContactIdSync: (id: string) => id,
        },
      });
      Object.assign(service, {
        maxBotContextService: context,
        injectedWebhookCanonicalExecutionService: canonical,
        messageDuplicateService: observer,
      });
      for (let bot = 0; bot < botCount; bot++) await service.processWebhookEvent(`receiver-${bot}`);
      expect(observer.observe).toHaveBeenCalledTimes(botCount);
      for (const call of observer.observe.mock.calls as unknown as Array<
        [{ botId: string; update: { botId: string } }]
      >) {
        expect(call[0].botId).toBe('executor-b');
        expect(call[0].update.botId).toMatch(/^receiver-/u);
      }
      expect(canonical.failExecution).not.toHaveBeenCalled();
      expect(context.getActiveBotId()).toBeNull();
    },
  );
});
