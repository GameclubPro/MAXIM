import { ConfigService } from '@nestjs/config';
import { AdminService } from '../admin/admin.service';
import { createPrismaMock } from '../admin/admin-service-test-support';
import { EraserSourceHoldBarrierError } from './eraser-source-hold-barrier';

describe('existing human rules adoption with independent cleanup', () => {
  it('refuses adoption before mutation when the independent prehold is not acknowledged', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({ chatId: '-1' });
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      new ConfigService({
        ERASER_ENABLED: true,
        MAX_BOT_TOKEN: 'test-bot-token',
        MAX_BOT_ID: '777000_bot',
      }),
    );
    jest
      .spyOn(service as unknown as { assertChatAdmin: () => Promise<void> }, 'assertChatAdmin')
      .mockResolvedValue();
    jest
      .spyOn(service as unknown as { ensureEntityType: () => Promise<void> }, 'ensureEntityType')
      .mockResolvedValue();
    jest
      .spyOn(
        service as unknown as { resolveManualActionBotAssignment: () => Promise<string> },
        'resolveManualActionBotAssignment',
      )
      .mockResolvedValue('bot');
    const oldUrl = process.env.ERASER_CONTROL_URL;
    const oldToken = process.env.ERASER_CONTROL_TOKEN;
    process.env.ERASER_CONTROL_URL = 'http://eraser:3000';
    process.env.ERASER_CONTROL_TOKEN = 'control-only';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 409 }));
    try {
      await expect(
        service.adoptChatRulesFromMessage(
          '-1',
          { userId: 'admin' } as never,
          {
            sourceMessageId: 'old-human-rules',
            sourceMessageUrl: 'https://max.ru/chats/1/message/1',
            text: 'Rules',
          },
          'miniapp',
        ),
      ).rejects.toBeInstanceOf(EraserSourceHoldBarrierError);
      expect(prisma.chatRules.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
        holdMessages: [{ chatId: '-1', messageId: 'old-human-rules' }],
      });
    } finally {
      jest.restoreAllMocks();
      if (oldUrl === undefined) delete process.env.ERASER_CONTROL_URL;
      else process.env.ERASER_CONTROL_URL = oldUrl;
      if (oldToken === undefined) delete process.env.ERASER_CONTROL_TOKEN;
      else process.env.ERASER_CONTROL_TOKEN = oldToken;
    }
  });
});
