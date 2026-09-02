import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookService } from './webhook.service';

const update: MaxUpdate = {
  updateId: 'update-1',
  botId: 'publisher-bot',
  type: 'message_created',
  message: {
    messageId: 'message-1',
    chatId: '-100',
    entityType: 'chat',
    senderId: 'user-1',
    text: 'прайс',
    createdAt: '2026-08-29T12:00:00.000Z',
  },
};

type AutoReplyDisposition = 'no_match' | 'selected' | 'suppressed' | 'ambiguous' | 'bot_authored';

function createService(options: { consumed?: boolean; disposition?: AutoReplyDisposition } = {}) {
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue({ id: 'stored-webhook-1' }),
    },
  };
  const lifecycle = { observeWebhook: jest.fn().mockResolvedValue(undefined) };
  const comments = { observeWebhook: jest.fn().mockResolvedValue(undefined) };
  const postImport = {
    observeWebhook: jest.fn().mockResolvedValue(options.consumed ?? false),
  };
  const disposition = options.disposition ?? 'selected';
  const autoReplies = {
    observeWebhook: jest.fn().mockResolvedValue({
      matched: disposition !== 'no_match',
      disposition,
    }),
  };
  const service = new WebhookService(
    prisma as never,
    {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'MAX_PUBLISHER_BOT_ID' ? 'publisher-bot' : fallback,
      ),
    } as unknown as ConfigService,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lifecycle as never,
    comments as never,
    postImport as never,
    autoReplies as never,
  );
  return { service, lifecycle, comments, postImport, autoReplies, prisma };
}

describe('Publisher auto-reply webhook ordering', () => {
  it('keeps post import first and lifecycle before trigger matching', async () => {
    const { service, lifecycle, comments, postImport, autoReplies } = createService();

    await (service as any).observePublisherWebhook(update, 'webhook-1', false);

    expect(postImport.observeWebhook).toHaveBeenCalledTimes(1);
    expect(lifecycle.observeWebhook).toHaveBeenCalledTimes(1);
    expect(autoReplies.observeWebhook).toHaveBeenCalledWith(update, 'webhook-1', {
      duplicateRepair: false,
    });
    expect(postImport.observeWebhook.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.observeWebhook.mock.invocationCallOrder[0]!,
    );
    expect(lifecycle.observeWebhook.mock.invocationCallOrder[0]).toBeLessThan(
      autoReplies.observeWebhook.mock.invocationCallOrder[0]!,
    );
    expect(comments.observeWebhook).not.toHaveBeenCalled();
  });

  it('does not let a private authoring/import flow fall through to lifecycle or triggers', async () => {
    const { service, lifecycle, comments, autoReplies } = createService({ consumed: true });

    await (service as any).observePublisherWebhook(update, 'webhook-1', false);

    expect(lifecycle.observeWebhook).not.toHaveBeenCalled();
    expect(autoReplies.observeWebhook).not.toHaveBeenCalled();
    expect(comments.observeWebhook).not.toHaveBeenCalled();
  });

  it('does not let a shadow-only extended match block chat-comments', async () => {
    const { service, comments } = createService({ disposition: 'no_match' });

    await (service as any).observePublisherWebhook(update, 'webhook-1', false);

    expect(comments.observeWebhook).toHaveBeenCalledWith(update);
  });

  it.each(['suppressed', 'ambiguous', 'bot_authored'] as const)(
    'keeps chat-comments blocked for the %s disposition',
    async (disposition) => {
      const { service, comments } = createService({ disposition });

      await (service as any).observePublisherWebhook(update, 'webhook-1', false);

      expect(comments.observeWebhook).not.toHaveBeenCalled();
    },
  );

  it('passes duplicate repair context to the auto-reply producer', async () => {
    const { service, autoReplies } = createService();

    await (service as any).observePublisherWebhook(update, null, true);

    expect(autoReplies.observeWebhook).toHaveBeenCalledWith(update, 'stored-webhook-1', {
      duplicateRepair: true,
    });
  });
});
