import type { ChatSettings } from '../prisma/prisma-client';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';
import { extractNavigationEvidence } from './navigation/navigation-evidence.extractor';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import {
  DUPLICATE_STATE_BUDGET_MS,
  DuplicateStateBudgetExceededError,
  RuleEngineDuplicateDetector,
} from './rule-engine-duplicate-detector';

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
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
    ...overrides,
  } as ChatSettings;
}

class InMemoryRevisionedRedisCounter {
  private readonly states = new Map<
    string,
    { revision: number; membershipKeys: string[]; countSnapshots: Map<string, number> }
  >();
  private readonly memberships = new Map<string, Map<string, number>>();

  async replaceRevisionedSetMembershipsBeforeDeadline(params: {
    stateKey: string;
    member: string;
    revision: number;
    membershipKeys: readonly string[];
    windowSeconds: number;
    ttlSeconds: number;
  }) {
    const current = this.states.get(params.stateKey);
    if (current && params.revision < current.revision) {
      return { kind: 'stale' as const };
    }
    if (current && params.revision === current.revision) {
      const sameKeys =
        current.membershipKeys.length === params.membershipKeys.length &&
        current.membershipKeys.every((key) => params.membershipKeys.includes(key));
      if (!sameKeys) {
        return { kind: 'stale' as const };
      }
      return {
        kind: 'replayed' as const,
        counts: params.membershipKeys.map((key) => current.countSnapshots.get(key) ?? 0),
      };
    }

    for (const key of current?.membershipKeys ?? []) {
      const membership = this.memberships.get(key);
      membership?.delete(params.member);
      if (membership?.size === 0) {
        this.memberships.delete(key);
      }
    }
    for (const key of params.membershipKeys) {
      const membership = this.memberships.get(key) ?? new Map<string, number>();
      membership.set(params.member, params.revision);
      this.memberships.set(key, membership);
    }

    const windowMs = params.windowSeconds * 1_000;
    const cutoffMs = params.revision - windowMs;
    const countSnapshots = new Map(
      params.membershipKeys.map((key) => {
        const count = Array.from(this.memberships.get(key)?.values() ?? []).filter(
          (timestampMs) => timestampMs > cutoffMs && timestampMs <= params.revision,
        ).length;
        return [key, count];
      }),
    );
    this.states.set(params.stateKey, {
      revision: params.revision,
      membershipKeys: [...params.membershipKeys],
      countSnapshots,
    });
    return {
      kind: 'applied' as const,
      counts: params.membershipKeys.map((key) => countSnapshots.get(key) ?? 0),
    };
  }
}

function navigationTarget(url: string): NavigationTargetEvidence {
  return {
    kind: 'external_url',
    target: url,
    normalizedTarget: new URL(url).toString(),
    enforceable: true,
    origins: [],
  };
}

function navigationTargetsFromMessage(
  message: Record<string, unknown>,
): NavigationTargetEvidence[] {
  return extractNavigationEvidence(adaptMaxMessageNavigationView(message)).targets;
}

function detectRevision(params: {
  detector: RuleEngineDuplicateDetector;
  messageId: string;
  revision: number;
  text: string;
  settings?: ChatSettings;
  trackCurrentText?: boolean;
}) {
  return params.detector.detectWithin({
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: params.messageId,
    eventTimestampMs: params.revision,
    rawText: params.text,
    compactText: params.text,
    settings: params.settings ?? buildSettings(),
    trackCurrentText: params.trackCurrentText,
  });
}

