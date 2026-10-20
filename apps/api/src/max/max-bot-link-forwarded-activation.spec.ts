import type { PrismaService } from '../prisma/prisma.service';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  ManagedEntityActivationRequiredError,
  type ManagedEntityExplicitActivation,
} from './managed-entity-activation.util';
import type { MaxBotContextService } from './max-bot-context.service';
import type { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxBotLinkService } from './max-bot-link.service';
import type { ModerationDeleteIntentAccessWakeService } from './moderation-delete-intent-access-wake.service';

describe('MAX access probe forwarded activation boundary', () => {
  it.each(['publisher-bot', 'major-bot'])(
    'keeps official body opt-in exact to Publisher for %s',
    async (botId) => {
      const sourceAt = new Date(Date.now() - 1_000);
      const update = new WebhookParser().parse(
        {
          update_type: 'message_created',
          timestamp: sourceAt.getTime(),
          message: {
            sender: { user_id: 42 },
            recipient: { chat_id: 123, chat_type: 'dialog' },
            body: {
              mid: 'incoming',
              text: '/start',
              attachments: [{ type: 'image', payload: { photo_id: 'photo' } }],
            },
            link: { type: 'forward', chat_id: -70001, message: { mid: 'source' } },
          },
        },
        { botId },
      );
      const current = {
        status: ChatBotMembershipStatus.REMOVED,
        botAccessState: ChatBotAccessState.DENIED,
        botAccessCheckedAt: new Date(sourceAt.getTime() - 5_000),
        lifecycleEventAt: new Date(sourceAt.getTime() - 5_000),
        chat: { entityType: ChatEntityType.CHAT },
      };
      const prisma = {
        publisherEntityBinding: { findFirst: jest.fn().mockResolvedValue(current) },
        chatBotMembership: { findUnique: jest.fn().mockResolvedValue(current) },
        webhookEvent: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ botId, normalizedPayload: update, createdAt: new Date() }),
        },
      } satisfies {
        publisherEntityBinding: Pick<PrismaService['publisherEntityBinding'], 'findFirst'>;
        chatBotMembership: Pick<PrismaService['chatBotMembership'], 'findUnique'>;
        webhookEvent: Pick<PrismaService['webhookEvent'], 'findUnique'>;
      };
      const registry = {
        getPublisherBotDescriptor: jest.fn().mockReturnValue({ id: 'publisher-bot' }),
      } satisfies Pick<MaxBotRegistryService, 'getPublisherBotDescriptor'>;
      const service = new MaxBotLinkService(
        prisma as unknown as PrismaService,
        registry as unknown as MaxBotRegistryService,
        {} as MaxBotContextService,
        {} as ModerationDeleteIntentAccessWakeService,
      );
      const proof: ManagedEntityExplicitActivation = {
        kind: 'forwarded_message',
        sourceAt,
        updateId: update.updateId,
        actorUserId: '42',
        botId,
        chatId: '-70001',
      };
      const pending = service.assertChatBotAccessProbeAllowed('-70001', botId, proof);
      if (botId === 'publisher-bot') await expect(pending).resolves.toEqual(current);
      else await expect(pending).rejects.toBeInstanceOf(ManagedEntityActivationRequiredError);
      expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { dedupKey: `${botId}:${update.updateId}` },
        }),
      );
    },
  );
});
