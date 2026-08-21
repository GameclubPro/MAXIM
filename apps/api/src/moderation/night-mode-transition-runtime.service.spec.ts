import type { PrismaService } from '../prisma/prisma.service';
import { ChatEntityType } from '../prisma/prisma-client';
import { MaxActionNoExecutableRouteError } from '../max/max-action-dispatch-error';
import {
  buildNightModeTransitionJobId,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
  NIGHT_MODE_TRANSITION_PROCESS_STOP,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';
import { buildNightModeTransitionScheduleFingerprint } from './night-mode-transition-generation.util';
import {
  NightModeTransitionRuntimeService,
  type NightModeTransitionRuntimeHooks,
  type NightModeTransitionRuntimeSettings,
} from './night-mode-transition-runtime.service';
import { NightModeTransitionStaleStateError } from './night-mode-transition-stale-state-error';
import { parseNightModeTransitionState } from './moderation.service.support';

const OPEN_JOB: NightModeTransitionJob = {
  chatId: 'chat-1',
  transition: 'open',
  scheduledFor: '2026-05-31T05:00:00.000Z',
  sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
};

const CLOSE_JOB: NightModeTransitionJob = {
  chatId: 'chat-1',
  transition: 'close',
  scheduledFor: '2026-05-30T20:00:00.000Z',
  sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
};

const CLOSE_RECOVERY = {
  kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  version: 1 as const,
  sessionKey: CLOSE_JOB.sessionKey,
  messageId: 'night-close-recovery-only-1',
  botId: 'bot-recovery-only-1',
  timezone: 'Europe/Moscow',
  startMinutes: 23 * 60,
  endMinutes: 8 * 60,
};

function createSettings(
  overrides: Partial<NightModeTransitionRuntimeSettings> = {},
): NightModeTransitionRuntimeSettings {
  return {
    chatId: 'chat-1',
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: true,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeBotButtons: null,
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: '',
    nightModeRulesButtonEnabled: false,
    commentsEnabled: false,
    botSpeechStyle: 'ROBOT',
    botSpeechMedia: null,
    updatedAt: new Date('2026-05-30T19:00:00.000Z'),
    chat: {
      entityType: ChatEntityType.CHAT,
      rules: null,
    },
    ...overrides,
  };
}

function createVersionedJob(job: NightModeTransitionJob = OPEN_JOB): NightModeTransitionJob {
  return {
    ...job,
    transitionRuntimeVersion: 3,
    scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(createSettings()),
  };
}

function createHooks(
  overrides: Partial<NightModeTransitionRuntimeHooks> = {},
): NightModeTransitionRuntimeHooks {
  return {
    recoverClosedNoticeEvent: jest.fn().mockResolvedValue({
      eventId: 'night-close-event-recovered-default',
      sessionKey: CLOSE_JOB.sessionKey,
      messageId: 'night-close-recovered-default',
      botId: 'bot-1',
    }),
    recoverClosedNoticeEventFromLedger: jest.fn().mockResolvedValue(null),
    sendClosedNotice: jest.fn().mockResolvedValue({
      ...NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
      messageId: null,
      botId: null,
    }),
    sendOpenedNotice: jest.fn().mockResolvedValue(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE),
    deleteClosedNotice: jest.fn().mockResolvedValue(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE),
    ...overrides,
  };
}

function createRedisCounterMock() {
  const stringCache = new Map<string, string>();
  const locks = new Set<string>();

  return {
    stringCache,
    getString: jest.fn(async (key: string) => stringCache.get(key) ?? null),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      stringCache.set(key, value);
    }),
    acquireLock: jest.fn(async (key: string) => {
      if (locks.has(key)) {
        return null;
      }

      locks.add(key);
      return `lock-${key}`;
    }),
    renewLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn(async (key: string) => {
      locks.delete(key);
    }),
  };
}

function createPrisma(params: { findFirst?: jest.Mock } = {}) {
  return {
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(createSettings()),
    },
    moderationEvent: {
      findFirst: params.findFirst ?? jest.fn().mockResolvedValue(null),
    },
  };
}

