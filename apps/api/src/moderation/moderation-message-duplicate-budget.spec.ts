import {
  ModerationService,
  createSettings,
  createUpdate,
  expectImmediateDeleteMessage,
} from './moderation.service.spec-support';
import type { MessageDuplicateService } from './message-duplicate/message-duplicate.service';
import type { DuplicateModerationActionRequest } from './duplicate-moderation.actions';
import type { WebhookHotPathProfile } from './moderation.service.support';
import type { MaxClientService } from '../max/max-client.service';

// FLAG: This fixture checks callback orchestration; the native duplicate dispatch suite owns
// durable intent, source, permission and notice authority through real PostgreSQL and Redis.
jest.mock('./message-duplicate/message-duplicate-notice-proof', () => ({
  ...jest.requireActual('./message-duplicate/message-duplicate-notice-proof'),
  buildMessageDuplicateNoticeContext: jest.fn(async () => ({
    orchestrationFixture: 'duplicate-notice-budget',
  })),
}));

type ProfileService = {
  createWebhookHotPathProfile(): WebhookHotPathProfile;
  applySanctionAction(params: unknown): Promise<boolean>;
};

function fixture(action: 'hit' | 'WARN' | 'MUTE' | 'BAN' = 'hit') {
  const startedAt = Date.now();
  const settings = createSettings({ duplicateBotMessageEnabled: true });
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Chat 1',
        settings,
        domains: [],
      }),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
  };
  let finishExplanation!: () => void;
  const explanation = new Promise<void>((resolve) => {
    finishExplanation = resolve;
  });
  const authorizeDelete = jest.fn().mockResolvedValue(true);
  const max = {
    deleteMessage: jest.fn<
      ReturnType<MaxClientService['deleteMessage']>,
      Parameters<MaxClientService['deleteMessage']>
    >(async (_chatId, _messageId, options) => {
      await options?.beforeImmediateDeleteMutation?.();
      jest.setSystemTime(startedAt + 9_500);
    }),
    sendMessage: jest.fn(() => explanation),
  };
  const service = new ModerationService(
    prisma as never,
    { detect: jest.fn().mockResolvedValue({ violations: [] }) } as never,
    { resolveAction: jest.fn() } as never,
    max as never,
    undefined,
    undefined,
    {
      get: (key: string) => (key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10_000 : undefined),
    } as never,
  );
  const internal = service as unknown as ProfileService;
  const sanction = jest.spyOn(internal, 'applySanctionAction').mockResolvedValue(true);
  let request: DuplicateModerationActionRequest;
  const duplicates = {
    isAuthoritative: jest.fn().mockResolvedValue(true),
    observe: jest.fn<
      ReturnType<MessageDuplicateService['observe']>,
      Parameters<MessageDuplicateService['observe']>
    >(async (params) => {
      const message = params.update.message!;
      const common = {
        update: params.update,
        chatId: message.chatId,
        userId: message.senderId,
        messageId: message.messageId,
        settings: params.settings,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
        actionClaimed: true,
        authorizeDelete,
      };
      request =
        action === 'hit'
          ? {
              ...common,
              outcome: {
                kind: 'hit',
                hit: {
                  count: 1,
                  windowSec: 60,
                  hash: 'callback-budget',
                  fingerprintType: 'exact',
                },
              },
            }
          : {
              ...common,
              outcome: {
                kind: 'decision',
                decision: {
                  action,
                  count: 3,
                  threshold: 3,
                  windowSec: 60,
                  hash: 'callback-budget',
                  fingerprintType: 'exact',
                  nextAction: null,
                },
              },
              authorizeSanction: jest.fn().mockResolvedValue(true),
            };
      await params.executeFullAction!(request);
      return 'ENFORCEMENT_REQUESTED';
    }),
  } satisfies Pick<MessageDuplicateService, 'observe' | 'isAuthoritative'>;
  Object.assign(service, {
    messageDuplicateService: duplicates,
    logger: { warn: jest.fn(), debug: jest.fn() },
  });
  const profile = internal.createWebhookHotPathProfile();
  const update = { ...createUpdate(), botId: 'fixture-bot' };
  return {
    service,
    max,
    duplicates,
    profile,
    update,
    authorizeDelete,
    finishExplanation,
    sanction,
    request: () => request,
  };
}

