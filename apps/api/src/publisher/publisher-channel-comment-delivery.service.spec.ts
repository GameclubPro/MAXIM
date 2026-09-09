import type { MaxUpdate } from '@maxim/contracts';
import { PublisherChannelCommentDeliveryService } from './publisher-channel-comment-delivery.service';
import { PublisherChatCommentProducerService } from './publisher-chat-comment-producer.service';
import {
  PublisherChatCommentQueueService,
  type PublisherChannelCommentAttachJob,
} from './publisher-chat-comment.queue';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { AdminDialogLinkHelper } from '../admin/admin-dialog-link-helper';

const chatId = '-100';
const config = { get: () => 'publik-bot' };
const links = new PublisherDialogLinkService(
  config as never,
  { getSigningKeys: () => ['publisher-test-key'] } as never,
);

function fixture() {
  const entity = {
    entityType: 'CHANNEL',
    publicationPolicy: {
      publikEnabled: true,
      revision: 3,
      updatedAt: new Date(Date.now() - 60_000),
    },
    publisherSettings: {
      channelCommentsEnabled: true,
      channelSuggestionsEnabled: true,
      revision: 7,
      updatedAt: new Date(Date.now() - 60_000),
    },
  };
  const prisma = {
    chat: {
      findFirst: jest.fn().mockResolvedValue(entity),
      findUnique: jest.fn().mockResolvedValue(entity),
    },
    auditLog: { upsert: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 4n }]),
  };
  const job: PublisherChannelCommentAttachJob = {
    version: 1,
    kind: 'attach_channel_keyboard',
    chatId,
    messageId: 'post-1',
    threadId: '11111111-1111-1111-1111-111111111111',
    requiredBotId: 'publik-bot',
    dialogBotId: 'publik-bot',
    publisherSettingsRevision: 7,
    publicationPolicyRevision: 3,
    idempotencyKey: 'publisher-channel-test',
    sourceTag: 'channel_auto_post',
    retryPolicyName: 'publisher-chat-comment',
    createdAt: new Date().toISOString(),
  };
  const message = {
    recipient: { chat_id: chatId, chat_type: 'channel' },
    body: { attachments: [] as unknown[] },
  };
  const mutate = jest.fn();
  const maxClient = {
    editMessageInlineKeyboard: jest.fn(async (_chat, _id, _text, options) => {
      const buttons = await options.prepareInlineKeyboard(message);
      if (buttons === null) return;
      await options.beforeEditMutation();
      mutate(buttons);
    }),
    getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
    getCurrentChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ isAdmin: true, isOwner: false, permissions: ['edit_message'] }),
  };
  const readiness = {
    assertEntityReady: jest
      .fn()
      .mockResolvedValue({ entityType: 'channel', requiredBotId: 'publik-bot' }),
  };
  const runtime = { assertDispatchEnabled: jest.fn() };
  const health = {
    assertDispatchAllowed: jest.fn(),
    recordSendFailure: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PublisherChannelCommentDeliveryService(
    prisma as never,
    maxClient as never,
    readiness as never,
    runtime as never,
    { getBotId: () => 'publik-bot' } as never,
    links,
    health as never,
  );
  const queue = { enqueueChannelAttach: jest.fn() };
  const producer = new PublisherChatCommentProducerService(
    prisma as never,
    queue as never,
    config as never,
  );
  const update: MaxUpdate = {
    updateId: 'update-1',
    type: 'message_created',
    botId: 'publik-bot',
    message: {
      chatId,
      messageId: 'post-1',
      entityType: 'channel',
      senderId: '',
      text: 'Post',
      createdAt: job.createdAt,
    },
  };
  return {
    entity,
    prisma,
    job,
    message,
    mutate,
    maxClient,
    readiness,
    runtime,
    health,
    service,
    queue,
    producer,
    update,
  };
}

