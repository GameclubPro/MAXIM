import { PhotoDuplicateModerationActionsService } from './photo-duplicate-moderation-actions.service';

function createService(params: { createMany: jest.Mock; findUnique?: jest.Mock }) {
  const prisma = {
    moderationViolationMessageClaim: {
      createMany: params.createMany,
      findUnique: params.findUnique ?? jest.fn(),
    },
  };
  return {
    service: new PhotoDuplicateModerationActionsService(prisma as never, {} as never),
    findUnique: prisma.moderationViolationMessageClaim.findUnique,
  };
}

describe('PhotoDuplicateModerationActionsService', () => {
  it('persists a binding-specific action claim without a Redis fallback', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const { findUnique, service } = createService({ createMany });

    await expect(
      service.claimPhotoDuplicateAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        actionBinding: { intendedAction: 'MUTE', configDigest: 'a'.repeat(64) },
      }),
    ).resolves.toBe('claimed');

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          dedupeKey: expect.stringMatching(/^photo-duplicate-action:v2:[a-f0-9]{64}$/u),
          messageActionKey: expect.stringMatching(/^v1:[a-f0-9]{64}$/u),
          ruleCode: 'DUPLICATE_MESSAGE_ACTION',
          updateType: 'message_action',
        }),
      ],
      skipDuplicates: true,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'duplicate insert', createError: null },
    { label: 'ambiguous insert error', createError: new Error('connection reset') },
  ])('resumes the exact durable claim after a $label', async ({ createError }) => {
    let attemptedClaim: Record<string, unknown> | undefined;
    const createMany = jest
      .fn()
      .mockImplementation(async (args: { data: Array<Record<string, unknown>> }) => {
        attemptedClaim = args.data[0];
        if (createError) throw createError;
        return { count: 0 };
      });
    const { service } = createService({
      createMany,
      findUnique: jest.fn().mockImplementation(async () => attemptedClaim),
    });

    await expect(
      service.claimPhotoDuplicateAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        actionBinding: { intendedAction: 'HIT', configDigest: 'b'.repeat(64) },
      }),
    ).resolves.toBe('resumed');
  });

  it('treats a generic message-action winner as blocking', async () => {
    let attemptedClaim: Record<string, unknown> | undefined;
    const { service } = createService({
      createMany: jest.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        attemptedClaim = args.data[0];
        return { count: 0 };
      }),
      findUnique: jest.fn().mockImplementation(async () => ({
        ...attemptedClaim,
        dedupeKey: 'v1:generic-rule-claim',
      })),
    });

    await expect(
      service.claimPhotoDuplicateAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        actionBinding: { intendedAction: 'BAN', configDigest: 'd'.repeat(64) },
      }),
    ).resolves.toBe('blocked');
  });

  it('retries an ambiguous insert when PostgreSQL cannot confirm the owner', async () => {
    const createError = new Error('connection reset before commit status was known');
    const { service } = createService({
      createMany: jest.fn().mockRejectedValue(createError),
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.claimPhotoDuplicateAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        actionBinding: { intendedAction: 'WARN', configDigest: 'e'.repeat(64) },
      }),
    ).rejects.toBe(createError);
  });
});
