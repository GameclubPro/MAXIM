import {
  createPendingPublicationContext,
  preparePendingPublicationContext,
} from './publication-target-preparation';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';

describe('independent immutable publication target preparation', () => {
  it('materializes all 100 targets without consulting current rights or preparing dialogs', async () => {
    const assertTargetsReady = jest.fn().mockRejectedValue(new Error('one denied target'));
    const prepare = jest.fn();
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      { assertTargetsReady } as never,
      { prepare } as never,
      {} as never,
      {} as never,
    );
    const targets = Array.from({ length: 100 }, (_, i) => ({
      chatId: `chat-${i}`,
      entityType: 'chat' as const,
    }));
    const route = await service.prepareOccurrenceRoute('PUBLIK_V1', 'publik', targets, []);
    expect(route.deliveryDataByChatId.size).toBe(100);
    expect(route.deliveryDataByChatId.get('chat-99')?.publisherDialogContext).toMatchObject({
      version: 0,
      preparation: 'pending',
    });
    expect(assertTargetsReady).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(
      await service.resolveScheduledTargets({
        actorUserId: 'actor',
        requiredBotId: 'publik',
        audienceMode: 'SNAPSHOT',
        audienceSelection: 'SELECTED',
        targets: targets.map((target) => ({
          targetChatId: target.chatId,
          entityType: 'CHAT' as const,
        })),
      }),
    ).toHaveLength(100);
  });
  it.each([0, 1])(
    'persists a prepared context only after an untouched delivery CAS (%s)',
    async (count) => {
      const marker = createPendingPublicationContext(
        { chatId: 'chat', entityType: 'chat' },
        'publik',
        [{ text: 'Открыть', url: 'https://example.com' }],
      );
      const delivery = {
        id: 'delivery',
        targetChatId: 'chat',
        publisherDialogContext: marker as never,
      };
      const prepared = { version: 1, dialogBotId: 'publik', buttons: [], reference: null };
      const prepare = jest.fn().mockResolvedValue(prepared);
      const updateMany = jest.fn().mockResolvedValue({ count });
      const pending = preparePendingPublicationContext(
        {
          prisma: {
            managedBroadcastDelivery: { updateMany, findFirst: jest.fn().mockResolvedValue(null) },
          },
          publisherDialogContextService: { prepare },
        } as never,
        delivery,
        'publik',
      );
      if (count) {
        await pending;
        expect(delivery.publisherDialogContext).toEqual(prepared);
      } else {
        await expect(pending).rejects.toThrow('fence');
        expect(delivery.publisherDialogContext).toEqual(marker);
      }
      expect(updateMany.mock.calls[0][0].where).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        requiredBotId: 'publik',
        publisherDialogContext: { equals: marker },
      });
    },
  );
  it('uses a concurrent preflight winner without losing its buttons or delaying dispatch', async () => {
    const marker = createPendingPublicationContext(
      { chatId: 'chat', entityType: 'chat' },
      'publik',
      [],
    );
    const delivery = {
      id: 'delivery',
      targetChatId: 'chat',
      publisherDialogContext: marker as never,
    };
    const winner = {
      version: 1,
      dialogBotId: 'publik',
      buttons: [[{ type: 'link', text: 'Saved', url: 'https://example.com' }]],
      reference: null,
    };
    const findFirst = jest.fn().mockResolvedValue({ publisherDialogContext: winner });
    await preparePendingPublicationContext(
      {
        prisma: {
          managedBroadcastDelivery: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            findFirst,
          },
        },
        publisherDialogContextService: {
          prepare: jest
            .fn()
            .mockResolvedValue({ version: 1, dialogBotId: 'publik', buttons: [], reference: null }),
        },
      } as never,
      delivery,
      'publik',
    );
    expect(delivery.publisherDialogContext).toEqual(winner);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      requiredBotId: 'publik',
      targetChatId: 'chat',
    });
  });
  it('refuses wrong-bot preparation without changing context or issuing MAX effects', async () => {
    const prepare = jest.fn();
    await expect(
      preparePendingPublicationContext(
        { publisherDialogContextService: { prepare } } as never,
        {
          id: 'delivery',
          targetChatId: 'chat',
          publisherDialogContext: createPendingPublicationContext(
            { chatId: 'chat', entityType: 'chat' },
            'old-bot',
            [],
          ) as never,
        },
        'publik',
      ),
    ).rejects.toThrow('unavailable');
    expect(prepare).not.toHaveBeenCalled();
  });
});