describe('Publisher channel keyboard webhook and delivery', () => {
  it.each([
    [true, true, 2],
    [true, false, 1],
    [false, true, 1],
  ])(
    'attaches enabled buttons (%s, %s) without Major settings or access',
    async (comments, suggestions, count) => {
      const h = fixture();
      h.entity.publisherSettings.channelCommentsEnabled = Boolean(comments);
      h.entity.publisherSettings.channelSuggestionsEnabled = Boolean(suggestions);
      await h.producer.observeWebhook(h.update);
      expect(h.queue.enqueueChannelAttach).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId,
          messageId: 'post-1',
          publisherSettingsRevision: 7,
          publicationPolicyRevision: 3,
        }),
      );
      await h.service.process(h.job);
      expect(h.mutate.mock.calls[0]![0]).toHaveLength(count as number);
      for (const [button] of h.mutate.mock.calls[0]![0]) {
        expect(new URL(button.url).pathname).toBe('/publik-bot');
      }
      expect(h.maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        chatId,
        'post-1',
        null,
        expect.objectContaining({
          requireAllAttachmentsPreserved: true,
          mergeExistingInlineKeyboard: true,
        }),
        expect.objectContaining({ botId: 'publik-bot' }),
      );
      expect(h.prisma.auditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            payload: expect.objectContaining({
              publisherProfile: true,
              botId: 'publik-bot',
              dialogBotId: 'publik-bot',
            }),
          }),
        }),
      );
    },
  );

  it('does not use a Major thread or let its buttons suppress Publisher buttons', async () => {
    const h = fixture();
    const majorLinks = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major-bot',
      maxBotToken: 'major-key',
      maxBotTokenValidationSecrets: ['major-key'],
    });
    h.message.body.attachments = [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              majorLinks.buildChannelDialogButton(
                chatId,
                'comments',
                'major-thread',
                'Major',
                'major-bot',
                'MINIAPP',
              ),
            ],
          ],
        },
      },
    ];
    await h.service.process(h.job);
    expect(h.mutate.mock.calls[0]![0]).toHaveLength(2);
    expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload.threadId).toBe(h.job.threadId);
  });

  it('recovers its audit after a successful edit without editing again or resetting the thread', async () => {
    const h = fixture();
    h.message.body.attachments = [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              links.buildChannelDialogButton(
                chatId,
                'comments',
                'existing-publisher-thread',
                'Comments',
                'MINIAPP',
              ),
            ],
            [
              links.buildChannelDialogButton(
                chatId,
                'suggest',
                'existing-publisher-thread',
                'Suggest',
                'MINIAPP',
              ),
            ],
          ],
        },
      },
    ];
    await h.service.process(h.job);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload.threadId).toBe(
      'existing-publisher-thread',
    );
  });

  it.each(['major', 'edited', 'native', 'old', 'future', 'disabled', 'before_settings'] as const)(
    'does not enqueue %s events',
    async (kind) => {
      const h = fixture();
      if (kind === 'major') h.update.botId = 'major-bot';
      if (kind === 'edited') h.update.type = 'message_edited';
      if (kind === 'native') h.update.message!.postId = 'parent-post';
      if (kind === 'old')
        h.update.message!.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
      if (kind === 'future')
        h.update.message!.createdAt = new Date(Date.now() + 120_000).toISOString();
      if (kind === 'disabled') h.entity.publicationPolicy.publikEnabled = false;
      if (kind === 'before_settings')
        h.entity.publisherSettings.updatedAt = new Date(Date.now() + 1_000);
      await h.producer.observeWebhook(h.update);
      expect(h.queue.enqueueChannelAttach).not.toHaveBeenCalled();
    },
  );

  it('defers the webhook if Redis did not confirm durable admission', async () => {
    const h = fixture();
    h.queue.enqueueChannelAttach.mockRejectedValue(new Error('Redis unavailable') as never);
    await expect(h.producer.observeWebhook(h.update)).rejects.toThrow('durable enqueue');
  });

  it.each(['settings_epoch', 'policy_epoch', 'disabled', 'wrong_entity'] as const)(
    'skips stale %s before any MAX request',
    async (kind) => {
      const h = fixture();
      if (kind === 'settings_epoch') h.entity.publisherSettings.revision++;
      if (kind === 'policy_epoch') h.entity.publicationPolicy.revision++;
      if (kind === 'disabled') h.entity.publicationPolicy.publikEnabled = false;
      if (kind === 'wrong_entity') h.entity.entityType = 'CHAT';
      await h.service.process(h.job);
      expect(h.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    },
  );

  it('rechecks settings immediately before the mutation', async () => {
    const h = fixture();
    h.maxClient.getChatSnapshot.mockImplementation(async () => ({ entityType: 'channel' }));
    h.prisma.chat.findUnique.mockResolvedValueOnce(h.entity).mockResolvedValueOnce(null);
    await expect(h.service.process(h.job)).rejects.toThrow('settings changed');
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert).not.toHaveBeenCalled();
  });

  it.each(['write_only', 'remote_chat', 'wrong_bot', 'wrong_dialog', 'runtime_disabled'] as const)(
    'fails closed for %s',
    async (kind) => {
      const h = fixture();
      if (kind === 'write_only')
        h.maxClient.getCurrentChatMemberAccess.mockResolvedValue({
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        });
      if (kind === 'remote_chat')
        h.maxClient.getChatSnapshot.mockResolvedValue({ entityType: 'chat' });
      if (kind === 'wrong_bot')
        h.readiness.assertEntityReady.mockResolvedValue({
          entityType: 'channel',
          requiredBotId: 'major-bot',
        });
      if (kind === 'wrong_dialog') h.job = { ...h.job, dialogBotId: 'major-bot' };
      if (kind === 'runtime_disabled')
        h.runtime.assertDispatchEnabled.mockImplementation(() => {
          throw new Error('disabled');
        });
      await expect(h.service.process(h.job)).rejects.toThrow();
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it('keeps duplicate queue identity and thread scoped to the exact Publisher and post', async () => {
    const queue = { add: jest.fn() };
    const service = new PublisherChatCommentQueueService(
      queue as never,
      config as never,
      { read: async () => ({ dispatchEnabled: true }) } as never,
    );
    const input = {
      chatId,
      messageId: 'post-1',
      publisherSettingsRevision: 7,
      publicationPolicyRevision: 3,
      createdAt: new Date(),
    };
    await service.enqueueChannelAttach(input);
    await service.enqueueChannelAttach(input);
    await service.enqueueChannelAttach({ ...input, messageId: 'post-2' });
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
    expect(queue.add.mock.calls[0]![1].threadId).not.toBe(queue.add.mock.calls[2]![1].threadId);
    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ requiredBotId: 'publik-bot', dialogBotId: 'publik-bot' }),
    );
  });
});
