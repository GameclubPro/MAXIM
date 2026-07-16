import type { ChatSettings } from '../prisma/prisma-client';
import {
  DUPLICATE_STATE_BUDGET_MS,
  DuplicateStateBudgetExceededError,
  RuleEngineDuplicateDetector,
} from './rule-engine-duplicate-detector';

function buildSettings(): ChatSettings {
  return {
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateWarnWindowSec: 60,
    duplicateMuteWindowSec: 60,
    duplicateBanWindowSec: 60,
    duplicateWarnMaxCount: 1,
    duplicateMuteMaxCount: 2,
    duplicateBanMaxCount: 3,
    duplicateDetectionPreset: 'STANDARD',
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
  } as ChatSettings;
}

describe('RuleEngineDuplicateDetector', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits for the side-effecting Redis result and enforces the same message', async () => {
    let finishIncrement: ((result: { inserted: boolean; count: number }) => void) | undefined;
    const redisCounter = {
      incrementOncePerMemberWithTtl: jest.fn(
        () =>
          new Promise<{ inserted: boolean; count: number }>((resolve) => {
            finishIncrement = resolve;
          }),
      ),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);
    let settled = false;

    const detection = detector
      .detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        rawText: 'same message',
        compactText: 'same message',
        settings: buildSettings(),
      })
      .finally(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    finishIncrement?.({ inserted: true, count: 2 });

    await expect(detection).resolves.toEqual({
      hit: {
        count: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
      },
      decision: {
        action: 'WARN',
        count: 1,
        threshold: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
        nextAction: null,
      },
    });
  });

  it('propagates Redis failures so the webhook can retry the same message', async () => {
    const redisCounter = {
      incrementOncePerMemberWithTtl: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        rawText: 'same message',
        compactText: 'same message',
        settings: buildSettings(),
      }),
    ).rejects.toThrow('redis unavailable');
  });

  it('rejects within the shared budget when a deadline-aware Redis command stalls', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onBudgetExceeded = jest.fn();
    const redisCounter = {
      incrementOncePerMemberWithTtlBeforeDeadline: jest.fn(
        () => new Promise<never>(() => undefined),
      ),
    };
    const detector = new RuleEngineDuplicateDetector(
      redisCounter as never,
      onBudgetExceeded,
    );
    const detection = detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-timeout',
      rawText: 'same message',
      compactText: 'same message',
      settings: buildSettings(),
    });
    const rejected = expect(detection).rejects.toBeInstanceOf(
      DuplicateStateBudgetExceededError,
    );

    await jest.advanceTimersByTimeAsync(DUPLICATE_STATE_BUDGET_MS);

    await rejected;
    expect(onBudgetExceeded).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      timeoutMs: DUPLICATE_STATE_BUDGET_MS,
      source: 'caller_deadline',
    });
  });

  it('replays the original counter value after a response arrives beyond the caller deadline', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let finishLateResponse:
      | ((result: { kind: 'inserted'; count: number }) => void)
      | undefined;
    const increment = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ kind: 'inserted'; count: number }>((resolve) => {
            finishLateResponse = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: 'replayed', count: 2 });
    const detector = new RuleEngineDuplicateDetector({
      incrementOncePerMemberWithTtlBeforeDeadline: increment,
    } as never);
    const request = {
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-replayed',
      rawText: 'same message',
      compactText: 'same message',
      settings: buildSettings(),
    };
    const firstAttempt = detector.detectWithin(request);
    const firstRejected = expect(firstAttempt).rejects.toBeInstanceOf(
      DuplicateStateBudgetExceededError,
    );

    await jest.advanceTimersByTimeAsync(DUPLICATE_STATE_BUDGET_MS);
    await firstRejected;

    await expect(detector.detectWithin(request)).resolves.toEqual({
      hit: {
        count: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
      },
      decision: {
        action: 'WARN',
        count: 1,
        threshold: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
        nextAction: null,
      },
    });

    finishLateResponse?.({ kind: 'inserted', count: 2 });
    await Promise.resolve();
    expect(increment).toHaveBeenCalledTimes(2);
  });

  it('propagates a server-side deadline refusal without attempting later fingerprints', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const increment = jest.fn().mockResolvedValue({ kind: 'deadline_exceeded' });
    const detector = new RuleEngineDuplicateDetector({
      incrementOncePerMemberWithTtlBeforeDeadline: increment,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-expired',
        rawText: 'same message https://example.com',
        compactText: 'same message https://example.com',
        settings: {
          ...buildSettings(),
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        } as ChatSettings,
      }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_STATE_BUDGET_EXCEEDED',
      source: 'redis_deadline',
      retryable: true,
    });

    expect(increment).toHaveBeenCalledTimes(1);
  });
});
