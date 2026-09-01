import { PublisherPrivateDialogFlowRouterService } from './publisher-private-dialog-flow-router.service';

describe('PublisherPrivateDialogFlowRouterService', () => {
  it('routes suggestion review callbacks before other Publisher private flows', async () => {
    const suggestionAdminCallbacks = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const autoReplyAuthoring = { observeWebhook: jest.fn() };
    const postImport = { observeWebhook: jest.fn() };
    const router = new PublisherPrivateDialogFlowRouterService(
      suggestionAdminCallbacks as never,
      autoReplyAuthoring as never,
      postImport as never,
    );
    const update = { updateId: 'update-1', type: 'message_callback' };

    await expect(router.observeWebhook(update as never, 'webhook-1')).resolves.toBe(true);

    expect(suggestionAdminCallbacks.observeWebhook).toHaveBeenCalledWith(update, 'webhook-1', {});
    expect(autoReplyAuthoring.observeWebhook).not.toHaveBeenCalled();
    expect(postImport.observeWebhook).not.toHaveBeenCalled();
  });

  it('preserves the existing auto-reply and post-import fallback order', async () => {
    const suggestionAdminCallbacks = { observeWebhook: jest.fn().mockResolvedValue(false) };
    const autoReplyAuthoring = { observeWebhook: jest.fn().mockResolvedValue(false) };
    const postImport = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const router = new PublisherPrivateDialogFlowRouterService(
      suggestionAdminCallbacks as never,
      autoReplyAuthoring as never,
      postImport as never,
    );
    const update = { updateId: 'update-1', type: 'message_callback' };

    await expect(router.observeWebhook(update as never, 'webhook-1')).resolves.toBe(true);

    expect(suggestionAdminCallbacks.observeWebhook).toHaveBeenCalledTimes(1);
    expect(autoReplyAuthoring.observeWebhook).toHaveBeenCalledTimes(1);
    expect(postImport.observeWebhook).toHaveBeenCalledTimes(1);
  });
});
