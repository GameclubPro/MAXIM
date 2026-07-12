import type { PrismaService } from '../prisma/prisma.service';
import {
  NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
  NIGHT_MODE_TRANSITION_PROCESS_STOP,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';
import {
  NightModeTransitionRuntimeService,
  type NightModeTransitionRuntimeHooks,
  type NightModeTransitionRuntimeSettings,
} from './night-mode-transition-runtime.service';

const OPEN_JOB: NightModeTransitionJob = {
  chatId: 'chat-1',
  transition: 'open',
  scheduledFor: '2026-05-31T05:00:00.000Z',
  sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
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
    chat: {
      rules: null,
    },
    ...overrides,
  };
}

function createHooks(
  overrides: Partial<NightModeTransitionRuntimeHooks> = {},
): NightModeTransitionRuntimeHooks {
  return {
    sendClosedNotice: jest.fn().mockResolvedValue({
      ...NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
      messageId: null,
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

  it('repairs a missed opening from the persisted close notice after Redis state loss', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ messageId: 'night-close-persisted-1' })
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

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith('chat-1', 'night-close-persisted-1');
    expect(hooks.sendOpenedNotice).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      expect.objectContaining({
        sessionKey: OPEN_JOB.sessionKey,
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
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

  it('does not resend a persisted opening when Redis state is missing', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ messageId: 'night-close-persisted-1' })
      .mockResolvedValueOnce({ id: 'night-open-event-1' });
    const prisma = createPrisma({ findFirst });
    const redisCounter = createRedisCounterMock();
    const hooks = createHooks();
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await service.processNightModeTransitionJob(OPEN_JOB, hooks);

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith('chat-1', 'night-close-persisted-1');
    expect(hooks.sendOpenedNotice).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      'night-mode-transition-state:v1:chat-1',
      expect.stringContaining('"status":"open"'),
      expect.any(Number),
    );
  });

  it('sends the opening after a user.not.admin close-notice deletion failure', async () => {
    const prisma = createPrisma();
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
      deleteClosedNotice: jest.fn().mockRejectedValue(new Error('user.not.admin')),
    });
    const service = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redisCounter as never,
    );

    await expect(service.processNightModeTransitionJob(OPEN_JOB, hooks)).resolves.toEqual(
      NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
    );

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith('chat-1', 'night-close-1');
    expect(hooks.sendOpenedNotice).toHaveBeenCalledTimes(1);
  });

  it('keeps an access-loss stop when no fresh opening can be sent', async () => {
    const prisma = createPrisma();
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
    const prisma = createPrisma();
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

    expect(hooks.deleteClosedNotice).toHaveBeenCalledWith('chat-1', 'night-close-1');
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

    await service.processNightModeTransitionJob(OPEN_JOB, hooks);

    expect(hooks.deleteClosedNotice).not.toHaveBeenCalled();
    expect(hooks.sendOpenedNotice).toHaveBeenCalledTimes(1);
  });
});
