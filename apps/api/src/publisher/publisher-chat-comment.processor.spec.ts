import { DelayedError, type Job } from 'bullmq';
import { PublisherChatCommentProcessor } from './publisher-chat-comment.processor';
import type { PublisherChatCommentJob } from './publisher-chat-comment.queue';
import { PublisherDispatchPausedError } from './publisher-dispatch-health.service';
import { PUBLISHER_DISPATCH_PAUSE_DEFER_MS } from './publisher-dispatch-job-guard';
import { PublisherIdentityAttestationError } from './publisher-identity-attestation.service';
import { PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS } from './publisher-identity-attestation-job-guard';

const attachJob: PublisherChatCommentJob = {
  version: 1,
  kind: 'attach_chat_reply',
  markerId: `ccr1_${'a'.repeat(32)}`,
  lockToken: 'lock-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  senderId: 'admin-1',
  requiredBotId: 'publik-bot',
  dialogBotId: 'main-bot',
  button: { type: 'link', text: 'Comments', url: 'https://example.test' },
  idempotencyKey: `ccr1_${'a'.repeat(32)}`,
  sourceTag: 'chat_auto_comment',
  retryPolicyName: 'publisher-chat-comment',
  createdAt: '2026-08-26T09:00:00.000Z',
};

const keyboardJob: PublisherChatCommentJob = {
  version: 1,
  kind: 'edit_comment_keyboard',
  entityType: 'chat',
  readinessFeature: 'chat_comments',
  chatId: 'chat-1',
  messageId: 'publisher-message-1',
  threadId: 'thread-1',
  requiredBotId: 'publik-bot',
  dialogBotId: 'main-bot',
  buttons: [[{ type: 'link', text: 'Comments', url: 'https://example.test' }]],
  commentsButton: { rowIndex: 0, columnIndex: 0, baseText: 'Comments' },
  countSnapshot: 3,
  idempotencyKey: 'chat:chat-1:publisher-message-1:thread-1',
  sourceTag: 'comment_button_count',
  retryPolicyName: 'publisher-chat-comment',
  createdAt: '2026-08-26T09:00:00.000Z',
};

describe('PublisherChatCommentProcessor', () => {
  const originalRole = process.env.APP_ROLE;
  const originalServiceName = process.env.APP_SERVICE_NAME;

  afterEach(() => {
    jest.useRealTimers();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
    if (originalServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = originalServiceName;
  });

  const createAttestation = () => ({ assertAttested: jest.fn().mockResolvedValue(undefined) });
  const createDispatchHealth = () => ({
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
  });

  it('rejects a publisher job on every non-publisher role', async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const delivery = { process: jest.fn() };
    const processor = new PublisherChatCommentProcessor(
      delivery as never,
      createAttestation() as never,
      createDispatchHealth() as never,
    );

    await expect(
      processor.process({
        data: attachJob,
        attemptsMade: 0,
        opts: { attempts: 12 },
      } as Job<PublisherChatCommentJob>),
    ).rejects.toThrow('outside api-publisher');
    expect(delivery.process).not.toHaveBeenCalled();
  });

  it('rejects a publisher role process with the wrong service identity', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-action';
    const delivery = { process: jest.fn() };
    const processor = new PublisherChatCommentProcessor(
      delivery as never,
      createAttestation() as never,
      createDispatchHealth() as never,
    );

    await expect(
      processor.process({
        data: attachJob,
        attemptsMade: 0,
        opts: { attempts: 12 },
      } as Job<PublisherChatCommentJob>),
    ).rejects.toThrow('outside api-publisher');
    expect(delivery.process).not.toHaveBeenCalled();
  });

  it('passes final-attempt metadata only in api-publisher', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const delivery = { process: jest.fn().mockResolvedValue(undefined) };
    const processor = new PublisherChatCommentProcessor(
      delivery as never,
      createAttestation() as never,
      createDispatchHealth() as never,
    );

    await processor.process({
      data: attachJob,
      attemptsMade: 11,
      opts: { attempts: 12 },
    } as Job<PublisherChatCommentJob>);

    expect(delivery.process).toHaveBeenCalledWith(attachJob, {
      final: true,
      attemptsMade: 12,
      maxAttempts: 12,
    });
  });

  it('delays a keyboard edit without consuming an attempt while identity is unattested', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const delivery = { process: jest.fn() };
    const identityAttestation = {
      assertAttested: jest
        .fn()
        .mockRejectedValue(new PublisherIdentityAttestationError('transient_failure')),
    };
    const processor = new PublisherChatCommentProcessor(
      delivery as never,
      identityAttestation as never,
      createDispatchHealth() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: keyboardJob,
      attemptsMade: 7,
      opts: { attempts: 8 },
      token: 'job-token',
      moveToDelayed,
    } as unknown as Job<PublisherChatCommentJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS,
      'worker-token',
    );
    expect(job.attemptsMade).toBe(7);
    expect(delivery.process).not.toHaveBeenCalled();
  });

  it('keeps generic attestation errors on the ordinary retry path', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const failure = new Error('redis unavailable');
    const delivery = { process: jest.fn() };
    const identityAttestation = { assertAttested: jest.fn().mockRejectedValue(failure) };
    const processor = new PublisherChatCommentProcessor(
      delivery as never,
      identityAttestation as never,
      createDispatchHealth() as never,
    );
    const moveToDelayed = jest.fn();
    const job = {
      data: keyboardJob,
      attemptsMade: 0,
      opts: { attempts: 8 },
      token: 'job-token',
      moveToDelayed,
    } as unknown as Job<PublisherChatCommentJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBe(failure);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(delivery.process).not.toHaveBeenCalled();
  });

  it('delays a paused comment job before delivery without consuming its attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const delivery = { process: jest.fn() };
    const dispatchHealth = {
      assertDispatchAllowed: jest.fn().mockRejectedValue(new PublisherDispatchPausedError(null)),
    };
    const processor = new PublisherChatCommentProcessor(
      delivery as never,
      createAttestation() as never,
      dispatchHealth as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: attachJob,
      attemptsMade: 7,
      opts: { attempts: 8 },
      token: 'job-token',
      moveToDelayed,
    } as unknown as Job<PublisherChatCommentJob>;

    await expect(processor.process(job, 'worker-token')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(job.attemptsMade).toBe(7);
    expect(delivery.process).not.toHaveBeenCalled();
  });
});