describe('NightModeTransitionRuntimeService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('parses exact v2 close-event recovery details and preserves pending legacy markers', () => {
    expect(
      parseNightModeTransitionState({
        status: 'closed',
        sessionKey: CLOSE_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-1',
      }),
    ).toEqual({
      status: 'closed',
      sessionKey: CLOSE_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-1',
      closeNoticeBotId: null,
    });
    expect(
      parseNightModeTransitionState({
        status: 'closed',
        sessionKey: CLOSE_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-1',
        closeNoticeBotId: 'bot-1',
        closeNoticeEventRecovery: { version: 1, pending: true },
      }),
    ).toEqual({
      status: 'closed',
      sessionKey: CLOSE_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-1',
      closeNoticeBotId: 'bot-1',
      closeNoticeEventRecovery: { version: 'unsupported', pending: true },
    });
    expect(
      parseNightModeTransitionState({
        status: 'closed',
        sessionKey: CLOSE_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-1',
        closeNoticeBotId: 'bot-1',
        closeNoticeEventRecovery: {
          version: 2,
          pending: true,
          timezone: ' Europe/Moscow ',
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
        },
      }),
    ).toEqual({
      status: 'closed',
      sessionKey: CLOSE_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-1',
      closeNoticeBotId: 'bot-1',
      closeNoticeEventRecovery: {
        version: 2,
        pending: true,
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      },
    });
  });

  it('uses the strict recovery hook instead of re-entering close delivery for a pending event', async () => {
    jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    const prisma = createPrisma();
    prisma.moderationEvent.findFirst
      .mockResolvedValueOnce({
        id: 'night-close-event-recovered-1',
        messageId: 'night-close-recovered-1',
        botId: 'bot-1',
      })
      .mockResolvedValueOnce(null);
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: CLOSE_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-recovered-1',
        closeNoticeBotId: 'bot-1',
        closeNoticeEventRecovery: {
          version: 2,
          pending: true,
          timezone: 'Europe/Moscow',
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
        },
      }),
    );
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest.fn().mockResolvedValue({
        eventId: 'night-close-event-recovered-1',
        sessionKey: CLOSE_JOB.sessionKey,
        messageId: 'night-close-recovered-1',
        botId: 'bot-1',
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(CLOSE_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(hooks.recoverClosedNoticeEvent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: CLOSE_JOB.sessionKey,
      messageId: 'night-close-recovered-1',
      botId: 'bot-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    const persistedState = redisCounter.stringCache.get('night-mode-transition-state:v1:chat-1');
    expect(persistedState).toContain('"closeNoticeMessageId":"night-close-recovered-1"');
    expect(persistedState).not.toContain('closeNoticeEventRecovery');

    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );
    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith(
      'chat-1',
      'night-close-recovered-1',
      'bot-1',
      expect.objectContaining({
        event: expect.objectContaining({ id: 'night-close-event-recovered-1' }),
      }),
      expect.any(Function),
    );
  });

  it('recovers a pending accepted event before the closed notice-disabled early return', async () => {
    jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: CLOSE_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-disabled-1',
        closeNoticeBotId: 'bot-1',
        closeNoticeEventRecovery: {
          version: 2,
          pending: true,
          timezone: 'Europe/Moscow',
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
        },
      }),
    );
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest.fn().mockResolvedValue({
        eventId: 'night-close-event-disabled-1',
        sessionKey: CLOSE_JOB.sessionKey,
        messageId: 'night-close-disabled-1',
        botId: 'bot-1',
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(
      service.processNightModeTransitionForChat(
        createSettings({ nightModeBotMessageEnabled: false }),
        hooks,
        service.resolveNightModeTransitionSnapshot(
          createSettings({ nightModeBotMessageEnabled: false }),
          new Date('2026-05-30T20:12:00.000Z'),
        )!,
      ),
    ).resolves.toEqual(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE);

    expect(hooks.recoverClosedNoticeEvent).toHaveBeenCalledTimes(1);
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(redisCounter.stringCache.get('night-mode-transition-state:v1:chat-1')).not.toContain(
      'closeNoticeEventRecovery',
    );
  });

  it('retains a pending marker and never writes open when strict recovery proof fails', async () => {
    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const pendingState = JSON.stringify({
      status: 'closed',
      sessionKey: OPEN_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-unproven-1',
      closeNoticeBotId: 'bot-1',
      closeNoticeEventRecovery: {
        version: 2,
        pending: true,
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      },
    });
    redisCounter.stringCache.set('night-mode-transition-state:v1:chat-1', pendingState);
    const proofError = new Error('exact completed ledger proof is missing');
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest.fn().mockRejectedValue(proofError),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toBe(proofError);

    expect(redisCounter.stringCache.get('night-mode-transition-state:v1:chat-1')).toBe(
      pendingState,
    );
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('retains a pending v2 marker when its stored session differs from the current snapshot', async () => {
    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const stateKey = 'night-mode-transition-state:v1:chat-1';
    const pendingState = JSON.stringify({
      status: 'closed',
      sessionKey: 'v1:Europe/Moscow:22:00:07:00:2026-05-30',
      closeNoticeMessageId: 'night-close-old-pending-1',
      closeNoticeBotId: 'bot-old-pending-1',
      closeNoticeEventRecovery: {
        version: 2,
        pending: true,
        timezone: 'Europe/Moscow',
        startMinutes: 22 * 60,
        endMinutes: 7 * 60,
      },
    });
    redisCounter.stringCache.set(stateKey, pendingState);
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toThrow(
      'Night mode close-event recovery marker is unsupported (chat-1)',
    );

    expect(redisCounter.stringCache.get(stateKey)).toBe(pendingState);
    expect(hooks.recoverClosedNoticeEvent).not.toHaveBeenCalled();
    expect(hooks.recoverClosedNoticeEventFromLedger).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy v1', { version: 1, pending: true }],
    ['malformed v2', { version: 2, pending: true, timezone: 'Europe/Moscow' }],
  ])('fails closed for a %s pending marker without sending again', async (_label, marker) => {
    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const pendingState = JSON.stringify({
      status: 'closed',
      sessionKey: OPEN_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-legacy-pending-1',
      closeNoticeBotId: 'bot-1',
      closeNoticeEventRecovery: marker,
    });
    redisCounter.stringCache.set('night-mode-transition-state:v1:chat-1', pendingState);
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toThrow(
      'Night mode close-event recovery marker is unsupported (chat-1)',
    );

    expect(redisCounter.stringCache.get('night-mode-transition-state:v1:chat-1')).toBe(
      pendingState,
    );
    expect(hooks.recoverClosedNoticeEvent).not.toHaveBeenCalled();
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('does not resend a legacy Redis-only close notice without a recovery marker', async () => {
    jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: CLOSE_JOB.sessionKey,
        closeNoticeMessageId: 'legacy-close-message-1',
      }),
    );
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(CLOSE_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.recoverClosedNoticeEvent).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('repairs a missed opening from the persisted close notice after Redis state loss', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'night-close-event-1',
        messageId: 'night-close-persisted-1',
        botId: 'origin-bot-1',
      })
      .mockResolvedValueOnce(null);
    const prisma = createPrisma({ findFirst });
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith(
      'chat-1',
      'night-close-persisted-1',
      'origin-bot-1',
      expect.objectContaining({
        sessionKey: OPEN_JOB.sessionKey,
        event: expect.objectContaining({ id: 'night-close-event-1' }),
      }),
      expect.any(Function),
    );
    expect(hooks.sendOpenedNotice).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      expect.objectContaining({
        sessionKey: OPEN_JOB.sessionKey,
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
      expect.any(Function),
    );
    expect(findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ ruleCode: 'NIGHT_MODE_CLOSE_NOTICE' }),
      }),
    );
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ ruleCode: 'NIGHT_MODE_OPEN_NOTICE' }),
      }),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      'night-mode-transition-state:v1:chat-1',
      expect.stringContaining('"status":"open"'),
      expect.any(Number),
    );
  });

  it.each([
    ['markerless state', true],
    ['Redis state loss', false],
  ])('recovers an accepted close from exact ledger proof after %s', async (_label, seedState) => {
    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const prisma = createPrisma();
    prisma.chatSettings.findUnique.mockResolvedValue(
      createSettings({ nightModeOpenMessageEnabled: false }),
    );
    const redisCounter = createRedisCounterMock();
    if (seedState) {
      redisCounter.stringCache.set(
        'night-mode-transition-state:v1:chat-1',
        JSON.stringify({
          status: 'closed',
          sessionKey: OPEN_JOB.sessionKey,
          closeNoticeMessageId: 'night-close-ledger-1',
          closeNoticeBotId: 'bot-ledger-1',
        }),
      );
    }
    const hooks = createHooks({
      recoverClosedNoticeEventFromLedger: jest.fn().mockResolvedValue({
        eventId: 'night-close-event-ledger-1',
        sessionKey: OPEN_JOB.sessionKey,
        messageId: 'night-close-ledger-1',
        botId: 'bot-ledger-1',
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(hooks.recoverClosedNoticeEventFromLedger).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: OPEN_JOB.sessionKey,
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });
    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith(
      'chat-1',
      'night-close-ledger-1',
      'bot-ledger-1',
      expect.objectContaining({
        sessionKey: OPEN_JOB.sessionKey,
        event: {
          id: 'night-close-event-ledger-1',
          ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
          messageId: 'night-close-ledger-1',
        },
      }),
      expect.any(Function),
    );
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(redisCounter.stringCache.get('night-mode-transition-state:v1:chat-1')).toContain(
      '"status":"open"',
    );
  });

  it('stops a state-absent recovery-only job after exact ledger event recovery', async () => {
    jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest.fn().mockResolvedValue({
        eventId: 'night-close-event-recovery-only-1',
        sessionKey: CLOSE_JOB.sessionKey,
        messageId: 'night-close-recovery-only-1',
        botId: 'bot-recovery-only-1',
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(
      service.processNightModeTransitionJob(
        {
          ...CLOSE_JOB,
          recoveryOnly: CLOSE_RECOVERY,
        },
        hooks,
      ),
    ).resolves.toEqual(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE);

    expect(hooks.recoverClosedNoticeEvent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: CLOSE_JOB.sessionKey,
      messageId: CLOSE_RECOVERY.messageId,
      botId: CLOSE_RECOVERY.botId,
      timezone: CLOSE_RECOVERY.timezone,
      startMinutes: CLOSE_RECOVERY.startMinutes,
      endMinutes: CLOSE_RECOVERY.endMinutes,
    });
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('clears an exact pending marker after idempotent event recovery despite disabled settings', async () => {
    const stateKey = 'night-mode-transition-state:v1:chat-1';
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      stateKey,
      JSON.stringify({
        status: 'closed',
        sessionKey: CLOSE_RECOVERY.sessionKey,
        closeNoticeMessageId: CLOSE_RECOVERY.messageId,
        closeNoticeBotId: CLOSE_RECOVERY.botId,
        closeNoticeEventRecovery: {
          version: 2,
          pending: true,
          timezone: CLOSE_RECOVERY.timezone,
          startMinutes: CLOSE_RECOVERY.startMinutes,
          endMinutes: CLOSE_RECOVERY.endMinutes,
        },
      }),
    );
    const prisma = createPrisma();
    prisma.chatSettings.findUnique.mockRejectedValue(
      new Error('recovery-only execution must not inspect current settings'),
    );
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest.fn().mockResolvedValue({
        eventId: 'already-existing-event-1',
        sessionKey: CLOSE_RECOVERY.sessionKey,
        messageId: CLOSE_RECOVERY.messageId,
        botId: CLOSE_RECOVERY.botId,
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(
      service.processNightModeTransitionJob({ ...CLOSE_JOB, recoveryOnly: CLOSE_RECOVERY }, hooks),
    ).resolves.toEqual(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE);

    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
    expect(
      parseNightModeTransitionState(JSON.parse(redisCounter.stringCache.get(stateKey)!)),
    ).toEqual(
      expect.objectContaining({
        status: 'closed',
        sessionKey: CLOSE_RECOVERY.sessionKey,
        closeNoticeMessageId: CLOSE_RECOVERY.messageId,
        closeNoticeBotId: CLOSE_RECOVERY.botId,
      }),
    );
    expect(redisCounter.stringCache.get(stateKey)).not.toContain('closeNoticeEventRecovery');
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('recovers a missing close event without overwriting a newer open state', async () => {
    const stateKey = 'night-mode-transition-state:v1:chat-1';
    const redisCounter = createRedisCounterMock();
    const openState = JSON.stringify({
      status: 'open',
      sessionKey: CLOSE_RECOVERY.sessionKey,
      updatedAt: '2026-05-31T05:00:00.000Z',
    });
    redisCounter.stringCache.set(stateKey, openState);
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest.fn().mockResolvedValue({
        eventId: 'newly-recovered-event-1',
        sessionKey: CLOSE_RECOVERY.sessionKey,
        messageId: CLOSE_RECOVERY.messageId,
        botId: CLOSE_RECOVERY.botId,
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(
      service.processNightModeTransitionJob({ ...CLOSE_JOB, recoveryOnly: CLOSE_RECOVERY }, hooks),
    ).resolves.toEqual(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE);

    expect(redisCounter.stringCache.get(stateKey)).toBe(openState);
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('fails closed when a recovery-only ledger proof disappears before execution', async () => {
    jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks({
      recoverClosedNoticeEvent: jest
        .fn()
        .mockRejectedValue(new Error('Exact completed night mode close send is not proven')),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(
      service.processNightModeTransitionJob(
        {
          ...CLOSE_JOB,
          recoveryOnly: CLOSE_RECOVERY,
        },
        hooks,
      ),
    ).rejects.toThrow('Exact completed night mode close send is not proven');

    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
  });

  it('rejects a completed close ledger result that mismatches markerless runtime state', async () => {
    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const stateKey = 'night-mode-transition-state:v1:chat-1';
    const closedState = JSON.stringify({
      status: 'closed',
      sessionKey: OPEN_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-state-1',
      closeNoticeBotId: 'bot-state-1',
    });
    redisCounter.stringCache.set(stateKey, closedState);
    const hooks = createHooks({
      recoverClosedNoticeEventFromLedger: jest.fn().mockResolvedValue({
        eventId: 'night-close-event-ledger-1',
        sessionKey: OPEN_JOB.sessionKey,
        messageId: 'night-close-foreign-1',
        botId: 'bot-state-1',
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toThrow(
      'Night mode close ledger recovery mismatched runtime state (chat-1)',
    );

    expect(redisCounter.stringCache.get(stateKey)).toBe(closedState);
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('retains markerless closed state when its stored session differs from the current snapshot', async () => {
    jest.setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const redisCounter = createRedisCounterMock();
    const stateKey = 'night-mode-transition-state:v1:chat-1';
    const closedState = JSON.stringify({
      status: 'closed',
      sessionKey: 'v1:Europe/Moscow:22:00:07:00:2026-05-30',
      closeNoticeMessageId: 'night-close-old-session-1',
      closeNoticeBotId: 'bot-old-session-1',
    });
    redisCounter.stringCache.set(stateKey, closedState);
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toThrow(
      'Night mode close recovery session changed (chat-1)',
    );

    expect(redisCounter.stringCache.get(stateKey)).toBe(closedState);
    expect(hooks.recoverClosedNoticeEventFromLedger).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('skips runtime before settings lookup when the exact normal occurrence is acknowledged', async () => {
    const job = createVersionedJob();
    const jobId = buildNightModeTransitionJobId(
      job.chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const prisma = {
      ...createPrisma(),
      nightModeTransitionReconcileRequest: {
        findUnique: jest.fn().mockResolvedValue({
          manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
          manualBlockedCategory: 'unsafe_prior_dispatch',
          manualBlockedJobId: jobId,
          manualBlockedSessionKey: job.sessionKey,
          manualBlockedFingerprint: job.scheduleFingerprint,
          manualAcknowledgedAt: new Date('2026-05-31T05:10:00.000Z'),
        }),
      },
    };
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      createRedisCounterMock() as never,
    );

    await expect(service.processNightModeTransitionJob(job, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'unacknowledged', acknowledgedAt: null },
    { name: 'acknowledged', acknowledgedAt: new Date('2026-05-31T05:10:00.000Z') },
  ])(
    'skips a legacy job before settings lookup for an exact $name manual tombstone',
    async ({ acknowledgedAt }) => {
      const job = { ...OPEN_JOB };
      const jobId = buildNightModeTransitionJobId(
        job.chatId,
        job.transition,
        job.scheduledFor,
        job.sessionKey,
      );
      const prisma = {
        ...createPrisma(),
        nightModeTransitionReconcileRequest: {
          findUnique: jest.fn().mockResolvedValue({
            manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
            manualBlockedCategory: 'unsafe_prior_dispatch',
            manualBlockedJobId: jobId,
            manualBlockedSessionKey: job.sessionKey,
            manualBlockedFingerprint: buildNightModeTransitionScheduleFingerprint(createSettings()),
            manualAcknowledgedAt: acknowledgedAt,
          }),
        },
      };
      const hooks = createHooks();
      const service = new NightModeTransitionRuntimeService(
        prisma as unknown as PrismaService,
        createRedisCounterMock() as never,
      );

      await expect(service.processNightModeTransitionJob(job, hooks)).resolves.toEqual(
        NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
      );

      expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
      expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
      expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
      expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    },
  );

  it('rejects an open send when ACK commits after runtime preflight but before transport', async () => {
    const job = createVersionedJob();
    const jobId = buildNightModeTransitionJobId(
      job.chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    let acknowledged = false;
    const acknowledgedRow = {
      manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
      manualBlockedCategory: 'unsafe_prior_dispatch',
      manualBlockedJobId: jobId,
      manualBlockedSessionKey: job.sessionKey,
      manualBlockedFingerprint: job.scheduleFingerprint,
      manualAcknowledgedAt: new Date('2026-05-31T05:10:00.000Z'),
    };
    const prisma = {
      ...createPrisma(),
      nightModeTransitionReconcileRequest: {
        findUnique: jest.fn(async () => (acknowledged ? acknowledgedRow : null)),
      },
    };
    const maxSend = jest.fn();
    const hooks = createHooks({
      sendOpenedNotice: jest.fn(
        async (
          _settings: unknown,
          _snapshot: unknown,
          validateBeforeDispatch?: () => Promise<boolean>,
        ) => {
          acknowledged = true;
          if (!validateBeforeDispatch || !(await validateBeforeDispatch())) {
            throw new NightModeTransitionStaleStateError(job.chatId);
          }
          maxSend();
          return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
        },
      ),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      createRedisCounterMock() as never,
    );

    await expect(service.processNightModeTransitionJob(job, hooks)).rejects.toThrow(
      'Night mode transition state changed before dispatch (chat-1)',
    );

    expect(maxSend).not.toHaveBeenCalled();
  });

  it('rejects close-notice deletion when ACK commits at the final transport guard', async () => {
    const job = createVersionedJob();
    const jobId = buildNightModeTransitionJobId(
      job.chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    let acknowledged = false;
    const prisma = {
      ...createPrisma({
        findFirst: jest.fn().mockResolvedValue({
          id: 'close-event-for-ack-race',
          messageId: 'close-message-for-ack-race',
          botId: 'bot-for-ack-race',
        }),
      }),
      nightModeTransitionReconcileRequest: {
        findUnique: jest.fn(async () =>
          acknowledged
            ? {
                manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
                manualBlockedCategory: 'unsafe_prior_dispatch',
                manualBlockedJobId: jobId,
                manualBlockedSessionKey: job.sessionKey,
                manualBlockedFingerprint: job.scheduleFingerprint,
                manualAcknowledgedAt: new Date('2026-05-31T05:10:00.000Z'),
              }
            : null,
        ),
      },
    };
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: job.sessionKey,
        closeNoticeMessageId: 'close-message-for-ack-race',
        closeNoticeBotId: 'bot-for-ack-race',
      }),
    );
    const maxDelete = jest.fn();
    const hooks = createHooks({
      deleteClosedNotice: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _botId: string | null,
          _binding: unknown,
          validateBeforeDispatch?: () => Promise<boolean>,
        ) => {
          acknowledged = true;
          if (!validateBeforeDispatch || !(await validateBeforeDispatch())) {
            throw new NightModeTransitionStaleStateError(job.chatId);
          }
          maxDelete();
          return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
        },
      ),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(job, hooks)).rejects.toThrow(
      'Night mode transition state changed before dispatch (chat-1)',
    );

    expect(maxDelete).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('blocks an active close notice when night mode is disabled before the send', async () => {
    jest.setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    const prisma = createPrisma();
    prisma.chatSettings.findUnique
      .mockResolvedValueOnce(createSettings())
      .mockResolvedValue(createSettings({ nightModeEnabled: false }));
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(CLOSE_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(hooks.sendClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('blocks active close-notice cleanup when night mode is disabled before delete', async () => {
    const prisma = createPrisma();
    prisma.chatSettings.findUnique
      .mockResolvedValueOnce(createSettings())
      .mockResolvedValue(createSettings({ nightModeEnabled: false }));
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: OPEN_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-active-1',
      }),
    );
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('blocks an active opening after a committed schedule change', async () => {
    const prisma = createPrisma();
    prisma.chatSettings.findUnique.mockResolvedValueOnce(createSettings()).mockResolvedValue(
      createSettings({
        nightModeStartTimeMinutes: 22 * 60,
        nightModeEndTimeMinutes: 7 * 60,
      }),
    );
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('blocks dispatch when relevant notice content changes after preparation', async () => {
    const initialSettings = createSettings();
    const prisma = createPrisma();
    prisma.chatSettings.findUnique
      .mockResolvedValueOnce(initialSettings)
      .mockResolvedValueOnce(initialSettings)
      .mockResolvedValue(
        createSettings({
          nightModeOpenMessageText: 'Updated opening notice',
          updatedAt: new Date('2026-05-30T19:00:01.000Z'),
        }),
      );
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks({
      sendOpenedNotice: jest.fn(
        async (
          _settings: unknown,
          _snapshot: unknown,
          validateBeforeDispatch?: () => Promise<boolean>,
        ) => {
          if (!validateBeforeDispatch || !(await validateBeforeDispatch())) {
            throw new NightModeTransitionStaleStateError('chat-1');
          }
          return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
        },
      ),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toThrow(
      'Night mode transition state changed before dispatch (chat-1)',
    );

    expect(prisma.chatSettings.findUnique).toHaveBeenCalledTimes(3);
    expect(hooks.sendOpenedNotice).toHaveBeenCalledTimes(1);
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('does not resend a persisted opening when Redis state is missing', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'night-close-event-1',
        messageId: 'night-close-persisted-1',
        botId: 'origin-bot-1',
      })
      .mockResolvedValueOnce({ id: 'night-open-event-1' });
    const prisma = createPrisma({ findFirst });
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await service.processNightModeTransitionJob(OPEN_JOB, hooks);

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith(
      'chat-1',
      'night-close-persisted-1',
      'origin-bot-1',
      expect.objectContaining({
        sessionKey: OPEN_JOB.sessionKey,
        event: expect.objectContaining({ id: 'night-close-event-1' }),
      }),
      expect.any(Function),
    );
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      'night-mode-transition-state:v1:chat-1',
      expect.stringContaining('"status":"open"'),
      expect.any(Number),
    );
  });

  it('rethrows a generic close cleanup failure and retains closed state for retry', async () => {
    const prisma = createPrisma({
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'night-close-event-1',
          messageId: 'night-close-1',
          botId: null,
        })
        .mockResolvedValue(null),
    });
    const redisCounter = createRedisCounterMock();
    const stateKey = 'night-mode-transition-state:v1:chat-1';
    const closedState = JSON.stringify({
      status: 'closed',
      sessionKey: OPEN_JOB.sessionKey,
      closeNoticeMessageId: 'night-close-1',
    });
    redisCounter.stringCache.set(stateKey, closedState);
    const cleanupError = new Error('transient delete database failure');
    const hooks = createHooks({
      deleteClosedNotice: jest.fn().mockRejectedValue(cleanupError),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toBe(cleanupError);

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith(
      'chat-1',
      'night-close-1',
      null,
      expect.objectContaining({ event: expect.objectContaining({ id: 'night-close-event-1' }) }),
      expect.any(Function),
    );
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.stringCache.get(stateKey)).toBe(closedState);
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });

  it('keeps an access-loss stop when no fresh opening can be sent', async () => {
    const prisma = createPrisma({
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'night-close-event-1',
          messageId: 'night-close-1',
          botId: null,
        })
        .mockResolvedValue(null),
    });
    prisma.chatSettings.findUnique.mockResolvedValue(
      createSettings({ nightModeOpenMessageEnabled: false }),
    );
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: OPEN_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-1',
      }),
    );
    const hooks = createHooks({
      deleteClosedNotice: jest.fn().mockResolvedValue(NIGHT_MODE_TRANSITION_PROCESS_STOP),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_STOP,
    );

    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      'night-mode-transition-state:v1:chat-1',
      expect.stringContaining('"status":"open"'),
      expect.any(Number),
    );
  });

  it('continues after access-loss cleanup when a fresh opening succeeds', async () => {
    const prisma = createPrisma({
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'night-close-event-1',
          messageId: 'night-close-1',
          botId: null,
        })
        .mockResolvedValue(null),
    });
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: OPEN_JOB.sessionKey,
        closeNoticeMessageId: 'night-close-1',
      }),
    );
    const hooks = createHooks({
      deleteClosedNotice: jest.fn().mockResolvedValue(NIGHT_MODE_TRANSITION_PROCESS_STOP),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith(
      'chat-1',
      'night-close-1',
      null,
      expect.objectContaining({ event: expect.objectContaining({ id: 'night-close-event-1' }) }),
      expect.any(Function),
    );
    expect(hooks.sendOpenedNotice).toHaveBeenCalledTimes(1);
  });

  it('does not delete a close notice from a different stale session', async () => {
    const prisma = createPrisma();
    const redisCounter = createRedisCounterMock();
    redisCounter.stringCache.set(
      'night-mode-transition-state:v1:chat-1',
      JSON.stringify({
        status: 'closed',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-29',
        closeNoticeMessageId: 'night-close-stale-1',
      }),
    );
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toThrow(
      'Night mode close recovery session changed (chat-1)',
    );

    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
  });

  it('does not persist transition state when notice delivery has no executable route', async () => {
    const prisma = createPrisma();
    const redisCounter = createRedisCounterMock();
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const hooks = createHooks({
      sendOpenedNotice: jest.fn().mockRejectedValue(noRouteError),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).rejects.toBe(noRouteError);

    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    expect(redisCounter.releaseLock).toHaveBeenCalled();
  });

  it('renews the runtime lease so a second worker cannot enter after the original TTL', async () => {
    let lease: { token: string; expiresAt: number } | null = null;
    let tokenSequence = 0;
    const stringCache = new Map<string, string>();
    const redisCounter = {
      getString: jest.fn(async (key: string) => stringCache.get(key) ?? null),
      setStringWithTtl: jest.fn(async (key: string, value: string) => {
        stringCache.set(key, value);
      }),
      acquireLock: jest.fn(async () => {
        if (lease && lease.expiresAt > Date.now()) {
          return null;
        }
        tokenSequence += 1;
        const token = `runtime-token-${tokenSequence}`;
        lease = { token, expiresAt: Date.now() + 20_000 };
        return token;
      }),
      renewLock: jest.fn(async (_key: string, token: string, ttlMs: number) => {
        if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) {
          return false;
        }
        lease.expiresAt = Date.now() + ttlMs;
        return true;
      }),
      releaseLock: jest.fn(async (_key: string, token: string) => {
        if (lease?.token === token) {
          lease = null;
        }
      }),
    };
    let releaseFirstSend: () => void = () => undefined;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let markFirstSendStarted: () => void = () => undefined;
    const firstSendStarted = new Promise<void>((resolve) => {
      markFirstSendStarted = resolve;
    });
    const firstHooks = createHooks({
      sendOpenedNotice: jest.fn(async () => {
        markFirstSendStarted();
        await firstSendGate;
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }),
    });
    const secondHooks = createHooks();
    const prisma = createPrisma();
    const firstService = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );
    const secondService = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    const firstRun = firstService.processNightModeTransitionJob(OPEN_JOB, firstHooks);
    await firstSendStarted;
    await jest.advanceTimersByTimeAsync(21_000);

    await expect(
      secondService.processNightModeTransitionJob(OPEN_JOB, secondHooks),
    ).resolves.toEqual(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE);
    expect(secondHooks.sendOpenedNotice).not.toHaveBeenCalled();

    releaseFirstSend();
    await expect(firstRun).resolves.toEqual(NIGHT_MODE_TRANSITION_PROCESS_CONTINUE);
    expect(redisCounter.renewLock).toHaveBeenCalled();
    expect(redisCounter.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('throws before a state write when runtime lock renewal is lost', async () => {
    let renewCount = 0;
    const redisCounter = createRedisCounterMock();
    redisCounter.renewLock.mockImplementation(async () => {
      renewCount += 1;
      return renewCount === 1;
    });
    let releaseSend: () => void = () => undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markSendStarted: () => void = () => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const hooks = createHooks({
      sendOpenedNotice: jest.fn(async () => {
        markSendStarted();
        await sendGate;
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }),
    });
    const service = new NightModeTransitionRuntimeService(
      createPrisma() as unknown as PrismaService,
      redisCounter as never,
    );

    const run = service.processNightModeTransitionJob(OPEN_JOB, hooks);
    await sendStarted;
    await jest.advanceTimersByTimeAsync(7_000);
    releaseSend();

    await expect(run).rejects.toThrow('Night mode transition lock ownership was lost (chat-1)');
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
  });
});