describe('RuleEngineDuplicateDetector', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits for the side-effecting Redis result and enforces the same message', async () => {
    let finishMutation: ((result: { kind: 'applied'; counts: number[] }) => void) | undefined;
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest.fn(
        () =>
          new Promise<{ kind: 'applied'; counts: number[] }>((resolve) => {
            finishMutation = resolve;
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
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'same message',
        compactText: 'same message',
        settings: buildSettings(),
      })
      .finally(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    finishMutation?.({ kind: 'applied', counts: [2] });

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

  it('returns a deletion hit when every optional reaction is disabled', async () => {
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockResolvedValue({ kind: 'applied', counts: [2] }),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'same sufficiently detailed repeated message',
        compactText: 'same sufficiently detailed repeated message',
        settings: buildSettings({
          duplicateWarnEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
          duplicateWarnMaxCount: 1,
        }),
      }),
    ).resolves.toEqual({
      hit: {
        count: 1,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'exact',
      },
    });
  });

  it('selects the strongest sanction across every matched fingerprint', async () => {
    const mutate = jest.fn().mockResolvedValue({ kind: 'applied', counts: [2, 4] });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-4',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'Короткое объявление https://example.com/sale',
        compactText: 'короткое объявление https://example.com/sale',
        settings: buildSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: true,
        }),
      }),
    ).resolves.toEqual({
      hit: {
        count: 3,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'link',
      },
      decision: {
        action: 'BAN',
        count: 3,
        threshold: 3,
        windowSec: 60,
        hash: expect.any(String),
        fingerprintType: 'link',
        nextAction: null,
      },
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipKeys: [expect.any(String), expect.any(String)],
        windowSeconds: 60,
        ttlSeconds: 181,
        countLimit: 21,
      }),
    );
  });

  it('never invents a stronger sanction than the enabled ladder permits', async () => {
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockResolvedValue({ kind: 'applied', counts: [2, 40] }),
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-40',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'Короткое объявление https://example.com/sale',
        compactText: 'короткое объявление https://example.com/sale',
        settings: buildSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
          duplicateMuteEnabled: true,
          duplicateBanEnabled: false,
        }),
      }),
    ).resolves.toMatchObject({
      hit: { count: 39, fingerprintType: 'link' },
      decision: { action: 'MUTE', count: 39, fingerprintType: 'link', nextAction: null },
    });
  });

  it('keeps insufficient STRICT text exact-only instead of creating fuzzy content history', async () => {
    const mutate = jest.fn().mockResolvedValue({ kind: 'applied', counts: [2] });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'short-message',
        eventTimestampMs: 1_800_000_000_000,
        rawText: 'ок https://example.com/one',
        compactText: 'ок https://example.com/one',
        settings: buildSettings({ duplicateDetectionPreset: 'STRICT' }),
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ membershipKeys: [expect.stringContaining(':fingerprint:exact:')] }),
    );
  });

  it('keeps equal visible text with different structured links out of the exact history', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({
      duplicateWarnEnabled: false,
      duplicateWarnMaxCount: 1,
    });

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        eventTimestampMs: 100,
        rawText: 'Подробнее',
        compactText: 'подробнее',
        settings,
        navigationTargets: [navigationTarget('https://example.com/one')],
      }),
    ).resolves.toEqual({});
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 200,
        rawText: 'Подробнее',
        compactText: 'подробнее',
        settings,
        navigationTargets: [navigationTarget('https://example.com/two')],
      }),
    ).resolves.toEqual({});
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-3',
        eventTimestampMs: 300,
        rawText: 'Подробнее',
        compactText: 'подробнее',
        settings,
        navigationTargets: [navigationTarget('https://example.com/two')],
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('matches the same structured link across different visible text in custom mode', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnoreLinksEnabled: true,
      duplicateWarnEnabled: false,
      duplicateWarnMaxCount: 1,
    });
    const target = navigationTarget('https://example.com/same');

    await detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      eventTimestampMs: 100,
      rawText: 'Первая подпись',
      compactText: 'первая подпись',
      settings,
      navigationTargets: [target],
    });
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 200,
        rawText: 'Другая подпись',
        compactText: 'другая подпись',
        settings,
        navigationTargets: [target],
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'link' } });
  });

  it.each([
    [
      'open_app contact',
      { type: 'open_app', web_app: 'https://apps.example/start', contact_id: 101 },
      { type: 'open_app', web_app: 'https://apps.example/start', contact_id: 202 },
    ],
    [
      'chat-create payload',
      { type: 'chat', chat_title: 'Первая группа', start_payload: 'first' },
      { type: 'chat', chat_title: 'Вторая группа', start_payload: 'second' },
    ],
  ] as const)(
    'keeps equal text with a different hidden %s action out of exact history',
    async (_name, firstButton, secondButton) => {
      const detector = new RuleEngineDuplicateDetector(
        new InMemoryRevisionedRedisCounter() as never,
      );
      const settings = buildSettings({ duplicateWarnEnabled: false, duplicateWarnMaxCount: 1 });
      const targets = (button: Record<string, unknown>) =>
        navigationTargetsFromMessage({
          body: {
            text: 'Открыть',
            attachments: [{ type: 'inline_keyboard', payload: { buttons: [[button]] } }],
          },
        });

      await expect(
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-hidden-1',
          eventTimestampMs: 100,
          rawText: 'Открыть',
          compactText: 'открыть',
          settings,
          navigationTargets: targets(firstButton),
        }),
      ).resolves.toEqual({});
      await expect(
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-hidden-2',
          eventTimestampMs: 200,
          rawText: 'Открыть',
          compactText: 'открыть',
          settings,
          navigationTargets: targets(secondButton),
        }),
      ).resolves.toEqual({});
      await expect(
        detector.detectWithin({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-hidden-3',
          eventTimestampMs: 300,
          rawText: 'Открыть',
          compactText: 'открыть',
          settings,
          navigationTargets: targets(secondButton),
        }),
      ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
    },
  );

  it('keeps normalized visible text semantics when a structured action is unchanged', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({ duplicateWarnEnabled: false, duplicateWarnMaxCount: 1 });
    const targets = (text: string) =>
      navigationTargetsFromMessage({
        body: {
          text,
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'link', url: 'https://example.com/same' }]],
              },
            },
          ],
        },
      });

    await detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'normalized-hidden-1',
      eventTimestampMs: 100,
      rawText: 'Подробнее',
      compactText: 'подробнее',
      settings,
      navigationTargets: targets('Подробнее'),
    });
    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'normalized-hidden-2',
        eventTimestampMs: 200,
        rawText: 'ПОДРОБНЕЕ!',
        compactText: 'подробнее',
        settings,
        navigationTargets: targets('ПОДРОБНЕЕ!'),
      }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it.each([
    [
      'Команда завтра утром принимает новые заявки возле главного входа после общей встречи',
      'Команда завтра утром не принимает новые заявки возле главного входа после общей встречи',
    ],
    [
      'Команда собирается завтра утром в зале 10 возле главного входа после общей встречи',
      'После общей встречи команда собирается завтра утром в зале 11 возле главного входа',
    ],
  ])('does not near-match text when a short semantic token changes', async (first, second) => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const settings = buildSettings({ duplicateDetectionPreset: 'STRICT' });

    await detectRevision({
      detector,
      messageId: 'message-1',
      revision: 100,
      text: first,
      settings,
    });
    await expect(
      detectRevision({
        detector,
        messageId: 'message-2',
        revision: 200,
        text: second,
        settings,
      }),
    ).resolves.toEqual({});
  });

  it('uses event timestamps rather than delayed processing time for the duplicate window', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 161_001, text }),
    ).resolves.toEqual({});
  });

  it('excludes a predecessor exactly on the event-time window boundary', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 160_000, text }),
    ).resolves.toEqual({});
  });

  it('does not make an earlier message actionable because a later event was processed first', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-later', revision: 150_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-earlier', revision: 100_000, text }),
    ).resolves.toEqual({});
  });

  it('does not merge both sides of an event into a double-width duplicate window', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-later', revision: 200_000, text });
    await detectRevision({ detector, messageId: 'message-earlier', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-middle', revision: 150_000, text }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('counts only chronological predecessors in a reverse-processed cluster', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed repeated message';

    await detectRevision({ detector, messageId: 'message-later', revision: 150_000, text });
    await detectRevision({ detector, messageId: 'message-earlier', revision: 100_000, text });
    await expect(
      detectRevision({ detector, messageId: 'message-middle', revision: 125_000, text }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });

    await expect(
      detectRevision({ detector, messageId: 'message-newest', revision: 159_000, text }),
    ).resolves.toMatchObject({ hit: { count: 3, fingerprintType: 'exact' } });
  });

  it('moves a message membership from its created text to its edited text', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const firstText = 'original detailed message';
    const editedText = 'edited detailed message';

    await expect(
      detectRevision({ detector, messageId: 'message-1', revision: 100, text: firstText }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-1', revision: 200, text: editedText }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 300, text: editedText }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });

    await expect(
      detectRevision({ detector, messageId: 'message-3', revision: 400, text: firstText }),
    ).resolves.toEqual({});
  });

  it('restores the original membership when a later edit rolls text back', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const firstText = 'original detailed message';
    const editedText = 'edited detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100, text: firstText });
    await detectRevision({ detector, messageId: 'message-1', revision: 200, text: editedText });
    await detectRevision({ detector, messageId: 'message-1', revision: 300, text: firstText });

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 400, text: firstText }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('does not let a stale edit replace the latest message membership', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const latestText = 'latest detailed message';
    const staleText = 'stale detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 200, text: latestText });
    await expect(
      detectRevision({ detector, messageId: 'message-1', revision: 100, text: staleText }),
    ).resolves.toEqual({});

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 300, text: staleText }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-3', revision: 400, text: latestText }),
    ).resolves.toMatchObject({ hit: { count: 1, fingerprintType: 'exact' } });
  });

  it('replays the first message outcome instead of current membership counts', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed message';

    await expect(
      detectRevision({ detector, messageId: 'message-a', revision: 100, text }),
    ).resolves.toEqual({});
    await expect(
      detectRevision({ detector, messageId: 'message-b', revision: 200, text }),
    ).resolves.toMatchObject({ hit: { count: 1 } });

    await expect(
      detectRevision({ detector, messageId: 'message-a', revision: 100, text }),
    ).resolves.toEqual({});
  });

  it('replays the original duplicate outcome after later counts grow', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'same detailed message';

    await detectRevision({ detector, messageId: 'message-a', revision: 100, text });
    const originalDuplicate = await detectRevision({
      detector,
      messageId: 'message-b',
      revision: 200,
      text,
    });
    await expect(
      detectRevision({ detector, messageId: 'message-c', revision: 300, text }),
    ).resolves.toMatchObject({ hit: { count: 2 } });

    await expect(
      detectRevision({ detector, messageId: 'message-b', revision: 200, text }),
    ).resolves.toEqual(originalDuplicate);
    expect(originalDuplicate).toMatchObject({ hit: { count: 1 } });
  });

  it('treats an equal-revision payload with different text as stale', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const originalText = 'original detailed message';
    const conflictingText = 'conflicting detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100, text: originalText });
    await expect(
      detectRevision({
        detector,
        messageId: 'message-1',
        revision: 100,
        text: conflictingText,
      }),
    ).resolves.toEqual({});

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 200, text: originalText }),
    ).resolves.toMatchObject({ hit: { count: 1 } });
    await expect(
      detectRevision({ detector, messageId: 'message-3', revision: 300, text: conflictingText }),
    ).resolves.toEqual({});
  });

  it('clears the previous membership when the current edit cannot be tracked', async () => {
    const detector = new RuleEngineDuplicateDetector(new InMemoryRevisionedRedisCounter() as never);
    const text = 'original detailed message';

    await detectRevision({ detector, messageId: 'message-1', revision: 100, text });
    await expect(
      detectRevision({
        detector,
        messageId: 'message-1',
        revision: 200,
        text: 'blocked edit',
        trackCurrentText: false,
      }),
    ).resolves.toEqual({});

    await expect(
      detectRevision({ detector, messageId: 'message-2', revision: 300, text }),
    ).resolves.toEqual({});
  });

  it('propagates Redis failures so the webhook can retry the same message', async () => {
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockRejectedValue(new Error('redis unavailable')),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-2',
        eventTimestampMs: 1_800_000_000_000,
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
      replaceRevisionedSetMembershipsBeforeDeadline: jest.fn(
        () => new Promise<never>(() => undefined),
      ),
    };
    const detector = new RuleEngineDuplicateDetector(redisCounter as never, onBudgetExceeded);
    const detection = detector.detectWithin({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-timeout',
      eventTimestampMs: 1_800_000_000_000,
      rawText: 'same message',
      compactText: 'same message',
      settings: buildSettings(),
    });
    const rejected = expect(detection).rejects.toBeInstanceOf(DuplicateStateBudgetExceededError);

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
    let finishLateResponse: ((result: { kind: 'applied'; counts: number[] }) => void) | undefined;
    const mutate = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ kind: 'applied'; counts: number[] }>((resolve) => {
            finishLateResponse = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: 'replayed', counts: [2] });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);
    const request = {
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-replayed',
      eventTimestampMs: 1_800_000_000_000,
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

    finishLateResponse?.({ kind: 'applied', counts: [2] });
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('propagates a server-side deadline refusal without attempting later fingerprints', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mutate = jest.fn().mockResolvedValue({ kind: 'deadline_exceeded' });
    const detector = new RuleEngineDuplicateDetector({
      replaceRevisionedSetMembershipsBeforeDeadline: mutate,
    } as never);

    await expect(
      detector.detectWithin({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-expired',
        eventTimestampMs: 1_800_000_000_000,
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

    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
