import { WebhookService } from './webhook.service';
import type { MaxUpdate } from '@maxim/contracts';

type ReceiptBoundary = {
  persistReceipt(update: MaxUpdate, ip: string | null, raw: unknown): Promise<string>;
};
function setup(count = 1) {
  const tx = { webhookEvent: { createMany: jest.fn().mockResolvedValue({ count }) } };
  const prisma = {
    $transaction: jest.fn(async (work: (value: unknown) => Promise<unknown>) => work(tx)),
    webhookEvent: tx.webhookEvent,
  };
  const retention = {
    captureInput: jest.fn().mockReturnValue(null),
    settleRemovedMessage: jest.fn(),
  };
  const service = Object.create(WebhookService.prototype) as ReceiptBoundary;
  Object.assign(service, { prisma, messageRetention: retention });
  const update = {
    updateId: 'receipt1',
    type: 'message_removed',
    botId: 'major',
    createdAt: new Date().toISOString(),
    message: { chatId: '-123', messageId: 'mid1', senderId: 'actor-42' },
    raw: { update_type: 'message_removed', chat_id: -123, message_id: 'mid1', user_id: 'actor-42' },
  } as unknown as MaxUpdate;
  return { service, prisma, retention, tx, update };
}
describe('authenticated retention removal receipts', () => {
  it('settles exact removal in the deduplicated receipt transaction without author inference', async () => {
    const { service, retention, tx, update, prisma } = setup();
    await service.persistReceipt(update, null, update.raw);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(retention.settleRemovedMessage).toHaveBeenCalledWith(tx, {
      chatId: '-123',
      messageId: 'mid1',
    });
  });
  it('does not settle a duplicate receipt', async () => {
    const { service, retention, update } = setup(0);
    await expect(service.persistReceipt(update, null, update.raw)).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(retention.settleRemovedMessage).not.toHaveBeenCalled();
  });
  it.each(['chat', 'message', 'channel', 'bot'])(
    'rejects incomplete or conflicting %s evidence',
    async (kind) => {
      const { service, retention, update } = setup();
      if (kind === 'chat') update.raw!.chat_id = -999;
      if (kind === 'message') update.raw!.message_id = 'different';
      if (kind === 'channel') update.raw!.post_id = 'post';
      if (kind === 'bot') update.botId = undefined;
      await service.persistReceipt(update, null, update.raw);
      expect(retention.settleRemovedMessage).not.toHaveBeenCalled();
    },
  );
  it('propagates settlement failure so both receipt and counters can be retried atomically', async () => {
    const { service, retention, update } = setup();
    retention.settleRemovedMessage.mockRejectedValue(new Error('binding changed'));
    await expect(service.persistReceipt(update, null, update.raw)).rejects.toThrow(
      'binding changed',
    );
  });
});