describe('inline message duplicate callback budget', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['hit', 'WARN', 'MUTE'] as const)(
    'finishes the %s webhook within its remaining budget after confirmed deletion while the explanation is pending',
    async (action) => {
      const s = fixture(action);
      let finished = false;
      const handling = s.service.handleUpdate(s.update, s.profile).then(() => {
        finished = true;
      });
      try {
        await jest.advanceTimersByTimeAsync(0);
        expectImmediateDeleteMessage(s.max.deleteMessage, 'chat-1', 'msg-1');
        expect(s.authorizeDelete).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(499);
        expect(finished).toBe(true);
        expect(s.profile.successBoundaryReached).toBe(true);
        expect(s.profile.successBoundaryStage).toBe('duplicate-delete');
        expect(s.max.sendMessage).toHaveBeenCalledTimes(1);
      } finally {
        s.finishExplanation();
        await jest.runAllTimersAsync();
        await handling;
      }
      expect(s.duplicates.observe).toHaveBeenCalledTimes(1);
      expect(s.max.deleteMessage).toHaveBeenCalledTimes(1);
      expect(s.max.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['WARN', 'MUTE', 'BAN'] as const)(
    'keeps the critical %s pending beyond the optional explanation budget',
    async (action) => {
      const s = fixture(action);
      let finishSanction!: (persisted: boolean) => void;
      s.sanction.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishSanction = resolve;
          }),
      );
      let finished = false;
      const handling = s.service.handleUpdate(s.update, s.profile).then(() => {
        finished = true;
      });
      try {
        await jest.advanceTimersByTimeAsync(2_500);
        expect(s.sanction).toHaveBeenCalledTimes(1);
        expect(finished).toBe(false);
        expect(s.max.sendMessage).not.toHaveBeenCalled();
      } finally {
        finishSanction(true);
        s.finishExplanation();
        await jest.runAllTimersAsync();
        await handling;
      }
      expect(s.max.deleteMessage).toHaveBeenCalledTimes(1);
      expect(s.sanction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['WARN', 'MUTE', 'BAN'] as const)(
    'preserves a failed critical %s without starting an optional explanation',
    async (action) => {
      const s = fixture(action);
      const failure = new Error('Critical sanction failed');
      s.sanction.mockRejectedValue(failure);
      const handling = s.service.handleUpdate(s.update, s.profile);
      const rejected = expect(handling).rejects.toBe(failure);
      await jest.advanceTimersByTimeAsync(0);
      await rejected;
      expect(s.sanction).toHaveBeenCalledTimes(1);
      expect(s.max.sendMessage).not.toHaveBeenCalled();
      s.finishExplanation();
      await jest.runAllTimersAsync();
    },
  );

  it('does not mark refused deletion as success or send its explanation', async () => {
    const s = fixture();
    s.authorizeDelete.mockResolvedValue(false);
    const handling = s.service.handleUpdate(s.update, s.profile);
    await jest.runAllTimersAsync();
    await handling;
    expect(s.profile.successBoundaryReached).toBe(false);
    expect(s.profile.successBoundaryStage).toBeNull();
    expect(s.max.sendMessage).not.toHaveBeenCalled();
    s.finishExplanation();
  });

  it('keeps the background action awaited without a webhook profile', async () => {
    const s = fixture();
    s.finishExplanation();
    const initial = s.service.handleUpdate(s.update, s.profile);
    await jest.runAllTimersAsync();
    await initial;
    let release!: () => void;
    s.max.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let finished = false;
    const background = s.service
      .executeDuplicateAction({ ...s.request(), backgroundExecution: true })
      .then(() => {
        finished = true;
      });
    try {
      await jest.advanceTimersByTimeAsync(2_500);
      expect(finished).toBe(false);
      expect(s.max.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await jest.runAllTimersAsync();
      await background;
    }
  });
});
