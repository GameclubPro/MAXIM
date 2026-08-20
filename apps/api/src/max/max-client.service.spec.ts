import {
  MAX_API_SOURCE_TAGS,
  MaxApiCircuitOpenError,
  MaxApiRequestRejectedError,
  MaxClientService,
  markMaxMemberMutationAttempted,
  normalizeMaxActionIdempotencyKeyPart,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
  wasMaxMessageSendAttempted,
} from './max-client.service';
import { from, of, throwError } from 'rxjs';
import Redis from 'ioredis';
import { UnrecoverableError } from 'bullmq';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
} from './max-action.queue';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import {
  MAX_FILE_UPLOAD_MAX_BYTES,
  MAX_IMAGE_UPLOAD_MAX_BYTES,
  MAX_VIDEO_UPLOAD_MAX_BYTES,
} from './max-video-upload.constants';
import {
  MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
} from './max-action-pre-dispatch-guard';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from './max-media-upload-validation';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';

const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z';
const TINY_JPEG = Buffer.from(TINY_JPEG_BASE64, 'base64');
function createMp4Fixture(size = TINY_VALID_MP4.length, fill = 0): Buffer {
  const targetSize = Math.max(size, TINY_VALID_MP4.length);
  const paddingSize = targetSize - TINY_VALID_MP4.length;
  if (paddingSize < 8) {
    return Buffer.from(TINY_VALID_MP4);
  }
  const free = Buffer.alloc(paddingSize, fill);
  free.writeUInt32BE(paddingSize, 0);
  free.write('free', 4, 4, 'latin1');
  return Buffer.concat([TINY_VALID_MP4, free]);
}

jest.mock('ioredis', () => {
  const store = new Map<string, { value: string; expiresAtMs: number | null }>();
  const readEntry = (key: string) => {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => {
      const instance = {
        incr: jest.fn().mockImplementation(async (key: string) => {
          const current = Number(readEntry(key)?.value ?? '0');
          const next = current + 1;
          store.set(key, {
            value: String(next),
            expiresAtMs: readEntry(key)?.expiresAtMs ?? null,
          });
          return next;
        }),
        expire: jest.fn().mockImplementation(async (key: string, ttlSec: number) => {
          const entry = readEntry(key);
          if (!entry) {
            return 0;
          }
          store.set(key, {
            ...entry,
            expiresAtMs: Date.now() + ttlSec * 1_000,
          });
          return 1;
        }),
        pexpire: jest.fn().mockImplementation(async (key: string, ttlMs: number) => {
          const entry = readEntry(key);
          if (!entry) {
            return 0;
          }
          store.set(key, {
            ...entry,
            expiresAtMs: Date.now() + ttlMs,
          });
          return 1;
        }),
        pttl: jest.fn().mockImplementation(async (key: string) => {
          const entry = readEntry(key);
          if (!entry) {
            return -2;
          }
          if (entry.expiresAtMs === null) {
            return -1;
          }
          return Math.max(0, entry.expiresAtMs - Date.now());
        }),
        get: jest.fn().mockImplementation(async (key: string) => readEntry(key)?.value ?? null),
        set: jest
          .fn()
          .mockImplementation(async (key: string, value: string, ...args: unknown[]) => {
            let expiresAtMs: number | null = null;
            if (args[0] === 'EX' && typeof args[1] === 'number' && Number.isFinite(args[1])) {
              expiresAtMs = Date.now() + args[1] * 1_000;
            }
            if (args[0] === 'PX' && typeof args[1] === 'number' && Number.isFinite(args[1])) {
              expiresAtMs = Date.now() + args[1];
            }
            store.set(key, {
              value,
              expiresAtMs,
            });
            return 'OK';
          }),
        del: jest.fn().mockImplementation(async (...keys: string[]) => {
          let deleted = 0;
          for (const key of keys) {
            if (store.delete(key)) {
              deleted += 1;
            }
          }
          return deleted;
        }),
        eval: jest
          .fn()
          .mockImplementation(
            async (script: string, numKeys: number, ...args: Array<string | number>) => {
              const keys = args.slice(0, numKeys).map((value) => String(value));
              const argValues = args.slice(numKeys);

              if (script.includes('MAX_API_GCRA_RESERVE_V1')) {
                const nowMs = Date.now();
                const ttlFloorMs = Number(argValues[argValues.length - 1] ?? 0);
                const updates: Array<{ key: string; tat: number; ttlMs: number }> = [];
                for (let index = 0; index < numKeys; index += 1) {
                  const limit = Number(argValues[index] ?? 0);
                  const intervalMs = 1_000 / limit;
                  const burstToleranceSlots = Number(argValues[numKeys + index] ?? 0);
                  const burstToleranceMs = burstToleranceSlots * intervalMs;
                  const storedTat = Number(readEntry(keys[index])?.value ?? nowMs);
                  const tat = Math.max(storedTat, nowMs);
                  const allowAtMs = tat - burstToleranceMs;
                  if (nowMs < allowAtMs) {
                    return [0, index + 1, Math.max(1, Math.ceil(allowAtMs - nowMs))];
                  }
                  const nextTat = tat + intervalMs;
                  updates.push({
                    key: keys[index],
                    tat: nextTat,
                    ttlMs: Math.max(
                      ttlFloorMs,
                      Math.ceil(nextTat - nowMs + burstToleranceMs + intervalMs),
                    ),
                  });
                }

                for (const update of updates) {
                  store.set(update.key, {
                    value: String(update.tat),
                    expiresAtMs: nowMs + update.ttlMs,
                  });
                }
                return [1, 0, 0];
              }

              const readFailures = (key: string, cutoffMs: number) =>
                (readEntry(key)?.value ?? '')
                  .split(',')
                  .map((value) => Number(value))
                  .filter((value) => Number.isFinite(value) && value >= cutoffMs);

              if (script.includes('MAX_API_CIRCUIT_ACQUIRE_V1')) {
                const nowMs = Date.now();
                const threshold = Number(argValues[0]);
                const windowMs = Number(argValues[1]);
                const openMs = Number(argValues[2]);
                const probeTtlMs = Number(argValues[3]);
                const stateTtlMs = Number(argValues[4]);
                const probeToken = String(argValues[5]);
                const openUntilMs = Number(readEntry(keys[1])?.value ?? 0);
                if (openUntilMs > nowMs) {
                  return [0, 0, Math.max(1, Math.ceil(openUntilMs - nowMs))];
                }

                const failures = readFailures(keys[0], nowMs - windowMs);
                if (failures.length > 0) {
                  store.set(keys[0], {
                    value: failures.join(','),
                    expiresAtMs: nowMs + stateTtlMs,
                  });
                } else {
                  store.delete(keys[0]);
                }

                if (openUntilMs > 0) {
                  const activeProbe = readEntry(keys[2]);
                  if (!activeProbe) {
                    store.set(keys[2], {
                      value: probeToken,
                      expiresAtMs: nowMs + probeTtlMs,
                    });
                    return [1, 1, 0];
                  }
                  return [
                    0,
                    0,
                    Math.max(1, (activeProbe.expiresAtMs ?? nowMs + probeTtlMs) - nowMs),
                  ];
                }

                if (failures.length >= threshold) {
                  store.set(keys[1], {
                    value: String(nowMs + openMs),
                    expiresAtMs: nowMs + stateTtlMs,
                  });
                  store.delete(keys[2]);
                  return [0, 0, openMs];
                }

                return [1, 0, 0];
              }

              if (script.includes('MAX_API_CIRCUIT_FAILURE_V1')) {
                const nowMs = Date.now();
                const threshold = Number(argValues[0]);
                const windowMs = Number(argValues[1]);
                const openMs = Number(argValues[2]);
                const stateTtlMs = Number(argValues[3]);
                const forceOpen = Number(argValues[4]) === 1;
                const failures = readFailures(keys[0], nowMs - windowMs);
                failures.push(nowMs);
                store.set(keys[0], {
                  value: failures.join(','),
                  expiresAtMs: nowMs + stateTtlMs,
                });
                let openUntilMs = Number(readEntry(keys[1])?.value ?? 0);
                if (forceOpen || failures.length >= threshold) {
                  openUntilMs = nowMs + openMs;
                  store.set(keys[1], {
                    value: String(openUntilMs),
                    expiresAtMs: nowMs + stateTtlMs,
                  });
                  store.delete(keys[2]);
                }
                return [failures.length, openUntilMs];
              }

              if (script.includes('MAX_API_CIRCUIT_CLOSE_V1')) {
                if (readEntry(keys[2])?.value === String(argValues[0])) {
                  keys.forEach((key) => store.delete(key));
                  return 1;
                }
                return 0;
              }

              if (script.includes('MAX_API_CIRCUIT_RELEASE_PROBE_V1')) {
                if (readEntry(keys[0])?.value === String(argValues[0])) {
                  store.delete(keys[0]);
                  return 1;
                }
                return 0;
              }

              if (script.includes('MAX_MESSAGE_EDIT_LOCK_ACQUIRE_V1')) {
                const activeLock = readEntry(keys[0]);
                const ttlMs = Number(argValues[1]);
                if (!activeLock) {
                  store.set(keys[0], {
                    value: String(argValues[0]),
                    expiresAtMs: Date.now() + ttlMs,
                  });
                  return [1, ttlMs];
                }
                return [
                  0,
                  Math.max(1, (activeLock.expiresAtMs ?? Date.now() + ttlMs) - Date.now()),
                ];
              }

              if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
                const activeLock = readEntry(keys[0]);
                if (activeLock?.value === String(argValues[0])) {
                  activeLock.expiresAtMs = Date.now() + Number(argValues[1]);
                  return 1;
                }
                return 0;
              }

              if (script.includes('MAX_MESSAGE_EDIT_LOCK_RELEASE_V1')) {
                if (readEntry(keys[0])?.value === String(argValues[0])) {
                  store.delete(keys[0]);
                  return 1;
                }
                return 0;
              }

              throw new Error('Unexpected Redis eval script');
            },
          ),
        quit: jest.fn().mockResolvedValue(undefined),
        multi: jest.fn().mockImplementation(() => {
          const operations: Array<['incr' | 'expire', ...unknown[]]> = [];
          const pipeline = {
            incr: (key: string) => {
              operations.push(['incr', key]);
              return pipeline;
            },
            expire: (key: string, ttlSec: number) => {
              operations.push(['expire', key, ttlSec]);
              return pipeline;
            },
            exec: jest.fn().mockImplementation(async () => {
              const results: Array<[null, unknown]> = [];
              for (const [method, ...args] of operations) {
                results.push([
                  null,
                  await (instance[method] as (...values: unknown[]) => Promise<unknown>)(...args),
                ]);
              }
              return results;
            }),
          };
          return pipeline;
        }),
      };

      return instance;
    }),
    {
      __store: store,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

describe('MAX action idempotency key normalization', () => {
  function referenceNormalize(value: string): string {
    const normalized: string[] = [];
    for (const character of value.trim().toLowerCase()) {
      const code = character.charCodeAt(0);
      const allowed =
        (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === '-';
      if (allowed) {
        normalized.push(character);
      } else if (normalized.at(-1) !== '_') {
        normalized.push('_');
      }
    }
    while (normalized[0] === '_') {
      normalized.shift();
    }
    while (normalized.at(-1) === '_') {
      normalized.pop();
    }
    return normalized.join('').slice(0, 48);
  }

  it('preserves readable-key semantics across separator and Unicode inputs', () => {
    const alphabet = ['a', 'Z', '0', '_', '-', ' ', '!', 'e', '\u0130', '\ud83d\ude00', '\n'];
    const corpus = [
      '',
      '___',
      '  Moderation:Notice:Chat-1:User_1  ',
      '__a_--_b__',
      '#-leading',
      'trailing-#',
      'RUS:\u041f\u0440\u0438\u0432\u0435\u0442',
      'emoji:\ud83d\ude00\ud83d\ude80:done',
      'A'.repeat(80),
    ];
    let frontier = [''];
    for (let length = 0; length < 4; length += 1) {
      frontier = frontier.flatMap((prefix) => alphabet.map((character) => prefix + character));
      corpus.push(...frontier);
    }

    for (const value of corpus) {
      expect(normalizeMaxActionIdempotencyKeyPart(value)).toBe(referenceNormalize(value));
    }
  });

  it('handles a long adversarial separator run in one pass', () => {
    const value = `${'!_'.repeat(250_000)}Action-1${'_!'.repeat(250_000)}`;
    expect(normalizeMaxActionIdempotencyKeyPart(value)).toBe('action-1');
  });
});

describe('MaxClientService inline keyboard guardrails', () => {
  it('brands a frozen member-mutation error without replacing it', () => {
    const frozenError = Object.freeze(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    expect(markMaxMemberMutationAttempted(frozenError)).toBe(frozenError);
    expect(wasMaxMemberMutationAttempted(frozenError)).toBe(true);
  });

  beforeEach(() => {
    (
      Redis as unknown as { __store: Map<string, { value: string; expiresAtMs: number | null }> }
    ).__store.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService(
    httpService: { request?: jest.Mock } = {},
    configOverrides: Partial<Record<string, boolean | string>> = {},
    actionQueue?: { add: jest.Mock; getJob: jest.Mock },
    actionLedgerService?: {
      isIrreversibleAction?: jest.Mock;
      assertCanEnqueue?: jest.Mock;
      recordStarted?: jest.Mock;
      recordSucceeded?: jest.Mock;
      recordFailed?: jest.Mock;
      getCompletedSendDispatch?: jest.Mock;
      claimSendDispatch?: jest.Mock;
      completeSendDispatch?: jest.Mock;
      releaseSendDispatch?: jest.Mock;
      recordAmbiguousSendDispatch?: jest.Mock;
      clearTerminalBanStateAfterUnban?: jest.Mock;
    },
  ) {
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api2.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key in configOverrides) {
          return configOverrides[key];
        }
        return fallback;
      }),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: '777000_bot',
        token: 'test-token',
        webhookSecretPath: 'secret-path',
        webhookHeaderSecret: 'header-secret',
        webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) =>
        !botId || botId === '777000_bot'
          ? {
              id: '777000_bot',
              token: 'test-token',
              webhookSecretPath: 'secret-path',
              webhookHeaderSecret: 'header-secret',
              webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
              maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
            }
          : null,
      ),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      })),
      isKnownBotUserId: jest.fn().mockReturnValue(false),
    };
    let activeBotId: string | null = null;
    const botContext = {
      getActiveBotId: jest.fn(() => activeBotId),
      runWithBot: jest.fn((botId: string, callback: () => unknown) => {
        const previousBotId = activeBotId;
        activeBotId = botId;
        try {
          const result = callback();
          if (result && typeof (result as Promise<unknown>).finally === 'function') {
            return (result as Promise<unknown>).finally(() => {
              activeBotId = previousBotId;
            });
          }
          activeBotId = previousBotId;
          return result;
        } catch (error: unknown) {
          activeBotId = previousBotId;
          throw error;
        }
      }),
    };

    return new MaxClientService(
      httpService as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      actionQueue as never,
      undefined,
      actionLedgerService as never,
    );
  }

  it('refuses to kick or ban configured bot users', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    (service as any).botRegistry.isKnownBotUserId.mockImplementation(
      (userId: string | null | undefined) => userId === '613002203036_5',
    );

    await expect(
      service.kickMember('chat-1', '613002203036_5', { immediate: true }),
    ).rejects.toThrow('Refusing to kick configured MAX bot user');
    await expect(
      service.banMember('chat-1', '613002203036_5', { immediate: true }),
    ).rejects.toThrow('Refusing to ban configured MAX bot user');
    expect(httpService.request).not.toHaveBeenCalled();
  });

  it('skips stale queued kick or ban jobs for configured bot users', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    (service as any).botRegistry.isKnownBotUserId.mockImplementation(
      (userId: string | null | undefined) => userId === '613002203036_5',
    );

    await service.executeActionJob({
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      userId: '613002203036_5',
      attempt: 1,
      idempotencyKey: 'ban-bot',
      createdAt: new Date().toISOString(),
    });

    await service.executeActionJob({
      actionType: 'KICK_MEMBER',
      chatId: 'chat-1',
      userId: '613002203036_5',
      attempt: 1,
      idempotencyKey: 'kick-bot',
      createdAt: new Date().toISOString(),
    });

    expect(httpService.request).not.toHaveBeenCalled();
  });

  it('refuses stale queued actions with an explicit non-executable bot id', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'draining-bot') {
        return {
          id: 'draining-bot',
          token: 'draining-token',
          state: 'draining',
          webhookSecretPath: 'draining-secret',
          webhookHeaderSecret: 'draining-header-secret',
          webhookUrl: 'https://major-maksimov.ru/api/webhook/max/draining-bot/draining-secret',
          maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/draining-bot/***',
        };
      }
      return null;
    });

    await expect(
      service.executeActionJob({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-1',
        botId: 'draining-bot',
        attempt: 1,
        idempotencyKey: 'delete-draining',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const memberActionError = await service
      .executeActionJob({
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        botId: 'draining-bot',
        attempt: 1,
        idempotencyKey: 'ban-draining',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(memberActionError).toBeInstanceOf(UnrecoverableError);
    expect(wasMaxMemberMutationAttempted(memberActionError)).toBe(false);
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('refuses enqueue-time actions with explicit non-executable or unknown bot ids', async () => {
    const httpService = { request: jest.fn() };
    const actionQueue = {
      add: jest.fn(),
      getJob: jest.fn(),
    };
    const service = createService(httpService, {}, actionQueue);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'draining-bot') {
        return {
          ...defaultBot,
          id: 'draining-bot',
          token: 'draining-token',
          state: 'draining',
        };
      }
      return null;
    });

    await expect(
      service.sendMessage('chat-1', 'hello', undefined, { botId: 'draining-bot' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      service.deleteMessage('chat-1', 'mid-1', { botId: 'removed-bot' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(actionQueue.add).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('refuses stale queued actions with an explicit unknown bot id', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(
      service.executeActionJob({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-1',
        botId: 'removed-bot',
        attempt: 1,
        idempotencyKey: 'delete-removed-bot',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('passes timeout override to queued delete message jobs', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.executeActionJob({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'mid-delete-timeout-1',
      timeoutMs: 1_234,
      attempt: 1,
      idempotencyKey: 'delete-timeout',
      createdAt: new Date().toISOString(),
    });
    expect(httpService.request).toHaveBeenCalledWith({
      method: 'delete',
      url: 'https://platform-api2.max.ru/messages',
      params: {
        message_id: 'mid-delete-timeout-1',
      },
      timeout: 1_234,
      headers: {
        Authorization: 'test-token',
      },
    });

    await service.onModuleDestroy();
  });

  it('checks the immediate delete guard at the final boundary before MAX HTTP', async () => {
    const guardError = new Error('photo ordering lease lost');
    const events: string[] = [];
    const httpService = {
      request: jest.fn(() => {
        events.push('max-http');
        return of({ status: 200, data: { success: true } });
      }),
    };
    const beforeImmediateDeleteMutation = jest.fn(async () => {
      events.push('delete-guard');
      throw guardError;
    });
    const service = createService(httpService);

    await expect(
      service.deleteMessage('chat-1', 'mid-delete-guard-1', {
        immediate: true,
        botId: '777000_bot',
        beforeImmediateDeleteMutation,
      }),
    ).rejects.toBe(guardError);

    expect(events).toEqual(['delete-guard']);
    expect(beforeImmediateDeleteMutation).toHaveBeenCalledTimes(1);
    expect((guardError as Error & { code?: string }).code).toBe(
      MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );
    expect(httpService.request).not.toHaveBeenCalled();
    expect((service as any).actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects an ephemeral delete guard on queued dispatch', async () => {
    const beforeImmediateDeleteMutation = jest.fn();
    const actionQueue = { add: jest.fn(), getJob: jest.fn() };
    const service = createService({ request: jest.fn() }, {}, actionQueue);

    await expect(
      service.deleteMessage('chat-1', 'mid-delete-guard-queued-1', {
        beforeImmediateDeleteMutation,
      }),
    ).rejects.toThrow('Delete mutation guard requires immediate dispatch');

    expect(beforeImmediateDeleteMutation).not.toHaveBeenCalled();
    expect(actionQueue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([
    { label: 'success=false', payload: { success: false } },
    { label: 'missing success', payload: {} },
  ])('rejects a 200 delete response with $label', async ({ payload }) => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: payload,
        }),
      ),
    };
    const service = createService(httpService);

    const deletion = service.executeActionJob({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'mid-delete-rejected-1',
      attempt: 1,
      idempotencyKey: 'delete-rejected',
      createdAt: new Date().toISOString(),
    });

    await expect(deletion).rejects.toBeInstanceOf(MaxApiRequestRejectedError);
    await expect(deletion).rejects.toMatchObject({
      response: {
        status: 200,
        data: payload,
      },
    });

    await service.onModuleDestroy();
  });

  it('marks ambiguous queued SEND_MESSAGE transport timeouts as unrecoverable', async () => {
    const timeoutError = Object.assign(new Error('timeout of 1500ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const httpService = {
      request: jest.fn(() => throwError(() => timeoutError)),
    };
    const service = createService(httpService);

    await expect(
      service.executeActionJob({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'send-timeout',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
      }),
    );

    await service.onModuleDestroy();
  });

  it('persists the SEND_MESSAGE remote id behind the dispatch token before returning', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-fenced-1',
          },
        }),
      ),
    };
    const actionLedgerService = {
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'claimed',
        dispatchToken: 'dispatch-token-1',
      }),
      completeSendDispatch: jest.fn().mockResolvedValue(undefined),
      releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
      recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'send-fenced-success',
      createdAt: new Date().toISOString(),
    };

    await service.executeActionJob(job);

    expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledWith(job, '777000_bot');
    expect(actionLedgerService.completeSendDispatch).toHaveBeenCalledWith(
      job,
      'dispatch-token-1',
      'mid-fenced-1',
    );
    expect(actionLedgerService.releaseSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.claimSendDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      httpService.request.mock.invocationCallOrder[0],
    );
    expect(httpService.request.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.completeSendDispatch.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it('recovers a persisted SEND_MESSAGE result without another MAX request', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const actionLedgerService = {
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'recovered',
        remoteMessageId: 'mid-recovered-1',
      }),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await service.executeActionJob({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 2,
      idempotencyKey: 'send-fenced-recovered',
      createdAt: new Date().toISOString(),
    });

    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.completeSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.releaseSendDispatch).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([400, 403, 429])(
    'releases the SEND_MESSAGE dispatch fence after definitive HTTP %s rejection',
    async (status) => {
      const statusError = {
        response: {
          status,
          data: {
            message: 'definitive rejection',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const actionLedgerService = {
        claimSendDispatch: jest.fn().mockResolvedValue({
          kind: 'claimed',
          dispatchToken: 'dispatch-token-1',
        }),
        completeSendDispatch: jest.fn(),
        releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
        recordAmbiguousSendDispatch: jest.fn(),
      };
      const service = createService(httpService, {}, undefined, actionLedgerService);
      const job = {
        actionType: 'SEND_MESSAGE' as const,
        chatId: 'chat-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: `send-fenced-${status}`,
        createdAt: new Date().toISOString(),
      };

      const thrown = await service.executeActionJob(job).then(
        () => null,
        (error: unknown) => error,
      );

      if (status === 429) {
        expect(thrown).toBe(statusError);
      } else {
        expect(thrown).toBeInstanceOf(UnrecoverableError);
        expect(thrown).toHaveProperty('response', statusError.response);
        expect(thrown).toHaveProperty(
          'message',
          `MAX SEND_MESSAGE received definitive HTTP ${status} for chat chat-1`,
        );
      }

      expect(actionLedgerService.releaseSendDispatch).toHaveBeenCalledWith(job, 'dispatch-token-1');
      expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();

      await service.onModuleDestroy();
    },
  );

  it('integrates definitive 403 fence release with routed survivor failover', async () => {
    const denied = {
      response: {
        status: 403,
        data: {
          code: 'chat.denied',
          message: 'chat denied',
        },
      },
    };
    const httpService = {
      request: jest.fn((config: { headers?: { Authorization?: string } }) =>
        config.headers?.Authorization === 'bot-1-token'
          ? throwError(() => denied)
          : of({
              status: 200,
              data: {
                mid: 'mid-survivor-1',
              },
            }),
      ),
    };
    const actionLedgerService = {
      getCompletedSendDispatch: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn(async (_job: unknown, botId: string) => ({
        kind: 'claimed',
        dispatchToken: `dispatch-${botId}`,
      })),
      completeSendDispatch: jest.fn().mockResolvedValue(undefined),
      releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
      recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const client = createService(httpService, {}, undefined, actionLedgerService);
    const botRegistry = (client as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'bot-1' || botId === 'bot-2') {
        return {
          ...defaultBot,
          id: botId,
          token: `${botId}-token`,
        };
      }
      return null;
    });
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'chat-1',
          botId: 'bot-1',
          nextOwnerBotId: 'bot-2',
          updatedAccessEdges: 1,
          cleanup: {
            nightModeJobsCleared: false,
            canceledBroadcasts: null,
            canceledBroadcastDeliveries: null,
            canceledBroadcastOccurrences: null,
            clearedVkPublishPosts: null,
            pausedVkSources: null,
            removedRosterSyncJobs: null,
          },
        },
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const dispatch = new MaxActionDispatchService(
      client,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await dispatch.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1', 'bot-2'],
      routing: { purpose: 'send_message' },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'send-fenced-survivor',
      createdAt: new Date().toISOString(),
    });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(actionLedgerService.releaseSendDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
      'dispatch-bot-1',
    );
    expect(actionLedgerService.completeSendDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
      'dispatch-bot-2',
      'mid-survivor-1',
    );
    expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();

    await client.onModuleDestroy();
  });

  it.each([
    {
      label: 'timeout',
      error: Object.assign(new Error('timeout of 1500ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    },
    {
      label: 'HTTP 500',
      error: {
        response: {
          status: 500,
          data: {
            message: 'server failure',
          },
        },
      },
    },
  ])('retains and quarantines the SEND_MESSAGE fence after $label', async ({ error }) => {
    const httpService = {
      request: jest.fn(() => throwError(() => error)),
    };
    const retainedFenceError = Object.assign(
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE dispatch fence requires manual review'),
      { maxSendDispatchLedgerFinalized: true },
    );
    const actionLedgerService = {
      claimSendDispatch: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'claimed',
          dispatchToken: 'dispatch-token-1',
        })
        .mockRejectedValueOnce(retainedFenceError),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'send-fenced-ambiguous',
      createdAt: new Date().toISOString(),
    };

    await expect(service.executeActionJob(job)).rejects.toMatchObject({
      name: 'UnrecoverableError',
      maxSendDispatchLedgerFinalized: true,
    });
    await expect(
      service.executeActionJob({
        ...job,
        attempt: 2,
      }),
    ).rejects.toBe(retainedFenceError);

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.releaseSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.recordAmbiguousSendDispatch).toHaveBeenCalledWith(
      job,
      'dispatch-token-1',
      expect.any(UnrecoverableError),
    );

    await service.onModuleDestroy();
  });

  it('inherits queued send dispatch context when scheduling auto-delete', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-sent-1',
          },
        }),
      ),
    };
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(httpService, {}, actionQueue);

    await service.executeActionJob({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      botId: '777000_bot',
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
      timeoutMs: 1_234,
      autoDeleteDelayMs: 60_000,
      ignoreFailureMetricStatuses: [404],
      attempt: 1,
      idempotencyKey: 'send-auto-delete-context',
      createdAt: new Date().toISOString(),
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 1_234,
      }),
    );
    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-sent-1',
        botId: '777000_bot',
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
        timeoutMs: 1_234,
        ignoreFailureMetricStatuses: [404],
      }),
      expect.objectContaining({
        delay: 60_000,
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses configurable failed action job retention limits', async () => {
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(
      {},
      {
        MAX_ACTION_FAILED_RETENTION_AGE_SEC: '3600',
        MAX_ACTION_FAILED_RETENTION_COUNT: '250',
      },
      actionQueue,
    );

    await service.sendMessage('chat-1', 'hello');

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.any(Object),
      expect.objectContaining({
        removeOnFail: {
          age: 3_600,
          count: 250,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('persists caller ledger context on queued sends', async () => {
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService({}, {}, actionQueue);

    await service.sendMessage('chat-1', 'Витрина продавца', undefined, {
      idempotencyKey: 'storefront-relay-chat-1-message-1',
      sourceTag: MAX_API_SOURCE_TAGS.KARAVAN_STOREFRONT_RELAY,
      ledgerContext: {
        karavanStorefrontRelay: {
          sourceMessageId: 'message-1',
          senderId: 'user-1',
        },
      },
    });

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        sourceTag: MAX_API_SOURCE_TAGS.KARAVAN_STOREFRONT_RELAY,
        ledgerContext: {
          karavanStorefrontRelay: {
            sourceMessageId: 'message-1',
            senderId: 'user-1',
          },
        },
      }),
      expect.any(Object),
    );

    await service.onModuleDestroy();
  });

  it('inherits immediate send dispatch context when scheduling auto-delete', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-immediate-1',
          },
        }),
      ),
    };
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(httpService, {}, actionQueue);

    await service.sendMessage('chat-1', 'hello', undefined, {
      immediate: true,
      autoDeleteDelayMs: 30_000,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      timeoutMs: 2_345,
      ignoreFailureMetricStatuses: [404],
      botId: '777000_bot',
    });

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-immediate-1',
        botId: '777000_bot',
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
        timeoutMs: 2_345,
        ignoreFailureMetricStatuses: [404],
      }),
      expect.objectContaining({
        delay: 30_000,
      }),
    );

    await service.onModuleDestroy();
  });

  it.each([408, 504])(
    'marks ambiguous queued SEND_MESSAGE HTTP %s responses as unrecoverable',
    async (status) => {
      const statusError = {
        response: {
          status,
          data: {
            message: 'upstream timeout',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      await expect(
        service.executeActionJob({
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          text: 'hello',
          attempt: 1,
          idempotencyKey: `send-http-${status}`,
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      await service.onModuleDestroy();
    },
  );

  it.each([
    {
      actionType: 'BAN_MEMBER' as const,
      expectedParams: {
        user_id: 'user-1',
        block: true,
      },
    },
    {
      actionType: 'KICK_MEMBER' as const,
      expectedParams: {
        user_id: 'user-1',
      },
    },
  ])(
    'marks ambiguous queued $actionType transport timeouts as unrecoverable',
    async ({ actionType, expectedParams }) => {
      const timeoutError = Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
      });
      const httpService = {
        request: jest.fn(() => throwError(() => timeoutError)),
      };
      const service = createService(httpService);

      const error = await service
        .executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-timeout`,
          createdAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(wasMaxMemberMutationAttempted(error)).toBe(true);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'delete',
          url: 'https://platform-api2.max.ru/chats/chat-1/members',
          params: expectedParams,
        }),
      );

      await service.onModuleDestroy();
    },
  );

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'marks ambiguous queued %s HTTP 504 responses as unrecoverable',
    async (actionType) => {
      const statusError = {
        response: {
          status: 504,
          data: {
            message: 'gateway timeout',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      await expect(
        service.executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-http-504`,
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      await service.onModuleDestroy();
    },
  );

  it('clears terminal ban state only after MAX confirms an unban', async () => {
    const httpService = {
      request: jest.fn(() => of({ data: {} })),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await service.executeActionJob({
      actionType: 'UNBAN_MEMBER',
      chatId: 'chat-1',
      userId: 'user-1',
      attempt: 1,
      idempotencyKey: 'unban-member-1',
      createdAt: new Date().toISOString(),
    });

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
    );
    expect(httpService.request.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.clearTerminalBanStateAfterUnban.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it('marks an UNBAN_MEMBER transport failure after its HTTP mutation callback begins', async () => {
    const transportError = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    const httpService = {
      request: jest.fn(() => throwError(() => transportError)),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    const error = await service
      .executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-transport-failure',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(transportError);
    expect(wasMaxMemberMutationAttempted(error)).toBe(true);
    expect(wasMaxMemberMutationConfirmed(error)).toBe(false);
    expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps the UNBAN_MEMBER attempt marker when post-mutation ledger cleanup fails', async () => {
    const ledgerError = new Error('terminal ban state cleanup failed');
    const httpService = {
      request: jest.fn(() => of({ data: {} })),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn().mockRejectedValue(ledgerError),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    const error = await service
      .executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-ledger-failure',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(ledgerError);
    expect(wasMaxMemberMutationAttempted(error)).toBe(true);
    expect(wasMaxMemberMutationConfirmed(error)).toBe(true);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('treats a documented already-present success=false response as confirmed unban state', async () => {
    const httpService = {
      request: jest.fn(() =>
        of({
          status: 200,
          data: {
            success: false,
            message: 'User is already a chat member',
          },
        }),
      ),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-already-present',
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
    );

    await service.onModuleDestroy();
  });

  it('keeps terminal ban state when MAX rejects an unban', async () => {
    const maxError = new Error('unban rejected');
    const httpService = {
      request: jest.fn(() => throwError(() => maxError)),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-rejected',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBe(maxError);

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not treat an already-member phrase in a 5xx response as confirmed unban state', async () => {
    const serverError = {
      response: {
        status: 500,
        data: {
          message: 'User is already a chat member',
        },
      },
    };
    const httpService = {
      request: jest.fn(() => throwError(() => serverError)),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-server-error',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBe(serverError);

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('records successful immediate irreversible actions in the durable ledger', async () => {
    const httpService = {
      request: jest.fn(() => of({ data: {} })),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await service.banMember('chat-1', 'user-1', { immediate: true });

    const job = actionLedgerService.recordStarted.mock.calls[0][0];
    expect(job).toEqual(
      expect.objectContaining({
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expect.stringMatching(/^max-action__logical__/),
      }),
    );
    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job, new Date(job.createdAt));
    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSucceeded).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
    expect(actionLedgerService.assertCanEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordStarted.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordStarted.mock.invocationCallOrder[0]).toBeLessThan(
      httpService.request.mock.invocationCallOrder[0],
    );
    expect(httpService.request.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordSucceeded.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it('does not mark a member mutation attempted when the immediate action ledger start fails', async () => {
    const recordStartedError = new Error('action ledger unavailable');
    const httpService = {
      request: jest.fn(),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockRejectedValue(recordStartedError),
      recordSucceeded: jest.fn(),
      recordFailed: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    const error = await service
      .banMember('chat-1', 'user-1', { immediate: true })
      .catch((caught: unknown) => caught);

    expect(error).toBe(recordStartedError);
    expect(wasMaxMemberMutationAttempted(error)).toBe(false);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('checks the immediate member guard after routing and ledger work but before MAX HTTP', async () => {
    const leaseLostError = new Error('photo ordering lease lost');
    const httpService = {
      request: jest.fn(() => of({ data: {} })),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const resolveBotRoute = jest.fn().mockResolvedValue({
      purpose: 'moderation_action',
      chatId: 'chat-1',
      primaryBotId: '777000_bot',
      botId: '777000_bot',
      candidateBotIds: ['777000_bot'],
      reason: 'primary_confirmed',
      action: 'moderate_member',
    });
    const beforeImmediateMemberMutation = jest.fn().mockRejectedValue(leaseLostError);
    const service = createService(httpService, {}, undefined, actionLedgerService);
    (service as any).maxBotLinkService = { resolveBotRoute };

    const error = await service
      .banMember('chat-1', 'user-1', {
        immediate: true,
        beforeImmediateMemberMutation,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(leaseLostError);
    expect((error as Error & { code?: string }).code).toBe(
      MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );
    expect(wasMaxMemberMutationAttempted(error)).toBe(false);
    expect(resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordStarted).toHaveBeenCalledTimes(1);
    expect(beforeImmediateMemberMutation).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(
      expect.not.objectContaining({ beforeImmediateMemberMutation: expect.anything() }),
      leaseLostError,
    );
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect((service as any).actionHealthService.recordFailureForLane).not.toHaveBeenCalled();
    expect(resolveBotRoute.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordStarted.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordStarted.mock.invocationCallOrder[0]).toBeLessThan(
      beforeImmediateMemberMutation.mock.invocationCallOrder[0],
    );

    await expect(
      service.banMember('chat-1', 'user-1', { immediate: true }),
    ).resolves.toBeUndefined();

    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledTimes(2);
    expect(actionLedgerService.recordStarted).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordSucceeded).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('rejects a queued member mutation guard before routing or enqueue', async () => {
    const beforeImmediateMemberMutation = jest.fn();
    const resolveBotRoute = jest.fn();
    const service = createService({ request: jest.fn() });
    (service as any).maxBotLinkService = { resolveBotRoute };

    await expect(
      service.banMember('chat-1', 'user-1', { beforeImmediateMemberMutation }),
    ).rejects.toThrow('Member mutation guard requires immediate dispatch');

    expect(beforeImmediateMemberMutation).not.toHaveBeenCalled();
    expect(resolveBotRoute).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('quarantines ambiguous immediate irreversible actions before later retries reach MAX', async () => {
    const timeoutError = Object.assign(new Error('timeout exceeded when trying to connect'), {
      code: 'ETIMEDOUT',
    });
    const manualReviewError = new UnrecoverableError('manual review required');
    const httpService = {
      request: jest.fn(() => throwError(() => timeoutError)),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.kickMember('chat-1', 'user-1', { immediate: true }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const job = actionLedgerService.recordStarted.mock.calls[0][0];
    expect(job).toEqual(
      expect.objectContaining({
        actionType: 'KICK_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(job.idempotencyKey).not.toMatch(/^max-action__logical__/);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(
      job,
      expect.any(UnrecoverableError),
    );
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();

    httpService.request.mockClear();
    actionLedgerService.recordStarted.mockClear();
    actionLedgerService.recordFailed.mockClear();
    actionLedgerService.assertCanEnqueue.mockRejectedValueOnce(manualReviewError);

    await expect(service.kickMember('chat-1', 'user-1', { immediate: true })).rejects.toBe(
      manualReviewError,
    );
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([500, 502, 503])(
    'marks queued SEND_MESSAGE HTTP %s responses as ambiguous and unrecoverable',
    async (status) => {
      const statusError = {
        response: {
          status,
          data: {
            message: 'server failure',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      await expect(
        service.executeActionJob({
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          text: 'hello',
          attempt: 1,
          idempotencyKey: `send-http-${status}`,
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(httpService.request).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
    },
  );

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'marks queued %s HTTP 5xx responses as ambiguous and unrecoverable',
    async (actionType) => {
      const statusError = {
        response: {
          status: 500,
          data: {
            message: 'server failure',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      const error = await service
        .executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-http-500`,
          createdAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({
        response: statusError.response,
      });
      expect(wasMaxMemberMutationAttempted(error)).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
    },
  );

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'keeps queued %s HTTP 429 responses retryable',
    async (actionType) => {
      const rateLimitError = {
        response: {
          status: 429,
          data: {
            code: 'too.many.requests',
            message: 'too many requests',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => rateLimitError)),
      };
      const service = createService(httpService);

      const error = await service
        .executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-http-429`,
          createdAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBe(rateLimitError);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(wasMaxMemberMutationAttempted(error)).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
    },
  );

  it('trims inline keyboard buttons to 210 and logs warning', async () => {
    const service = createService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const buttons = Array.from({ length: 220 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
      debugContext: {
        screen: 'home',
        action: 'render',
      },
    }) as Array<Array<Record<string, unknown>>> | null;

    const delivered = (normalized ?? []).reduce((acc, row) => acc + row.length, 0);
    expect(delivered).toBe(210);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedButtons: 220,
        deliveredButtons: 210,
        screen: 'home',
        action: 'render',
      }),
      expect.stringContaining('Inline keyboard exceeds MAX limit'),
    );

    await service.onModuleDestroy();
  });

  it('keeps inline keyboard as-is when button count is within limit', async () => {
    const service = createService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const buttons = Array.from({ length: 3 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
    }) as Array<Array<Record<string, unknown>>> | null;

    const delivered = (normalized ?? []).reduce((acc, row) => acc + row.length, 0);
    expect(delivered).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('splits oversized callback rows to MAX row limits', async () => {
    const service = createService();

    const buttons = Array.from({ length: 8 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.length)).toEqual([7, 1]);

    await service.onModuleDestroy();
  });

  it('moves link and open_app action buttons to their own MAX rows', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          { type: 'link' as const, text: 'L1', url: 'https://example.com/1' },
          { type: 'link' as const, text: 'L2', url: 'https://example.com/2' },
          {
            type: 'open_app' as const,
            text: 'App',
            webApp: 'https://major-maksimov.ru/app/',
          },
          { type: 'link' as const, text: 'L4', url: 'https://example.com/4' },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.length)).toEqual([1, 1, 1, 1]);

    await service.onModuleDestroy();
  });

  it('keeps Karavan-style channel CTA buttons from sharing one clipped MAX row', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'link' as const,
            text: 'Зайти в Караван🐪',
            url: 'https://example.com/karavan',
          },
          {
            type: 'link' as const,
            text: 'Открыть свою витрину 🏪',
            url: 'https://example.com/storefront',
          },
          {
            type: 'link' as const,
            text: 'Тех поддержка ⚙️',
            url: 'https://example.com/support',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.map((button) => button.text))).toEqual([
      ['Зайти в Караван🐪'],
      ['Открыть свою витрину 🏪'],
      ['Тех поддержка ⚙️'],
    ]);

    await service.onModuleDestroy();
  });

  it('moves long link button labels to their own MAX rows', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'link' as const,
            text: 'Связь с администратором',
            url: 'https://example.com/admin',
          },
          {
            type: 'link' as const,
            text: 'Открыть подробные правила',
            url: 'https://example.com/rules',
          },
          {
            type: 'link' as const,
            text: 'Проверить обязательную подписку',
            url: 'https://example.com/subscription',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.map((button) => button.text))).toEqual([
      ['Связь с администратором'],
      ['Открыть подробные правила'],
      ['Проверить обязательную подписку'],
    ]);

    await service.onModuleDestroy();
  });

  it('supports open_app button type for native miniapp opening', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'open_app',
            text: 'Открыть miniapp',
            webApp: 'https://major-maksimov.ru/app/',
            contactId: '613002203036',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'open_app',
          text: 'Открыть miniapp',
          web_app: 'https://major-maksimov.ru/app/',
          contact_id: '613002203036',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('drops link buttons with non-http or oversized urls before MAX send', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          { type: 'link', text: 'Bad scheme', url: 'max://user/user-42' },
          { type: 'link', text: 'Bad url', url: 'not a url' },
          {
            type: 'link',
            text: 'Whitespace and nested url',
            url: 'https://example.test/path https://nested.example.test',
          },
          {
            type: 'link',
            text: 'Nested url path',
            url: 'https://max.ru/chat/example/https://nested.example.test',
          },
          {
            type: 'link',
            text: 'Encoded nested url path',
            url: 'https://max.ru/chat/example/https%3A%2F%2Fnested.example.test',
          },
          { type: 'link', text: 'Too long', url: `https://example.com/${'a'.repeat(2049)}` },
          {
            type: 'link',
            text: 'Too long before canonicalization',
            url: `https://example.com/${'a/../'.repeat(500)}open`,
          },
          { type: 'link', text: 'Good', url: ' https://example.com/path?x=1 ' },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [{ type: 'link', text: 'Good', url: 'https://example.com/path?x=1' }],
    ]);

    await service.onModuleDestroy();
  });

  it('drops open_app buttons without a valid web_app or contact_id', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          { type: 'open_app', text: 'Bad app', webApp: 'javascript:alert(1)' },
          { type: 'open_app', text: 'Contact only', contactId: 613002203036 },
          { type: 'open_app', text: 'Good app', webApp: 'https://major-maksimov.ru/app/' },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'open_app',
          text: 'Contact only',
          contact_id: '613002203036',
        },
      ],
      [
        {
          type: 'open_app',
          text: 'Good app',
          web_app: 'https://major-maksimov.ru/app/',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('supports clipboard button type', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'clipboard',
            text: 'Скопировать',
            payload: 'promo-2026',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'clipboard',
          text: 'Скопировать',
          payload: 'promo-2026',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('throws when MAX mutation responds with success=false under HTTP 200', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-1',
                    text: 'Текст',
                    format: 'html',
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: false,
              message: 'Error on message edit',
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.editMessageInlineKeyboard('chat-1', 'mid-edit-1', 'Текст', {
        button: {
          text: 'Открыть',
          url: 'https://major-maksimov.ru/app/',
        },
      }),
    ).rejects.toThrow('Error on message edit');
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-1',
        },
        data: expect.objectContaining({
          text: 'Текст',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs an edit guard after reading the source message and before the HTTP mutation', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-edit-guard-1',
                  text: 'Текст',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const guardError = new Error('edit no longer authorized');
    const beforeEditMutation = jest.fn(async () => {
      expect(httpService.request).toHaveBeenCalledTimes(1);
      throw guardError;
    });

    await expect(
      service.editMessageInlineKeyboard('chat-1', 'mid-edit-guard-1', 'Текст', {
        beforeEditMutation,
      }),
    ).rejects.toBe(guardError);

    expect(beforeEditMutation).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect((guardError as Error & { code?: string }).code).toBe(
      MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );

    await service.onModuleDestroy();
  });

  it('answers callback with notification and inline keyboard update in one request', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:35.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
            message: {
              message_id: 'mid-reply-1',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (
      service as unknown as { limiterRedis: { eval: jest.Mock; get: jest.Mock } }
    ).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await service.answerCallback('callback-1', 'Действие выполнено', {
      text: 'Обновление\n\n1. Вариант - 1 (100%)',
      options: {
        buttons: [[{ type: 'callback', text: 'Вариант (1)', payload: 'action|sample-1|1|0' }]],
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: {
          callback_id: 'callback-1',
        },
        data: {
          notification: 'Действие выполнено',
          message: {
            text: 'Обновление\n\n1. Вариант - 1 (100%)',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [{ type: 'callback', text: 'Вариант (1)', payload: 'action|sample-1|1|0' }],
                  ],
                },
              },
            ],
          },
        },
      }),
    );
    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:critical:callback_answer:${nowSec}`),
    ).resolves.toBe('1');
    const answerRateLimitKeys = limiterRedis.eval.mock.calls.flatMap((call) => {
      const keyCount = Number(call[1]);
      return call
        .slice(2, 2 + keyCount)
        .map(String)
        .filter((key: string) => key.includes('message-mutation:operation:answer:'));
    });
    expect(answerRateLimitKeys).toContain(
      'maxapi:gcra:v1:message-mutation:operation:answer:scope:unknown-target:bot:777000_bot',
    );
    expect(answerRateLimitKeys.join(' ')).not.toContain('callback-1');

    await service.onModuleDestroy();
  });

  it('answers callback with a message update without adding an undocumented notification', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { success: true },
        }),
      ),
    };
    const service = createService(httpService);

    await service.answerCallback('callback-message-only', undefined, {
      text: 'Текст администратора',
      options: {
        buttons: [[{ type: 'callback', text: 'Да', payload: 'poll|v2|poll-1|option-1' }]],
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: { callback_id: 'callback-message-only' },
        data: {
          message: {
            text: 'Текст администратора',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [[{ type: 'callback', text: 'Да', payload: 'poll|v2|poll-1|option-1' }]],
                },
              },
            ],
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('answers callback against the exact message while replacing only matching callback rows', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const existingComments = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const unrelatedCallback = {
      type: 'callback',
      text: 'Другое действие',
      payload: 'custom|poll-1|action',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-poll-answer-1',
                    text: 'Текст опроса',
                    attachments: [
                      existingImage,
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [existingComments],
                            [
                              {
                                type: 'callback',
                                text: 'Старый ответ',
                                payload: 'poll|v2|poll-1|option-old',
                              },
                            ],
                            [unrelatedCallback],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.answerCallback('callback-poll-answer-1', undefined, {
      messageId: 'mid-poll-answer-1',
      text: 'Текст опроса',
      options: {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Новый ответ',
              payload: 'poll|v2|poll-1|option-new',
            },
          ],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-poll-answer-1' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: { callback_id: 'callback-poll-answer-1' },
        data: {
          message: {
            text: 'Текст опроса',
            attachments: [
              existingImage,
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [existingComments],
                    [
                      {
                        type: 'callback',
                        text: 'Новый ответ',
                        payload: 'poll|v2|poll-1|option-new',
                      },
                    ],
                    [unrelatedCallback],
                  ],
                },
              },
            ],
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not mark a callback dispatch attempt when exact-message preparation fails', async () => {
    const preparationError = new Error('Exact callback message lookup failed');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(throwError(() => preparationError)),
    };
    const service = createService(httpService);
    const onDispatchAttempt = jest.fn();

    await expect(
      service.answerCallback(
        'callback-prepare-failure',
        undefined,
        {
          messageId: 'mid-callback-prepare-failure',
          text: 'Текст опроса',
        },
        { onDispatchAttempt },
      ),
    ).rejects.toBe(preparationError);

    expect(onDispatchAttempt).not.toHaveBeenCalled();
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post' }),
    );

    await service.onModuleDestroy();
  });

  it('marks a callback dispatch immediately before POST even when the POST fails', async () => {
    const order: string[] = [];
    const dispatchError = new Error('Callback answer POST failed');
    const httpService = {
      request: jest.fn().mockImplementation((config: { method: string }) => {
        if (config.method === 'get') {
          order.push('get');
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-callback-dispatch-failure',
                    text: 'Текст опроса',
                    attachments: [],
                  },
                },
              ],
            },
          });
        }
        order.push('post');
        return throwError(() => dispatchError);
      }),
    };
    const service = createService(httpService);
    const onDispatchAttempt = jest.fn(() => {
      order.push('dispatch-attempt');
    });

    await expect(
      service.answerCallback(
        'callback-dispatch-failure',
        undefined,
        {
          messageId: 'mid-callback-dispatch-failure',
          text: 'Текст опроса',
        },
        { onDispatchAttempt },
      ),
    ).rejects.toBe(dispatchError);

    expect(order).toEqual(['get', 'dispatch-attempt', 'post']);
    expect(onDispatchAttempt).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('does not edit a message after losing the keyboard lock before the mutation', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-lost-edit-lock-1',
                  text: 'Текст опроса',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const evalMock = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis
      .eval;
    const originalEval = evalMock.getMockImplementation()!;
    let renewalCount = 0;
    evalMock.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
        renewalCount += 1;
        return renewalCount === 1 ? 1 : 0;
      }
      return originalEval(script, ...args);
    });

    await expect(
      service.editMessageInlineKeyboard('channel-1', 'mid-lost-edit-lock-1', 'Текст опроса', {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Да',
              payload: 'poll|v2|poll-1|option-1',
            },
          ],
        ],
      }),
    ).rejects.toThrow('Lost ownership of the MAX message keyboard edit lock');
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'put' }),
    );
    expect(renewalCount).toBe(2);

    await service.onModuleDestroy();
  });

  it('rechecks the keyboard lock after an asynchronous edit guard and before PUT', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-lost-edit-lock-after-guard-1',
                  text: 'Текст опроса',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const evalMock = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis
      .eval;
    const originalEval = evalMock.getMockImplementation()!;
    let renewalCount = 0;
    evalMock.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
        renewalCount += 1;
        return renewalCount < 3 ? 1 : 0;
      }
      return originalEval(script, ...args);
    });
    const beforeEditMutation = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.editMessageInlineKeyboard(
        'channel-1',
        'mid-lost-edit-lock-after-guard-1',
        'Текст опроса',
        {
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
          ],
          beforeEditMutation,
        },
      ),
    ).rejects.toThrow('Lost ownership of the MAX message keyboard edit lock');

    expect(beforeEditMutation).toHaveBeenCalledTimes(1);
    expect(renewalCount).toBe(3);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'put' }),
    );

    await service.onModuleDestroy();
  });

  it('does not answer a callback after losing the exact-message keyboard lock', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-lost-callback-lock-1',
                  text: 'Текст опроса',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const evalMock = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis
      .eval;
    const originalEval = evalMock.getMockImplementation()!;
    let renewalCount = 0;
    evalMock.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
        renewalCount += 1;
        return renewalCount === 1 ? 1 : 0;
      }
      return originalEval(script, ...args);
    });

    await expect(
      service.answerCallback('callback-lost-lock-1', undefined, {
        messageId: 'mid-lost-callback-lock-1',
        text: 'Текст опроса',
        options: {
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
          ],
        },
      }),
    ).rejects.toThrow('Lost ownership of the MAX message keyboard edit lock');
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post' }),
    );
    expect(renewalCount).toBe(2);

    await service.onModuleDestroy();
  });

  it('serializes callback and comment-counter keyboard edits for the same message', async () => {
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии · 1',
      url: 'https://major-maksimov.ru/app/',
    };
    let currentAttachments: unknown[] = [];
    let releaseAnswer!: () => void;
    let markAnswerStarted!: () => void;
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const answerStarted = new Promise<void>((resolve) => {
      markAnswerStarted = resolve;
    });
    const httpService = {
      request: jest.fn().mockImplementation((config: any) => {
        if (config.method === 'get') {
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-serialized-keyboard-1',
                    text: 'Текст опроса',
                    attachments: currentAttachments,
                  },
                },
              ],
            },
          });
        }
        if (config.method === 'post' && config.url.endsWith('/answers')) {
          markAnswerStarted();
          return from(
            answerGate.then(() => {
              currentAttachments = config.data.message.attachments;
              return { status: 200, data: { success: true } };
            }),
          );
        }
        if (config.method === 'put') {
          currentAttachments = config.data.attachments;
          return of({ status: 200, data: { success: true } });
        }
        throw new Error(`Unexpected request ${config.method} ${config.url}`);
      }),
    };
    const service = createService(httpService);

    const callbackEdit = service.answerCallback('callback-serialized-1', undefined, {
      messageId: 'mid-serialized-keyboard-1',
      text: 'Текст опроса',
      options: {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Да',
              payload: 'poll|v2|poll-1|option-1',
            },
          ],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    });
    await answerStarted;

    const counterEdit = service.editMessageInlineKeyboard(
      'channel-1',
      'mid-serialized-keyboard-1',
      null,
      {
        buttons: [[commentsButton]],
        appendNewInlineKeyboardRows: true,
        mergeExistingInlineKeyboard: true,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      httpService.request.mock.calls.filter(([config]: [any]) => config.method === 'get'),
    ).toHaveLength(1);

    releaseAnswer();
    await Promise.all([callbackEdit, counterEdit]);

    expect(currentAttachments).toEqual([
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
            [commentsButton],
          ],
        },
      },
    ]);

    await service.onModuleDestroy();
  });

  it('preserves explicit source tags and action health lanes for callback answers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:45.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (service as unknown as { limiterRedis: { get: jest.Mock } }).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await service.answerCallback('callback-2', 'Открываю', undefined, {
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: { callback_id: 'callback-2' },
        data: { notification: 'Открываю' },
      }),
    );
    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:critical:moderation_notice:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('sends direct messages via user_id when notifying a private user', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-private-1',
            recipient: {
              chat_id: '165176099',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateToUser('user-42', 'Личное уведомление');

    expect(result).toEqual({
      messageId: 'mid-private-1',
      url: null,
      chatId: '165176099',
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          user_id: 'user-42',
        },
        data: {
          text: 'Личное уведомление',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs the direct-user send fence immediately before the MAX POST', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn().mockImplementationOnce(() => {
        order.push('post');
        return of({
          status: 200,
          data: {
            mid: 'mid-private-fenced',
            recipient: { chat_id: '165176099' },
          },
        });
      }),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateToUser('user-42', 'Личное уведомление', {
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['fence', 'post']);
    await service.onModuleDestroy();
  });

  it('reposts a source chat message as bot copy with preserved attachments and reply link', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-1',
                    text: 'Исходный пост админа',
                    markup: [
                      {
                        from: 0,
                        type: 'strong',
                        length: 8,
                      },
                    ],
                    attachments: [
                      {
                        type: 'image',
                        payload: { token: 'upload-token-1' },
                      },
                    ],
                  },
                  link: {
                    type: 'reply',
                    message: {
                      mid: 'mid-parent-1',
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-copy-1',
              url: 'https://max.ru/chats/chat-1/message/789',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-1',
      'Фолбэк текст',
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-copy-1',
      url: 'https://max.ru/chats/chat-1/message/789',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-source-1' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: '**Исходный** пост админа',
          format: 'markdown',
          link: {
            type: 'reply',
            mid: 'mid-parent-1',
          },
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: '💬 Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs the replacement send fence after source preparation and immediately before POST', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest
        .fn()
        .mockImplementationOnce(() => {
          order.push('get');
          return of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'mid-source-fence', text: 'Source', attachments: [] } }],
            },
          });
        })
        .mockImplementationOnce(() => {
          order.push('post');
          return of({ status: 200, data: { mid: 'mid-copy-fence' } });
        }),
    };
    const service = createService(httpService);

    await service.sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-fence', 'Source', {
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['get', 'fence', 'post']);
    await service.onModuleDestroy();
  });

  it('does not run the replacement send fence when reading the source message fails', async () => {
    const beforeSend = jest.fn();
    const httpService = {
      request: jest.fn().mockReturnValue(
        throwError(() => ({
          response: { status: 404, data: { code: 'message.not.found' } },
          message: 'Source message not found',
        })),
      ),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-missing', 'Source', { beforeSend })
      .catch((caught: unknown) => caught);

    expect(beforeSend).not.toHaveBeenCalled();
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(wasMaxMessageSendAttempted(error)).toBe(false);
    await service.onModuleDestroy();
  });

  it('does not POST when the replacement send fence cannot be persisted', async () => {
    const fenceError = new Error('marker unavailable');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [{ body: { mid: 'mid-source-no-post', text: 'Source', attachments: [] } }],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-no-post', 'Source', {
        beforeSend: async () => {
          throw fenceError;
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(fenceError);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(wasMaxMessageSendAttempted(error)).toBe(false);
    await service.onModuleDestroy();
  });

  it('marks a replacement POST timeout as an attempted MAX send', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'mid-source-timeout', text: 'Source', attachments: [] } }],
            },
          }),
        )
        .mockReturnValueOnce(
          throwError(() => Object.assign(new Error('send timed out'), { code: 'ETIMEDOUT' })),
        ),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-timeout', 'Source', {
        beforeSend: async () => undefined,
      })
      .catch((caught: unknown) => caught);

    expect(wasMaxMessageSendAttempted(error)).toBe(true);
    await service.onModuleDestroy();
  });

  it('marks a replacement response without a message id as an attempted MAX send', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'mid-source-no-id', text: 'Source', attachments: [] } }],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-no-id', 'Source', {
        beforeSend: async () => undefined,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(wasMaxMessageSendAttempted(error)).toBe(true);
    await service.onModuleDestroy();
  });

  it('uses fallback text and linked attachments when reposting a forwarded message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-forward-source-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: 'Пересланный пост',
                      attachments: [
                        {
                          type: 'image',
                          payload: { token: 'upload-token-forward-1' },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-forward-copy-1',
              url: 'https://max.ru/chats/chat-1/message/790',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-forward-source-1',
      'Пересланный пост',
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-forward-copy-1',
      url: 'https://max.ru/chats/chat-1/message/790',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Пересланный пост',
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-forward-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: '💬 Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves linked forwarded message markup and paragraphs when reposting with inline keyboard', async () => {
    const sourceText = '🔥MAX Docs\n\nВторой абзац';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-forward-rich-source-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: sourceText,
                      markup: [
                        {
                          from: 2,
                          type: 'strong',
                          length: 8,
                        },
                        {
                          from: 2,
                          type: 'link',
                          length: 8,
                          url: 'https://dev.max.ru/docs-api',
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-forward-rich-copy-1',
              url: 'https://max.ru/chats/chat-1/message/791',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-forward-rich-source-1',
      sourceText,
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-forward-rich-copy-1',
      url: 'https://max.ru/chats/chat-1/message/791',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: expect.objectContaining({
          text: '🔥[**MAX Docs**](https://dev.max.ru/docs-api)\n\nВторой абзац',
          format: 'markdown',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves multi-paragraph MAX markup when reposting a source message copy', async () => {
    const sourceText = 'Заголовок\n\nВторой абзац';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-paragraphs-1',
                    text: sourceText,
                    markup: [
                      {
                        from: 0,
                        type: 'strong',
                        length: sourceText.length,
                      },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-copy-paragraphs-1',
              url: 'https://max.ru/chats/chat-1/message/792',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-paragraphs-1',
      sourceText,
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-copy-paragraphs-1',
      url: 'https://max.ru/chats/chat-1/message/792',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: expect.objectContaining({
          text: '**Заголовок**\n\n**Второй абзац**',
          format: 'markdown',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves MAX body markup when editing inline keyboard on an existing message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-markup-1',
                    text: '🔥Привет мир',
                    markup: [
                      {
                        from: 2,
                        type: 'strong',
                        length: 6,
                      },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-markup-1', '🔥Привет мир', {
      button: {
        text: 'Открыть',
        url: 'https://major-maksimov.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-markup-1',
        },
        data: expect.objectContaining({
          text: '🔥**Привет** мир',
          format: 'markdown',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('extracts MAX body markup as markdown text for imported rules', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-markup-1',
                  text: '🔥MAX Docs',
                  markup: [
                    {
                      from: 2,
                      type: 'strong',
                      length: 8,
                    },
                    {
                      from: 2,
                      type: 'emphasized',
                      length: 8,
                    },
                    {
                      from: 2,
                      type: 'underline',
                      length: 8,
                    },
                    {
                      from: 2,
                      type: 'link',
                      length: 8,
                      url: 'https://dev.max.ru/docs-api',
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-markup-1');

    expect(result).toBe('🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)');
    await service.onModuleDestroy();
  });

  it('extracts alternate MAX body text markup fields as markdown text', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-text-markup-1',
                  text: 'MAX Docs',
                  text_markup: [
                    {
                      from: 0,
                      type: 'strong',
                      length: 8,
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-text-markup-1');

    expect(result).toBe('**MAX Docs**');
    await service.onModuleDestroy();
  });

  it('normalizes MAX user mention markup to max user links', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-mention-1',
                  text: 'Стас',
                  markup: [
                    {
                      from: 0,
                      type: 'user_mention',
                      length: 4,
                      user_link: 'user/67123224',
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-mention-1');

    expect(result).toBe('[Стас](max://user/67123224)');
    await service.onModuleDestroy();
  });

  it('splits multi-paragraph MAX markup when extracting markdown text', async () => {
    const sourceText = 'Заголовок\n\nВторой абзац';
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-markup-2',
                  text: sourceText,
                  markup: [
                    {
                      from: 0,
                      type: 'strong',
                      length: sourceText.length,
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-markup-2');

    expect(result).toBe('**Заголовок**\n\n**Второй абзац**');
    await service.onModuleDestroy();
  });

  it('falls back to direct message lookup when batch lookup returns a different message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-other-1',
                    text: 'Не тот пост',
                    attachments: [
                      {
                        type: 'image',
                        payload: { token: 'wrong-image-token' },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              body: {
                mid: 'mid-edit-fallback-1',
                text: 'Старое сообщение',
                attachments: [
                  {
                    type: 'inline_keyboard',
                    payload: {
                      buttons: [
                        [{ type: 'callback', text: 'Да (1)', payload: 'action|sample-1|1|0' }],
                      ],
                    },
                  },
                ],
              },
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-fallback-1', 'Итоги действия', {
      buttons: [[{ type: 'callback', text: 'Да (2)', payload: 'action|sample-1|1|0' }]],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-edit-fallback-1',
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-fallback-1',
        },
        data: {
          text: 'Итоги действия',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'callback', text: 'Да (2)', payload: 'action|sample-1|1|0' }]],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('honors explicit html text format when editing an existing message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-html-1',
                    text: 'Старый текст',
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-html-1', '<p>Новый текст</p>', {
      textFormat: 'html',
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-html-1',
        },
        data: expect.objectContaining({
          text: '<p>Новый текст</p>',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves an existing inline keyboard when a text-only decorator edits the message', async () => {
    const existingKeyboard = {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Открыть',
              url: 'https://major-maksimov.ru/app/',
            },
          ],
        ],
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-preserve-keyboard-1',
                    text: 'Исходный текст',
                    attachments: [
                      { type: 'image', payload: { token: 'image-token-1' } },
                      existingKeyboard,
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'chat-1',
      'mid-edit-preserve-keyboard-1',
      'Исходный текст<br><br><a href="https://max.ru/channel">Канал</a>',
      {
        textFormat: 'html',
        preserveExistingInlineKeyboard: true,
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          format: 'html',
          attachments: [{ type: 'image', payload: { token: 'image-token-1' } }, existingKeyboard],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('replaces only matching callback payload prefixes during an active poll edit', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const commentsButton = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const unrelatedPollCallback = {
      type: 'callback',
      text: 'Другой опрос',
      payload: 'poll|v2|poll-10|option-1',
    };
    const customCallback = {
      type: 'callback',
      text: 'Настроить',
      payload: 'custom|settings',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-active-poll-edit-1',
                    text: 'Текст опроса',
                    attachments: [
                      existingImage,
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [commentsButton],
                            [
                              {
                                type: 'callback',
                                text: 'Старый 1',
                                payload: 'poll|v2|poll-1|option-old-1',
                              },
                            ],
                            [
                              {
                                type: 'callback',
                                text: 'Старый 2',
                                payload: 'poll|v2|poll-1|option-old-2',
                              },
                              customCallback,
                            ],
                            [unrelatedPollCallback],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('channel-1', 'mid-active-poll-edit-1', 'Текст опроса', {
      buttons: [
        [
          {
            type: 'callback',
            text: 'Новый 1',
            payload: 'poll|v2|poll-1|option-new-1',
          },
        ],
        [
          {
            type: 'callback',
            text: 'Новый 2',
            payload: 'poll|v2|poll-1|option-new-2',
          },
        ],
      ],
      replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            existingImage,
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [commentsButton],
                  [
                    {
                      type: 'callback',
                      text: 'Новый 1',
                      payload: 'poll|v2|poll-1|option-new-1',
                    },
                  ],
                  [
                    {
                      type: 'callback',
                      text: 'Новый 2',
                      payload: 'poll|v2|poll-1|option-new-2',
                    },
                  ],
                  [customCallback],
                  [unrelatedPollCallback],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('unwraps the exact direct-message fallback before preserving poll media and engagement', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const commentsButton = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'some-other-message', attachments: [] } }],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              message: {
                body: {
                  mid: 'mid-direct-wrapper-poll-1',
                  text: 'Текст опроса',
                  attachments: [
                    existingImage,
                    {
                      type: 'inline_keyboard',
                      payload: {
                        buttons: [
                          [
                            {
                              type: 'callback',
                              text: 'Старый ответ',
                              payload: 'poll|v2|poll-1|option-old',
                            },
                          ],
                          [commentsButton],
                        ],
                      },
                    },
                  ],
                },
              },
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'channel-1',
      'mid-direct-wrapper-poll-1',
      'Текст опроса',
      {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Новый ответ',
              payload: 'poll|v2|poll-1|option-new',
            },
          ],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            existingImage,
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'callback',
                      text: 'Новый ответ',
                      payload: 'poll|v2|poll-1|option-new',
                    },
                  ],
                  [commentsButton],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('adds missing poll engagement without duplicating an existing dialog button', async () => {
    const threadId = '12345678-1234-4123-8123-123456789abc';
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии',
      url: `https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=${token}`,
    };
    const existingSuggestButton = {
      type: 'link' as const,
      text: 'Предложить пост',
      url: `https://major-maksimov.ru/app/channel/channel-1/dialog/suggest?token=${token}`,
    };
    const rebuiltSuggestButton = {
      ...existingSuggestButton,
      text: 'Предложить',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-missing-engagement-1',
                    text: 'Текст опроса',
                    attachments: [
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [
                              {
                                type: 'callback',
                                text: 'Старый ответ',
                                payload: 'poll|v2|poll-1|option-old',
                              },
                            ],
                            [existingSuggestButton],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'channel-1',
      'mid-missing-engagement-1',
      'Текст опроса',
      {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Новый ответ',
              payload: 'poll|v2|poll-1|option-new',
            },
          ],
          [commentsButton],
          [rebuiltSuggestButton],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'callback',
                      text: 'Новый ответ',
                      payload: 'poll|v2|poll-1|option-new',
                    },
                  ],
                  [commentsButton],
                  [existingSuggestButton],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('removes only matching callback payload prefixes when a poll closes', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const commentsButton = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const unrelatedCallback = {
      type: 'callback',
      text: 'Другое действие',
      payload: 'custom|action',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-closed-poll-edit-1',
                    text: 'Текст опроса',
                    attachments: [
                      existingImage,
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [
                              {
                                type: 'callback',
                                text: 'Ответ',
                                payload: 'poll|v2|poll-1|option-1',
                              },
                            ],
                            [commentsButton],
                            [unrelatedCallback],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('channel-1', 'mid-closed-poll-edit-1', 'Текст опроса', {
      replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            existingImage,
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[commentsButton], [unrelatedCallback]],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('updates a channel dialog label when the route changes but the thread stays the same', async () => {
    const threadId = '12345678-1234-4123-8123-123456789abc';
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const startParam = `cd-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'comments',
        t: token,
      }),
      'utf8',
    ).toString('base64url')}`;
    const existingCommentsUrl = `https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=${token}`;
    const updatedCommentsUrl = `https://max.ru/bot-2?startapp=${startParam}`;
    const existingKeyboard = {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Комментарии · 1',
              url: existingCommentsUrl,
            },
          ],
          [
            {
              type: 'link',
              text: 'Сайт',
              url: 'https://example.com/',
            },
          ],
        ],
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-merge-keyboard-1',
                    text: 'Исходный текст',
                    attachments: [
                      { type: 'image', payload: { token: 'image-token-1' } },
                      existingKeyboard,
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'chat-1',
      'mid-edit-merge-keyboard-1',
      'Исходный текст',
      {
        buttons: [
          [
            {
              type: 'link',
              text: 'Комментарии · 2',
              url: updatedCommentsUrl,
            },
          ],
        ],
        mergeExistingInlineKeyboard: true,
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            { type: 'image', payload: { token: 'image-token-1' } },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Комментарии · 2',
                      url: updatedCommentsUrl,
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Сайт',
                      url: 'https://example.com/',
                    },
                  ],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps custom row order and the existing thread while appending scanner system buttons', async () => {
    const buildDialogUrl = (kind: 'comments' | 'suggest', threadId: string) => {
      const token = `cdt-${Buffer.from(
        JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
        'utf8',
      ).toString('base64url')}`;
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          k: 'channel-dialog',
          c: 'channel-1',
          m: kind,
          t: token,
        }),
        'utf8',
      ).toString('base64url');
      return `https://max.ru/bot-1?startapp=cd-${payload}`;
    };
    const existingCommentsUrl = buildDialogUrl('comments', 'existing-thread');
    const replacementCommentsUrl = buildDialogUrl('comments', 'new-thread');
    const suggestionUrl = buildDialogUrl('suggest', 'new-thread');
    const existingKeyboard = {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Обсудить публикацию',
              url: existingCommentsUrl,
            },
          ],
          [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
          [
            {
              type: 'link',
              text: 'Комментарии другого канала',
              url: 'https://major-maksimov.ru/app/channel/channel-2/dialog/comments?token=cdt-other',
            },
          ],
        ],
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-semantic-merge-1',
                    text: 'Исходный текст',
                    attachments: [existingKeyboard],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'channel-1',
      'mid-edit-semantic-merge-1',
      'Исходный текст',
      {
        buttons: [
          [{ type: 'link', text: 'Комментарии', url: replacementCommentsUrl }],
          [{ type: 'link', text: 'Предложить', url: suggestionUrl }],
        ],
        appendNewInlineKeyboardRows: true,
        mergeExistingInlineKeyboard: true,
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
                  [
                    {
                      type: 'link',
                      text: 'Комментарии другого канала',
                      url: 'https://major-maksimov.ru/app/channel/channel-2/dialog/comments?token=cdt-other',
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Обсудить публикацию',
                      url: existingCommentsUrl,
                    },
                  ],
                  [{ type: 'link', text: 'Предложить', url: suggestionUrl }],
                ],
              },
            },
          ],
        }),
      }),
    );

    const editRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { attachments?: Array<{ payload?: { buttons?: unknown[][] } }> };
    };
    const deliveredButtons = editRequest.data?.attachments?.[0]?.payload?.buttons?.flat() ?? [];
    expect(deliveredButtons).not.toContainEqual(
      expect.objectContaining({ url: replacementCommentsUrl }),
    );
    await service.onModuleDestroy();
  });

  it('omits text when editing inline keyboard on forwarded messages with empty body text', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-forward-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: 'Пересланный текст',
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-forward-1', 'Пересланный текст', {
      button: {
        text: 'Открыть',
        url: 'https://major-maksimov.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-forward-1',
        },
        data: {
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends attachment-only reply messages with inline keyboard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
            message: {
              message_id: 'mid-reply-1',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageReplyWithInlineKeyboard('chat-1', 'mid-source-1', 'Открыть действия', {
      button: {
        text: 'Открыть',
        url: 'https://major-maksimov.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'chat-1',
        },
        data: {
          text: 'Открыть действия',
          link: {
            type: 'reply',
            mid: 'mid-source-1',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('publishes message and resolves post link via follow-up message fetch', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-1' },
                  message_url: 'https://max.ru/chats/chat-1/message/123',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата', {
      textFormat: 'markdown',
    });

    expect(result).toEqual({
      messageId: 'mid-rules-1',
      url: 'https://max.ru/chats/chat-1/message/123',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: { text: 'Правила чата', format: 'markdown' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-rules-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses link returned directly by MAX send response when available', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            message_id: 'mid-rules-2',
            url: 'https://max.ru/chats/chat-1/message/456',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила');

    expect(result).toEqual({
      messageId: 'mid-rules-2',
      url: 'https://max.ru/chats/chat-1/message/456',
    });
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('runs an immediate send fence before the MAX POST', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn().mockImplementationOnce(() => {
        order.push('post');
        return of({
          status: 200,
          data: {
            message_id: 'mid-fenced-reply',
            url: 'https://max.ru/chats/chat-1/message/fenced-reply',
          },
        });
      }),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithResolvedLink('chat-1', 'Reply', {
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['fence', 'post']);
    await service.onModuleDestroy();
  });

  it('uses nullable text for an immediate attachment-only reply', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn().mockImplementationOnce(() => {
        order.push('post');
        return of({
          status: 200,
          data: {
            message_id: 'mid-comments-reply',
            url: 'https://max.ru/chats/chat-1/message/comments-reply',
          },
        });
      }),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithResolvedLink('chat-1', '', {
      buttons: [
        [
          {
            type: 'link',
            text: 'Комментарии',
            url: 'https://major-maksimov.ru/app/',
          },
        ],
      ],
      messageLink: {
        type: 'reply',
        mid: 'mid-source',
      },
      textFormat: 'markdown',
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['fence', 'post']);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: null,
          link: {
            type: 'reply',
            mid: 'mid-source',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves invisible non-empty text for an immediate keyboard reply', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            message_id: 'mid-comments-reply',
            url: 'https://max.ru/chats/chat-1/message/comments-reply',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithResolvedLink('chat-1', '\u200B', {
      buttons: [
        [
          {
            type: 'link',
            text: 'Комментарии',
            url: 'https://major-maksimov.ru/app/',
          },
        ],
      ],
      messageLink: {
        type: 'reply',
        mid: 'mid-source',
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: '\u200B',
          link: {
            type: 'reply',
            mid: 'mid-source',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not POST an immediate send when its fence cannot be persisted', async () => {
    const fenceError = new Error('reply marker unavailable');
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    const error = await service
      .sendMessageImmediateWithResolvedLink('chat-1', 'Reply', {
        beforeSend: async () => {
          throw fenceError;
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(fenceError);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(wasMaxMessageSendAttempted(error)).toBe(false);
    await service.onModuleDestroy();
  });

  it('passes request options to follow-up link resolution after send', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-bot-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const resolveSpy = jest
      .spyOn(service as any, 'resolveMessageLink')
      .mockResolvedValue('https://max.ru/chats/chat-1/message/999');

    const result = await service.sendMessageImmediateWithResolvedLink(
      'chat-1',
      'Правила чата',
      undefined,
      {
        botId: '777000_bot',
        trafficClass: 'critical',
      },
    );

    expect(result).toEqual({
      messageId: 'mid-rules-bot-1',
      url: 'https://max.ru/chats/chat-1/message/999',
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      'mid-rules-bot-1',
      expect.objectContaining({
        botId: '777000_bot',
        trafficClass: 'critical',
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate chat message sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-chat-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithId('chat-1', 'Сообщение', undefined, {
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate private message sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-private-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateToUser('user-1', 'Сообщение', undefined, {
      timeoutMs: 2_345,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 2_345,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate custom message sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-custom-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendCustomMessageImmediate(
      'chat-1',
      {
        text: 'Сообщение',
      },
      {
        timeoutMs: 3_456,
      },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 3_456,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate reply-with-keyboard sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-reply-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageReplyWithInlineKeyboard(
      'chat-1',
      'mid-source-1',
      'Ответ',
      {
        button: {
          text: 'Открыть',
          url: 'https://max.ru/777000_bot?start=test',
        },
      },
      {
        timeoutMs: 4_567,
      },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 4_567,
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps successful send result when follow-up link resolution fails', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-send-ok-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const resolveSpy = jest
      .spyOn(service as any, 'resolveMessageLink')
      .mockRejectedValue(new Error('resolve failed'));
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-send-ok-1',
      url: null,
    });
    expect(resolveSpy).toHaveBeenCalledWith('mid-rules-send-ok-1', {});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mid-rules-send-ok-1',
        err: 'resolve failed',
      }),
      'Failed to resolve MAX message link after successful send',
    );

    await service.onModuleDestroy();
  });

  it('does not count ignored terminal send failures in action health metrics', async () => {
    const error = {
      response: {
        status: 404,
        data: {
          code: 'chat.not.found',
          message: 'Chat not found',
        },
      },
    };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(throwError(() => error)),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccess: jest.Mock;
          recordFailure: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.sendMessageImmediateWithId('chat-1', 'Правила', undefined, {
        ignoreFailureMetricStatuses: [404],
      }),
    ).rejects.toBe(error);

    expect(actionHealthService.recordFailure).not.toHaveBeenCalled();
    expect(actionHealthService.recordSuccess).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('refuses direct send mutations with explicit non-executable or unknown bot ids', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'draining-bot') {
        return {
          ...defaultBot,
          id: 'draining-bot',
          token: 'draining-token',
          state: 'draining',
        };
      }
      return null;
    });

    await expect(
      service.sendMessageImmediateWithId('chat-1', 'hello', undefined, {
        botId: 'draining-bot',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      service.sendMessageImmediateWithId('chat-1', 'hello', undefined, {
        botId: 'removed-bot',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('publishes custom attachment-only message and resolves post link', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-custom-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-custom-1' },
                  message_url: 'https://max.ru/chats/chat-1/message/custom-1',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendCustomMessageImmediateWithResolvedLink('chat-1', {
      attachments: [
        {
          type: 'image',
          payload: { token: 'upload-token-1' },
        },
      ],
    });

    expect(result).toEqual({
      messageId: 'mid-custom-1',
      url: 'https://max.ru/chats/chat-1/message/custom-1',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: null,
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-1' },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('normalizes raw custom inline keyboard attachments before sending', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-custom-buttons-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendCustomMessageImmediate('chat-1', {
      text: 'Проверьте кнопки',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: '',
                  text: 'Связь с администратором',
                  url: 'https://example.com/admin',
                },
                {
                  type: 'link',
                  text: 'Проверить обязательную подписку',
                  url: 'https://example.com/subscription',
                },
              ],
            ],
          },
        },
      ],
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Проверьте кнопки',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Связь с администратором',
                      url: 'https://example.com/admin',
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Проверить обязательную подписку',
                      url: 'https://example.com/subscription',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not fail when MAX omits a direct message url for chat posts', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-3',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-3' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-3',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-3',
      url: null,
    });

    await service.onModuleDestroy();
  });

  it('recovers direct post link via GET /messages/{id} when batch lookup has no url', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-4' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4',
              url: 'https://max.ru/chats/chat-1/message/789',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-4',
      url: 'https://max.ru/chats/chat-1/message/789',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-rules-4',
      }),
    );

    await service.onModuleDestroy();
  });

  it('recovers the correct post link when batch lookup returns a different message id', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4b',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-other-4b' },
                  url: 'https://max.ru/chats/chat-1/message/wrong',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4b',
              url: 'https://max.ru/chats/chat-1/message/correct',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-4b',
      url: 'https://max.ru/chats/chat-1/message/correct',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-rules-4b',
      }),
    );

    await service.onModuleDestroy();
  });

  it('builds chat post link from message id tail when MAX omits direct url fields', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-5',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  recipient: {
                    chat_id: -71768670111751,
                    chat_type: 'chat',
                  },
                  body: {
                    mid: 'mid-rules-5',
                    seq: '116200222364336232',
                  },
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-5',
      url: 'https://max.ru/c/-71768670111751/AZzTfJDZAGg',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-rules-5' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends reply link payload when message link is provided', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-link-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      'Нарушение',
      {
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'mid-rules-1',
        },
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Нарушение',
          format: 'markdown',
          link: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps multipart video upload available through the rollback flag', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-1',
              token: 'video-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {},
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: false,
    });

    const result = await service.uploadVideo(
      TINY_VALID_MP4,
      'channel-suggestion-video.mp4',
      'video/mp4',
    );

    expect(result).toEqual({ token: 'video-upload-token-1' });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/uploads',
        params: {
          type: 'video',
        },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/video-1',
      }),
    );

    await service.onModuleDestroy();
  });

  it.each([
    ['a plain retval', 'retval'],
    ['an empty response', null],
  ])('uses the video upload-session token when binary upload returns %s', async (_label, data) => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-session-token',
              token: 'video-session-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: false,
    });

    await expect(
      service.uploadVideo(TINY_VALID_MP4, 'publication.mp4', 'video/mp4'),
    ).resolves.toEqual({ token: 'video-session-token' });

    await service.onModuleDestroy();
  });

  it('uploads video in bounded Content-Range chunks by default', async () => {
    const chunkBytes = 4 * 1_024 * 1_024;
    const video = createMp4Fixture(chunkBytes + 3, 7);
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-range-1?signature=secret',
              token: 'video-range-token-1',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: '' }))
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService);

    const result = await service.uploadVideo(video, '../range-video.mp4', 'video/mp4', {
      timeoutMs: 12_345,
    });

    expect(result).toEqual({ token: 'video-range-token-1' });
    expect(httpService.request).toHaveBeenCalledTimes(3);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/video-range-1?signature=secret',
        data: expect.any(Buffer),
        headers: expect.objectContaining({
          'Content-Disposition': 'attachment; filename="range-video.mp4"',
          'Content-Length': String(chunkBytes),
          'Content-Range': `bytes 0-${chunkBytes - 1}/${video.length}`,
          'Content-Type': 'application/x-binary; charset=x-user-defined',
          'X-File-Name': 'range-video.mp4',
          'X-Uploading-Mode': 'parallel',
          Connection: 'keep-alive',
        }),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: expect.any(Number),
      }),
    );
    expect(httpService.request.mock.calls[1]?.[0].headers).not.toHaveProperty('Authorization');
    expect((httpService.request.mock.calls[1]?.[0].data as Buffer).length).toBe(chunkBytes);
    expect(httpService.request.mock.calls[1]?.[0].timeout).toBeGreaterThan(0);
    expect(httpService.request.mock.calls[1]?.[0].timeout).toBeLessThanOrEqual(12_345);
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: 'https://upload.max.ru/video-range-1?signature=secret',
        data: expect.any(Buffer),
        headers: expect.objectContaining({
          'Content-Length': '3',
          'Content-Range': `bytes ${chunkBytes}-${chunkBytes + 2}/${video.length}`,
        }),
      }),
    );
    expect((httpService.request.mock.calls[2]?.[0].data as Buffer).length).toBe(3);
    expect(httpService.request.mock.calls[2]?.[0].timeout).toBeGreaterThan(0);
    expect(httpService.request.mock.calls[2]?.[0].timeout).toBeLessThanOrEqual(
      httpService.request.mock.calls[1]?.[0].timeout,
    );

    await service.onModuleDestroy();
  });

  it('rejects empty and oversized videos before creating an upload session', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(service.uploadVideo(Buffer.alloc(0), 'empty.mp4', 'video/mp4')).rejects.toThrow(
      'MAX video upload payload is empty',
    );
    await expect(
      service.uploadVideo(
        { length: MAX_VIDEO_UPLOAD_MAX_BYTES + 1 } as Buffer,
        'oversized.mp4',
        'video/mp4',
      ),
    ).rejects.toThrow('MAX video upload exceeds the documented 250 MB limit');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects empty and oversized image or file payloads before creating an upload session', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(service.uploadImage(Buffer.alloc(0), 'empty.jpg', 'image/jpeg')).rejects.toThrow(
      'MAX image upload payload is empty',
    );
    await expect(
      service.uploadImage(
        { length: MAX_IMAGE_UPLOAD_MAX_BYTES + 1 } as Buffer,
        'oversized.jpg',
        'image/jpeg',
      ),
    ).rejects.toThrow('MAX image upload exceeds the documented 50 MB limit');
    await expect(service.uploadFile(Buffer.alloc(0), 'empty.txt', 'text/plain')).rejects.toThrow(
      'MAX file upload payload is empty',
    );
    await expect(
      service.uploadFile(
        { length: MAX_FILE_UPLOAD_MAX_BYTES + 1 } as Buffer,
        'oversized.bin',
        'application/octet-stream',
      ),
    ).rejects.toThrow('MAX file upload exceeds the documented 4 GB limit');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects invalid media bytes before bot resolution or upload HTTP', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    const resolveExecutableBot = jest.spyOn(service as any, 'resolveExecutableBot');

    let error: unknown;
    try {
      await service.uploadImage(Buffer.from('not-an-image'), 'spoofed.jpg', 'image/jpeg', {
        botId: 'unknown-bot',
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MaxMediaUploadValidationError);
    expect(error).toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      retryable: false,
    });
    expect(resolveExecutableBot).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('canonicalizes image MIME and filename from the uploaded bytes', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/image-canonical',
              token: 'image-canonical-session-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: { token: 'image-canonical-token' } })),
    };
    const service = createService(httpService);

    await expect(service.uploadImage(TINY_JPEG, '../spoofed.png', 'image/png')).resolves.toEqual({
      token: 'image-canonical-token',
    });

    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { getBuffer?: () => Buffer };
    };
    const multipartBody = uploadRequest.data?.getBuffer?.().toString('latin1') ?? '';
    expect(multipartBody).toContain('filename="spoofed.jpg"');
    expect(multipartBody).toContain('Content-Type: image/jpeg');
    expect(multipartBody).not.toContain('filename="spoofed.png"');

    await service.onModuleDestroy();
  });

  it('uses one decreasing timeout budget across upload sessions and range chunks', async () => {
    const chunkBytes = 4 * 1_024 * 1_024;
    const video = createMp4Fixture(chunkBytes + 1, 7);
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const httpService = {
      request: jest.fn().mockImplementation((request: { url?: string }) => {
        if (request.url === 'https://platform-api2.max.ru/uploads') {
          now += 100;
          return of({
            data: {
              url: 'https://upload.max.ru/video-deadline',
              token: 'video-deadline-token',
            },
          });
        }
        now += 2_500;
        return of({ data: '' });
      }),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    try {
      await expect(
        service.uploadVideo(video, 'deadline.mp4', 'video/mp4', { timeoutMs: 10_000 }),
      ).resolves.toEqual({ token: 'video-deadline-token' });

      expect(httpService.request.mock.calls.map(([request]) => request.timeout)).toEqual([
        10_000, 9_900, 7_400,
      ]);
    } finally {
      nowSpy.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('recomputes the upload-session request timeout after internal rate-limit waiting', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-rate-limit-budget',
              token: 'video-rate-limit-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });
    jest.spyOn(service as any, 'reserveRateLimitSlot').mockImplementation(async () => {
      now += 4_000;
    });

    try {
      await expect(
        service.uploadVideo(TINY_VALID_MP4, 'rate-limit.mp4', 'video/mp4', {
          timeoutMs: 10_000,
        }),
      ).resolves.toEqual({ token: 'video-rate-limit-token' });

      expect(httpService.request.mock.calls[0]?.[0].timeout).toBe(6_000);
      expect(httpService.request.mock.calls[1]?.[0].timeout).toBe(6_000);
    } finally {
      nowSpy.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('does not start a fresh upload session after the overall deadline expires', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const httpService = {
      request: jest
        .fn()
        .mockImplementationOnce(() => {
          now += 100;
          return of({
            data: {
              url: 'https://upload.max.ru/video-expired',
              token: 'video-expired-token',
            },
          });
        })
        .mockImplementationOnce(() => {
          now = 11_001;
          return throwError(() =>
            Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
          );
        }),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    try {
      await expect(
        service.uploadVideo(TINY_VALID_MP4, 'expired.mp4', 'video/mp4', {
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ name: 'MaxMediaUploadError' });
      expect(httpService.request).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('uses an ASCII-safe filename in resumable video headers', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-unicode',
              token: 'video-unicode-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    await service.uploadVideo(TINY_VALID_MP4, 'видео.mp4', 'video/mp4');

    expect(httpService.request.mock.calls[1]?.[0].headers).toEqual(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="upload.mp4"',
        'X-File-Name': 'upload.mp4',
      }),
    );
    await service.onModuleDestroy();
  });

  it('uses multipart fallback when a resumable video session has no token', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-multipart-fallback',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              token: 'video-multipart-token-1',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    const result = await service.uploadVideo(TINY_VALID_MP4, 'видео.mp4', 'video/mp4');

    expect(result).toEqual({ token: 'video-multipart-token-1' });
    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { getBuffer?: () => Buffer };
      headers?: Record<string, unknown>;
    };
    expect(uploadRequest.data?.getBuffer).toEqual(expect.any(Function));
    expect(uploadRequest.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/u);
    expect(uploadRequest.headers).not.toHaveProperty('Content-Range');
    expect(uploadRequest.data?.getBuffer?.().toString('utf8')).toContain('filename="видео.mp4"');

    await service.onModuleDestroy();
  });

  it('starts a fresh resumable video session after an ambiguous chunk failure', async () => {
    const firstUploadUrl = 'https://upload.max.ru/video-range-first?signature=do-not-log';
    const secondUploadUrl = 'https://upload.max.ru/video-range-second?signature=do-not-log-either';
    const ambiguousError = Object.assign(new Error(`socket hang up for ${firstUploadUrl}`), {
      code: 'ECONNRESET',
    });
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({ data: { url: firstUploadUrl, token: 'video-range-token-first' } }),
        )
        .mockReturnValueOnce(throwError(() => ambiguousError))
        .mockReturnValueOnce(
          of({ data: { url: secondUploadUrl, token: 'video-range-token-second' } }),
        )
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    const result = await service.uploadVideo(TINY_VALID_MP4, 'retry-video.mp4', 'video/mp4');

    expect(result).toEqual({ token: 'video-range-token-second' });
    expect(httpService.request).toHaveBeenCalledTimes(4);
    expect(httpService.request.mock.calls[1]?.[0].url).toBe(firstUploadUrl);
    expect(httpService.request.mock.calls[3]?.[0].url).toBe(secondUploadUrl);

    await service.onModuleDestroy();
  });

  it('redacts resumable video upload URLs from terminal transport errors', async () => {
    const firstUploadUrl = 'https://upload.max.ru/video-range-first?signature=first-secret';
    const secondUploadUrl = 'https://upload.max.ru/video-range-second?signature=second-secret';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({ data: { url: firstUploadUrl, token: 'video-range-token-first' } }),
        )
        .mockReturnValueOnce(
          throwError(() =>
            Object.assign(new Error(`timeout while posting ${firstUploadUrl}`), {
              code: 'ETIMEDOUT',
            }),
          ),
        )
        .mockReturnValueOnce(
          of({ data: { url: secondUploadUrl, token: 'video-range-token-second' } }),
        )
        .mockReturnValueOnce(
          throwError(() =>
            Object.assign(new Error(`timeout while posting ${secondUploadUrl}`), {
              code: 'ETIMEDOUT',
            }),
          ),
        ),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    let uploadError: unknown;
    try {
      await service.uploadVideo(TINY_VALID_MP4, 'failed-video.mp4', 'video/mp4');
    } catch (error: unknown) {
      uploadError = error;
    }

    expect(uploadError).toBeInstanceOf(Error);
    expect((uploadError as Error).name).toBe('MaxMediaUploadError');
    expect((uploadError as Error).message).toContain('ambiguous transport timeout');
    expect((uploadError as Error).message).not.toContain(firstUploadUrl);
    expect((uploadError as Error).message).not.toContain(secondUploadUrl);

    await service.onModuleDestroy();
  });

  it('sanitizes multipart upload filenames before passing them to form-data', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/image-1',
              token: 'image-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              token: 'image-binary-token-1',
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.uploadImage(
      TINY_JPEG,
      '../evil\r\nContent-Disposition: form-data; name="x".jpg',
      'image/jpeg',
    );

    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { getBuffer?: () => Buffer };
    };
    const multipartBody = uploadRequest.data?.getBuffer?.().toString('utf8') ?? '';

    expect(multipartBody).toContain('filename="evil_Content-Disposition_ form-data_ name_x_.jpg"');
    expect(multipartBody).not.toContain('filename="../evil');
    expect(multipartBody).not.toContain('\r\nContent-Disposition: form-data; name="x"');

    await service.onModuleDestroy();
  });

  it('keeps bot auth on /uploads but omits it from the returned multipart upload URL', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/image-1',
              token: 'image-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              token: 'image-binary-token-1',
            },
          }),
        ),
    };
    const service = createService(httpService);
    const defaultBot = (service as any).botRegistry.getDefaultBot();
    (service as any).botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (botId === '888000_bot') {
        return {
          ...defaultBot,
          id: '888000_bot',
          token: 'selected-bot-token',
          webhookSecretPath: 'selected-secret-path',
        };
      }
      return !botId || botId === defaultBot.id ? defaultBot : null;
    });

    const result = await service.uploadImage(TINY_JPEG, 'private-control-image.jpg', 'image/jpeg', {
      botId: '888000_bot',
    });

    expect(result).toEqual({ token: 'image-binary-token-1' });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/uploads',
        headers: expect.objectContaining({
          Authorization: 'selected-bot-token',
        }),
      }),
    );
    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
    };
    expect(uploadRequest).toEqual(
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/image-1',
      }),
    );
    expect(uploadRequest.headers).not.toHaveProperty('Authorization');

    await service.onModuleDestroy();
  });

  it('sends generic media attachments together with inline keyboard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-video-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      'Видео предложки',
      {
        textFormat: 'markdown',
        attachments: [{ type: 'video', payload: { token: 'video-upload-token-1' } }],
        buttons: [[{ type: 'callback', text: '✅ Подтвердить', payload: 'review|publish' }]],
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Видео предложки',
          format: 'markdown',
          attachments: [
            {
              type: 'video',
              payload: { token: 'video-upload-token-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'callback', text: '✅ Подтвердить', payload: 'review|publish' }],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('pins a message in chat without system notify when requested', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.pinMessage('chat-1', 'mid-rules-3', false);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/chats/chat-1/pin',
        data: {
          message_id: 'mid-rules-3',
          notify: false,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends MAX message history boundaries as Unix milliseconds', async () => {
    const from = new Date('2026-03-06T00:00:00.123Z');
    const to = '2026-03-07T12:00:00.456Z';
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.listMessages('chat-1', {
      count: 1,
      from,
      to,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          count: 1,
          from: from.getTime(),
          to: Date.parse(to),
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('parses official message snapshots, preserves missing views, and deduplicates pages', async () => {
    const latestTs = Date.parse('2026-03-07T09:00:00.000Z');
    const previousTs = Date.parse('2026-03-06T09:00:00.000Z');
    const rangeFromTs = Date.parse('2026-03-06T00:00:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T12:00:00.000Z');
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  timestamp: latestTs,
                  body: {
                    mid: 'mid-2',
                    attachments: [
                      {
                        type: 'image',
                        payload: {
                          photos: {
                            128: 'https://cdn.max.ru/news/post-2-small.jpg',
                            1024: 'https://cdn.max.ru/news/post-2.jpg',
                          },
                        },
                      },
                    ],
                  },
                  stat: {
                    views: 260,
                    reactions: [
                      { emoji: '🔥', count: 5 },
                      { emoji: '❤️', count: 3 },
                    ],
                  },
                  url: 'https://max.ru/news/post-2',
                },
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  stat: { reactions: { count: 12 } },
                  url: 'https://max.ru/news/post-1',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  url: 'https://max.ru/news/post-1',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) =>
      botId === 'stats-bot'
        ? { ...defaultBot, id: 'stats-bot', token: 'stats-token' }
        : !botId || botId === defaultBot.id
          ? defaultBot
          : null,
    );

    const result = await service.listMessageSnapshots('channel-1', {
      from: '2026-03-06T00:00:00.000Z',
      to: '2026-03-07T12:00:00.000Z',
      count: 2,
      maxPages: 3,
      botId: 'stats-bot',
    });

    expect(result).toEqual([
      {
        chatId: 'channel-1',
        messageId: 'mid-2',
        publishedAt: '2026-03-07T09:00:00.000Z',
        publishedAtMs: latestTs,
        url: 'https://max.ru/news/post-2',
        previewUrl: 'https://cdn.max.ru/news/post-2.jpg',
        views: 260,
        reactionsTotal: 8,
        reactions: [
          { emoji: '🔥', count: 5 },
          { emoji: '❤️', count: 3 },
        ],
      },
      {
        chatId: 'channel-1',
        messageId: 'mid-1',
        publishedAt: '2026-03-06T09:00:00.000Z',
        publishedAtMs: previousTs,
        url: 'https://max.ru/news/post-1',
        previewUrl: null,
        views: null,
        reactionsTotal: 12,
        reactions: [],
      },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'channel-1',
          count: 2,
          from: rangeToTs,
          to: rangeFromTs,
        },
        headers: { Authorization: 'stats-token' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'channel-1',
          count: 2,
          from: previousTs - 1,
          to: rangeFromTs,
        },
        headers: { Authorization: 'stats-token' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps millisecond-adjacent messages in the same second across snapshot pages', async () => {
    const newestTimestamp = Date.parse('2026-03-07T09:00:00.901Z');
    const pageBoundaryTimestamp = newestTimestamp - 1;
    const nextTimestamp = pageBoundaryTimestamp - 1;
    const rangeFromTs = Date.parse('2026-03-07T08:59:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T09:01:00.000Z');
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                { timestamp: newestTimestamp, body: { mid: 'mid-ms-newest' } },
                { timestamp: pageBoundaryTimestamp, body: { mid: 'mid-ms-boundary' } },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [{ timestamp: nextTimestamp, body: { mid: 'mid-ms-older' } }],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.listMessageSnapshots('channel-1', {
      from: rangeFromTs,
      to: rangeToTs,
      count: 2,
      maxPages: 2,
    });

    expect(result.map((item) => item.messageId)).toEqual([
      'mid-ms-newest',
      'mid-ms-boundary',
      'mid-ms-older',
    ]);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          chat_id: 'channel-1',
          count: 2,
          from: nextTimestamp,
          to: rangeFromTs,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('continues snapshot pagination when a full page ends with a timestamp tie', async () => {
    const newestTimestamp = Date.parse('2026-03-07T09:00:01.000Z');
    const tiedTimestamp = Date.parse('2026-03-07T09:00:00.900Z');
    const olderTimestamp = tiedTimestamp - 1;
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                { timestamp: newestTimestamp, body: { mid: 'mid-tie-newest' } },
                { timestamp: tiedTimestamp, body: { mid: 'mid-tie-a' } },
                { timestamp: tiedTimestamp, body: { mid: 'mid-tie-b' } },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [{ timestamp: olderTimestamp, body: { mid: 'mid-tie-older' } }],
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.listMessageSnapshots('channel-1', {
        from: tiedTimestamp - 60_000,
        to: newestTimestamp + 60_000,
        count: 3,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'mid-tie-newest' }),
        expect.objectContaining({ messageId: 'mid-tie-a' }),
        expect.objectContaining({ messageId: 'mid-tie-b' }),
        expect.objectContaining({ messageId: 'mid-tie-older' }),
      ]),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: expect.objectContaining({ from: tiedTimestamp - 1 }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps messages published exactly on both snapshot range boundaries', async () => {
    const rangeFromTs = Date.parse('2026-03-06T09:00:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T12:00:00.000Z');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                timestamp: rangeToTs,
                body: { mid: 'mid-upper-boundary' },
                stat: { views: 200 },
              },
              {
                timestamp: rangeFromTs,
                body: { mid: 'mid-lower-boundary' },
                stat: { views: 100 },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.listMessageSnapshots('channel-1', {
      from: rangeFromTs,
      to: rangeToTs,
      count: 100,
      maxPages: 1,
    });

    expect(result.map((snapshot) => snapshot.messageId)).toEqual([
      'mid-upper-boundary',
      'mid-lower-boundary',
    ]);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          chat_id: 'channel-1',
          count: 100,
          from: rangeToTs,
          to: rangeFromTs,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('loads a single official message snapshot with a MAX image payload URL', async () => {
    const publishedAtMs = Date.parse('2026-06-08T17:56:14.328Z');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                timestamp: publishedAtMs,
                body: {
                  mid: 'mid.ffffbb80bddbf2f4019ea860c3782a5a',
                  attachments: [
                    {
                      payload: {
                        photo_id: 24149085858,
                        token: 'photo-token',
                        url: 'https://i.oneme.ru/i?r=BTGBPUwtwgYUeoFhO7rESmr8VstQjUx',
                      },
                      type: 'image',
                    },
                  ],
                },
                stat: {
                  views: 5926,
                },
                url: 'https://max.ru/id613002203036_biz/AZ7gWKGdJ-o',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageSnapshot(
      '-75313361194252',
      'mid.ffffbb80bddbf2f4019ea860c3782a5a',
      {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
        botId: '777000_bot',
      },
    );

    expect(result).toEqual({
      chatId: '-75313361194252',
      messageId: 'mid.ffffbb80bddbf2f4019ea860c3782a5a',
      publishedAt: '2026-06-08T17:56:14.328Z',
      publishedAtMs,
      url: 'https://max.ru/id613002203036_biz/AZ7gWKGdJ-o',
      previewUrl: 'https://i.oneme.ru/i?r=BTGBPUwtwgYUeoFhO7rESmr8VstQjUx',
      views: 5926,
      reactionsTotal: null,
      reactions: [],
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_ids: 'mid.ffffbb80bddbf2f4019ea860c3782a5a',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns an exact raw message only when MAX identifies the requested chat', async () => {
    const rawMessage = {
      body: {
        mid: 'mid-exact-link-1',
        text: 'masked label',
        markup: [{ type: 'link', from: 0, length: 12, url: 'https://example.com/path' }],
      },
      recipient: { chat_id: 'chat-1' },
    };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ data: { messages: [rawMessage] } })),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessageRow('chat-1', 'mid-exact-link-1', {
        trafficClass: 'critical',
        botId: '777000_bot',
      }),
    ).resolves.toBe(rawMessage);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-exact-link-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps exact raw-message absence and chat mismatch fail-closed', async () => {
    const mismatchService = createService({
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-exact-mismatch' },
                recipient: { chat_id: 'chat-2' },
              },
            ],
          },
        }),
      ),
    });
    await expect(
      mismatchService.getExactMessageRow('chat-1', 'mid-exact-mismatch'),
    ).rejects.toThrow('for chat chat-2 instead of chat-1');
    await mismatchService.onModuleDestroy();

    const exactNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const absentService = createService({
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => exactNotFound)),
    });
    await expect(
      absentService.getExactMessageRow('chat-1', 'mid-exact-absent'),
    ).resolves.toBeNull();
    await absentService.onModuleDestroy();
  });

  it('loads internal channel dialog identities by exact message id for background repair', async () => {
    const threadId = '12345678-1234-4123-8123-123456789abc';
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const startParam = `cd-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'comments',
        t: token,
      }),
      'utf8',
    ).toString('base64url')}`;
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-dialog-buttons-1',
                  attachments: [
                    {
                      type: 'inline_keyboard',
                      payload: {
                        buttons: [
                          [
                            {
                              type: 'link',
                              text: 'Комментарии',
                              url: `https://max.ru/bot-1?startapp=${startParam}`,
                            },
                          ],
                          [
                            {
                              type: 'link',
                              text: 'Предложить',
                              url: `https://max.ru/bot-1?start=cds-channel-1.${threadId.replaceAll(
                                '-',
                                '',
                              )}.${'a'.repeat(24)}`,
                            },
                          ],
                          [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactChannelDialogButtonIdentities('channel-1', 'mid-dialog-buttons-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        botId: '777000_bot',
      }),
    ).resolves.toEqual([
      { chatId: 'channel-1', kind: 'comments', threadId },
      { chatId: 'channel-1', kind: 'suggest', threadId },
    ]);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-dialog-buttons-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('distinguishes an existing message without owned buttons from confirmed absence', async () => {
    const presentHttpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-without-dialog-buttons',
                  attachments: [
                    {
                      type: 'inline_keyboard',
                      payload: {
                        buttons: [[{ type: 'link', text: 'Сайт', url: 'https://example.com/' }]],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const presentService = createService(presentHttpService);
    await expect(
      presentService.getExactChannelDialogButtonIdentities(
        'channel-1',
        'mid-without-dialog-buttons',
      ),
    ).resolves.toEqual([]);
    await presentService.onModuleDestroy();

    const notFoundError = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const absentHttpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => notFoundError)),
    };
    const absentService = createService(absentHttpService);
    await expect(
      absentService.getExactChannelDialogButtonIdentities('channel-1', 'mid-absent-dialog'),
    ).resolves.toBeNull();
    expect(absentHttpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-absent-dialog',
      }),
    );
    await absentService.onModuleDestroy();
  });

  it('reports an exact raw message as present even when snapshot fields are malformed', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-malformed-snapshot' },
                timestamp: 'not-a-timestamp',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-malformed-snapshot', {
        botId: '777000_bot',
      }),
    ).resolves.toBe('present');
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps a list result inconclusive when the message belongs to another chat', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-shared' },
                recipient: { chat_id: 'chat-1' },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const results = await service.getExactMessagePresences(
      [
        { chatId: 'chat-1', messageId: 'mid-shared' },
        { chatId: 'chat-2', messageId: 'mid-shared' },
      ],
      { botId: '777000_bot' },
    );

    expect(results[0]).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-shared',
      presence: 'present',
    });
    expect(results[1]).toEqual(
      expect.objectContaining({
        chatId: 'chat-2',
        messageId: 'mid-shared',
        error: expect.any(Error),
      }),
    );
    expect((results[1] as { error: Error }).error.message).toContain(
      'for chat chat-1 instead of chat-2',
    );
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('matches duplicate message ids to their exact chats regardless of response order', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-shared' },
                recipient: { chat_id: 'chat-2' },
              },
              {
                body: { mid: 'mid-shared' },
                recipient: { chat_id: 'chat-1' },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresences(
        [
          { chatId: 'chat-1', messageId: 'mid-shared' },
          { chatId: 'chat-2', messageId: 'mid-shared' },
        ],
        { botId: '777000_bot' },
      ),
    ).resolves.toEqual([
      { chatId: 'chat-1', messageId: 'mid-shared', presence: 'present' },
      { chatId: 'chat-2', messageId: 'mid-shared', presence: 'present' },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps an unscoped duplicate message id inconclusive for multiple target chats', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [{ body: { mid: 'mid-shared' } }],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const results = await service.getExactMessagePresences(
      [
        { chatId: 'chat-1', messageId: 'mid-shared' },
        { chatId: 'chat-2', messageId: 'mid-shared' },
      ],
      { botId: '777000_bot' },
    );

    expect(results).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'mid-shared',
        error: expect.any(Error),
      }),
      expect.objectContaining({
        chatId: 'chat-2',
        messageId: 'mid-shared',
        error: expect.any(Error),
      }),
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps a direct result inconclusive when the message belongs to another chat', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(
          of({
            data: {
              message: {
                body: { mid: 'mid-wrong-chat' },
                recipient: { chat_id: 'chat-2' },
              },
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-wrong-chat', {
        botId: '777000_bot',
      }),
    ).rejects.toThrow('for chat chat-2 instead of chat-1');
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('reports absence only for an exact message-not-found response', async () => {
    const exactNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => exactNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-absent', { botId: '777000_bot' }),
    ).resolves.toBe('absent');
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-absent',
      }),
    );

    await service.onModuleDestroy();
  });

  it('reports absence for a direct not-found response that names the exact requested message', async () => {
    const exactNotFound = {
      response: {
        status: 404,
        data: {
          code: 'not.found',
          message: 'Message mid-live-absent was not found',
        },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => exactNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-live-absent', {
        botId: '777000_bot',
      }),
    ).resolves.toBe('absent');

    await service.onModuleDestroy();
  });

  it('does not infer exact absence from a generic direct not-found response', async () => {
    const genericNotFound = {
      response: {
        status: 404,
        data: { code: 'not.found', message: 'Requested resource was not found' },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => genericNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).rejects.toBe(genericNotFound);

    await service.onModuleDestroy();
  });

  it('does not infer exact absence when a direct not-found response names another message', async () => {
    const anotherMessageNotFound = {
      response: {
        status: 404,
        data: {
          code: 'not.found',
          message: 'Message mid-requested-other was not found',
        },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => anotherMessageNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-requested', { botId: '777000_bot' }),
    ).rejects.toBe(anotherMessageNotFound);

    await service.onModuleDestroy();
  });

  it('falls back to direct lookup when the message list returns a bare 404', async () => {
    const bareNotFound = { response: { status: 404, data: {} } };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(throwError(() => bareNotFound))
        .mockReturnValueOnce(of({ data: { message: { body: { mid: 'mid-unknown' } } } })),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).resolves.toBe('present');
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-unknown',
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not treat a bare direct-message 404 as exact absence', async () => {
    const listNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const directBareNotFound = { response: { status: 404, data: {} } };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(throwError(() => listNotFound))
        .mockReturnValueOnce(throwError(() => directBareNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).rejects.toBe(directBareNotFound);

    await service.onModuleDestroy();
  });

  it('does not infer exact absence from direct-message error text without the documented code', async () => {
    const messageOnlyNotFound = {
      response: { status: 404, data: { message: 'Message not found' } },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => messageOnlyNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).rejects.toBe(messageOnlyNotFound);

    await service.onModuleDestroy();
  });

  it('checks multiple exact messages with one list request and direct fallback for missing ids', async () => {
    const directNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [{ body: { mid: 'mid-present' } }] } }))
        .mockReturnValueOnce(throwError(() => directNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresences(
        [
          { chatId: 'chat-1', messageId: 'mid-present' },
          { chatId: 'chat-2', messageId: 'mid-absent' },
        ],
        { botId: '777000_bot' },
      ),
    ).resolves.toEqual([
      { chatId: 'chat-1', messageId: 'mid-present', presence: 'present' },
      { chatId: 'chat-2', messageId: 'mid-absent', presence: 'absent' },
    ]);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-present,mid-absent' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-absent',
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps a message-list transport failure ambiguous without direct absence inference', async () => {
    const transportFailure = { response: { status: 503, data: {} } };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(throwError(() => transportFailure)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresences(
        [
          { chatId: 'chat-1', messageId: 'mid-1' },
          { chatId: 'chat-2', messageId: 'mid-2' },
        ],
        { botId: '777000_bot' },
      ),
    ).resolves.toEqual([
      { chatId: 'chat-1', messageId: 'mid-1', error: transportFailure },
      { chatId: 'chat-2', messageId: 'mid-2', error: transportFailure },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps a per-message unknown result when a batch direct fallback is inconclusive', async () => {
    const directBareNotFound = { response: { status: 404, data: {} } };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [{ body: { mid: 'mid-present' } }] } }))
        .mockReturnValueOnce(throwError(() => directBareNotFound)),
    };
    const service = createService(httpService);

    const results = await service.getExactMessagePresences(
      [
        { chatId: 'chat-1', messageId: 'mid-present' },
        { chatId: 'chat-2', messageId: 'mid-unknown' },
      ],
      { botId: '777000_bot' },
    );

    expect(results).toEqual([
      { chatId: 'chat-1', messageId: 'mid-present', presence: 'present' },
      { chatId: 'chat-2', messageId: 'mid-unknown', error: directBareNotFound },
    ]);

    await service.onModuleDestroy();
  });

  it('returns current bot member access with granular permissions', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: 'bot-1',
            role: 'admin',
            is_admin: true,
            permissions: ['add_remove_members', 'change_chat_info'],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getCurrentChatMemberAccess('chat-1');

    expect(result).toEqual({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['add_remove_members', 'change_chat_info'],
      permissionsKnown: true,
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members/me',
      }),
    );

    await service.onModuleDestroy();
  });

  it('distinguishes an explicitly empty permission list from a nullable one', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              user_id: 'bot-1',
              is_admin: true,
              permissions: [],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              user_id: 'bot-1',
              is_admin: true,
              permissions: null,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(service.getCurrentChatMemberAccess('channel-known')).resolves.toMatchObject({
      permissions: [],
      permissionsKnown: true,
    });
    await expect(service.getCurrentChatMemberAccess('channel-legacy')).resolves.toMatchObject({
      permissions: [],
      permissionsKnown: false,
    });

    await service.onModuleDestroy();
  });

  it('single-flights concurrent current bot member access checks and shares the Redis cache', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(
        from(
          Promise.resolve({
            status: 200,
            data: {
              user_id: 'bot-1',
              role: 'admin',
              is_admin: true,
              permissions: ['delete_message'],
            },
          }),
        ),
      ),
    };
    const service = createService(httpService);

    const [first, second] = await Promise.all([
      service.getCurrentChatMemberAccess('chat-1'),
      service.getCurrentChatMemberAccess('chat-1'),
    ]);

    expect(first).toEqual(second);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService);

    await expect(secondService.getCurrentChatMemberAccess('chat-1')).resolves.toEqual(first);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('passes timeout override to targeted chat member lookups', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'member',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.getChatMembersAccess('chat-1', ['user-1'], {
      trafficClass: 'critical',
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('encodes batched targeted chat member lookups as a comma separated user_ids value', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'member',
              },
              {
                user_id: 'user-2',
                role: 'member',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersAccess('chat-1', ['user-1', 'user-2']);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1%2Cuser-2',
      }),
    );
    expect([...result.keys()]).toEqual(['user-1', 'user-2']);

    await service.onModuleDestroy();
  });

  it('caches targeted chat member access and respects bypassCache', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              members: [
                {
                  user_id: 'user-1',
                  role: 'admin',
                  is_admin: true,
                  permissions: ['delete_message'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              members: [
                {
                  user_id: 'user-1',
                  role: 'member',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const first = await service.getChatMembersAccess('chat-1', ['user-1']);
    const cached = await service.getChatMembersAccess('chat-1', ['user-1']);
    const fresh = await service.getChatMembersAccess('chat-1', ['user-1'], { bypassCache: true });

    expect(first.get('user-1')).toEqual(
      expect.objectContaining({
        isAdmin: true,
        permissions: ['delete_message'],
      }),
    );
    expect(cached.get('user-1')).toEqual(first.get('user-1'));
    expect(fresh.get('user-1')).toEqual(
      expect.objectContaining({
        isAdmin: false,
        permissions: [],
      }),
    );
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('passes timeout override to chat admin lookups', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'admin',
                is_admin: true,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.getChatAdminIds('chat-1', {
      trafficClass: 'critical',
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members/admins',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('caches chat admin id lookups per bot and shares them through Redis', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'admin',
                is_admin: true,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService);

    await expect(secondService.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('paginates chat admin lookups until MAX stops returning a marker', async () => {
    const request = jest.fn();
    for (let index = 0; index < 21; index += 1) {
      request.mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: `user-${index + 1}`,
                role: 'admin',
                is_admin: true,
              },
            ],
            marker: index < 20 ? index + 1 : null,
          },
        }),
      );
    }
    const service = createService({ request });

    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(
      Array.from({ length: 21 }, (_, index) => `user-${index + 1}`),
    );
    expect(request).toHaveBeenCalledTimes(21);

    await service.onModuleDestroy();
  });

  it('returns null when requested chat member is absent', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberAccess('chat-1', 'user-404');

    expect(result).toBeNull();
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-404',
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns chat member profiles with avatar urls and usernames', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                last_name: 'Иванов',
                name: 'Алексей',
                username: 'aleksey',
                avatar_url: 'https://cdn.max.ru/u/1/avatar-small.jpg',
                full_avatar_url: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
              {
                user: {
                  user_id: 'user-2',
                  first_name: 'Марина',
                  last_name: 'Соколова',
                  nickname: 'Марина',
                  username: 'marina',
                  avatar_url: 'https://cdn.max.ru/u/2/avatar-small.jpg',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberProfiles('chat-1', ['user-1', 'user-2'], {
      timeoutMs: 2_500.9,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        timeout: 2_500,
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1%2Cuser-2',
      }),
    );
    expect(result.get('user-1')).toEqual({
      userId: 'user-1',
      displayName: 'Алексей Иванов',
      username: 'aleksey',
      avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
      profileUrl: null,
    });
    expect(result.get('user-2')).toEqual({
      userId: 'user-2',
      displayName: 'Марина Соколова',
      username: 'marina',
      avatarUrl: 'https://cdn.max.ru/u/2/avatar-small.jpg',
      profileUrl: null,
    });

    await service.onModuleDestroy();
  });

  it('returns paginated chat member roster items with roles, avatars and bot markers', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                username: 'aleksey',
                role: 'owner',
                full_avatar_url: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
              {
                user: {
                  user_id: 'moderation_bot',
                  first_name: 'MAXIM',
                  username: 'moderation_bot',
                  avatar_url: 'https://cdn.max.ru/u/bot/avatar.jpg',
                  is_bot: true,
                },
                role: 'admin',
              },
            ],
            marker: 'page-2',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1', {
      limit: 100,
      marker: 'page-1',
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members',
        params: {
          count: 100,
          marker: 'page-1',
        },
      }),
    );
    expect(result).toEqual({
      items: [
        {
          userId: 'user-1',
          displayName: 'Алексей',
          username: 'aleksey',
          avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
          profileUrl: null,
          role: 'owner',
          isBot: false,
          unavailableReason: null,
        },
        {
          userId: 'moderation_bot',
          displayName: 'MAXIM',
          username: 'moderation_bot',
          avatarUrl: 'https://cdn.max.ru/u/bot/avatar.jpg',
          profileUrl: null,
          role: 'admin',
          isBot: true,
          unavailableReason: null,
        },
      ],
      nextMarker: 'page-2',
    });

    await service.onModuleDestroy();
  });

  it('returns direct profile urls from chat member payloads', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                url: 'https://max.ru/aleksey-profile',
              },
              {
                user: {
                  user_id: 'user-2',
                  first_name: 'Марина',
                  profile_url: 'https://max.ru/marina-profile',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberProfiles('chat-1', ['user-1', 'user-2']);

    expect(result.get('user-1')).toEqual({
      userId: 'user-1',
      displayName: 'Алексей',
      username: null,
      avatarUrl: null,
      profileUrl: 'https://max.ru/aleksey-profile',
    });
    expect(result.get('user-2')).toEqual({
      userId: 'user-2',
      displayName: 'Марина',
      username: null,
      avatarUrl: null,
      profileUrl: 'https://max.ru/marina-profile',
    });

    await service.onModuleDestroy();
  });

  it('combines first and last names for chat member roster profiles', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                last_name: 'Иванов',
                username: 'aleksey',
                is_bot: false,
              },
            ],
            marker: null,
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: 'Алексей Иванов',
      }),
    );

    await service.onModuleDestroy();
  });

  it('reads explicit unavailable account markers from chat member roster payloads', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'deleted-1',
                name: 'MAX account',
                is_deleted: true,
              },
              {
                user: {
                  user_id: 'blocked-1',
                  name: 'MAX account',
                  account_status: 'blocked',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items).toEqual([
      expect.objectContaining({
        userId: 'deleted-1',
        unavailableReason: 'deleted',
      }),
      expect.objectContaining({
        userId: 'blocked-1',
        unavailableReason: 'blocked',
      }),
    ]);

    await service.onModuleDestroy();
  });

  it('treats exact MAX deleted-user placeholders as unavailable without matching named users', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'deleted-placeholder',
                name: 'DELETED USER',
                first_name: 'DELETED',
                last_name: 'USER',
                is_bot: false,
              },
              {
                user_id: 'spoofed-profile',
                name: 'DELETED USER',
                first_name: 'DELETED',
                last_name: 'USER',
                username: 'deleted_user',
                is_bot: false,
              },
              {
                user_id: 'ordinary-user',
                name: 'Deleted User',
                first_name: 'Deleted',
                last_name: '',
                is_bot: false,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items).toEqual([
      expect.objectContaining({
        userId: 'deleted-placeholder',
        unavailableReason: 'deleted',
      }),
      expect.objectContaining({
        userId: 'spoofed-profile',
        unavailableReason: null,
      }),
      expect.objectContaining({
        userId: 'ordinary-user',
        unavailableReason: null,
      }),
    ]);

    await service.onModuleDestroy();
  });

  it('reads the current bot profile from GET /me', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: '214634783',
            first_name: 'Майор',
            last_name: 'Максимова',
            name: 'Майор',
            username: 'id613002203036_4_bot',
            avatar_url: 'https://i.oneme.ru/i?r=small-avatar',
            full_avatar_url: 'https://i.oneme.ru/i?r=full-avatar',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getOwnProfile({
      botId: '777000_bot',
      sourceTag: MAX_API_SOURCE_TAGS.SETTINGS_BOT_PROFILE,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/me',
      }),
    );
    expect(result).toEqual({
      userId: '214634783',
      displayName: 'Майор Максимова',
      username: 'id613002203036_4_bot',
      avatarUrl: 'https://i.oneme.ru/i?r=full-avatar',
      profileUrl: 'https://max.ru/id613002203036_4_bot',
    });

    await service.onModuleDestroy();
  });

  it('applies global MAX API rate limit to read requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis.eval
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 1, 1]);

    await expect(service.listMessages('chat-1', 10)).rejects.toThrow(
      'MAX API global rate limit exceeded',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies interactive MAX API rate limit to global chat discovery requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies stack-wide MAX API global limit before chat-scoped reads', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 4, 1]);

    await expect(service.listMessages('chat-1', 10)).rejects.toThrow(
      'MAX API global rate limit exceeded across all bots',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies stack-wide MAX API class limit across all bots', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 5, 1]);

    await expect(service.listMessages('chat-1', 10)).rejects.toThrow(
      'MAX API interactive rate limit exceeded across all bots',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not count interactive throttle errors in action health metrics', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccess: jest.Mock;
          recordFailure: jest.Mock;
        };
      }
    ).actionHealthService;

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');

    expect(actionHealthService.recordFailure).not.toHaveBeenCalled();
    expect(actionHealthService.recordSuccess).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('counts a critical internal limiter rejection in action health before dispatch', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0',
    });
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(
      service.deleteMessage('chat-1', 'message-1', {
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
      }),
    ).rejects.toMatchObject({ code: 'MAX_API_INTERNAL_RATE_LIMIT' });

    expect(actionHealthService.recordFailureForLane).toHaveBeenCalledWith(
      'critical',
      true,
      '777000_bot',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('waits briefly for a MAX API slot before executing the request', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [],
            marker: null,
          },
        }),
      ),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '10',
      MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: '1',
    });
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 2, 1])
      .mockResolvedValueOnce([1, 0, 0]);

    await expect(service.listBotChats()).resolves.toEqual([]);

    expect(limiterRedis.eval).toHaveBeenCalledTimes(3);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('shares GCRA stack reservations across service instances and smooths the next slot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
    const firstService = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '1',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      },
    );
    const secondService = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '1',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      },
    );

    await expect(
      (firstService as any).tryReserveRateLimitSlot('bot-a', 'chat-a', 'interactive'),
    ).resolves.toEqual({ ok: true });
    await expect(
      (secondService as any).tryReserveRateLimitSlot('bot-b', 'chat-b', 'interactive'),
    ).resolves.toEqual({
      ok: false,
      retryAfterMs: 1_000,
      reason: 'MAX API global rate limit exceeded across all bots',
    });

    jest.advanceTimersByTime(1_000);
    await expect(
      (secondService as any).tryReserveRateLimitSlot('bot-b', 'chat-b', 'interactive'),
    ).resolves.toEqual({ ok: true });

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('adds operation, bot, and entity GCRA dimensions to message mutations', async () => {
    const httpService = {
      request: jest.fn((request: { method?: string }) => {
        if (request.method === 'post') {
          return of({ status: 200, data: { message_id: 'mid-send-1' } });
        }
        if (request.method === 'get') {
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-1',
                    text: 'Before',
                    attachments: [],
                  },
                },
              ],
            },
          });
        }
        if (request.method === 'put' || request.method === 'delete') {
          return of({ status: 200, data: { success: true } });
        }
        throw new Error(`Unexpected MAX request method ${String(request.method)}`);
      }),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_GLOBAL_RPS_CRITICAL: '100',
      MAX_API_CHAT_RPS: '100',
    });

    await service.sendMessageImmediateWithId('chat-send', 'Hello');
    await service.sendMessageImmediateToUser('user-send', 'Direct hello');
    await service.executeActionJob({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-queued-send',
      text: 'Queued hello',
      attempt: 1,
      idempotencyKey: 'send-rate-limit-key',
      createdAt: new Date().toISOString(),
    });
    await service.editMessageInlineKeyboard('chat-edit', 'mid-edit-1', 'After');
    await service.executeActionJob({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-delete',
      messageId: 'mid-delete-1',
      attempt: 1,
      idempotencyKey: 'delete-rate-limit-key',
      createdAt: new Date().toISOString(),
    });
    await service.answerCallback('callback-rate-limit', 'Done', undefined, {
      rateLimitEntityId: 'chat-answer',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    const messageMutationKeys = limiterRedis.eval.mock.calls.flatMap((call) => {
      if (!String(call[0]).includes('MAX_API_GCRA_RESERVE_V1')) {
        return [];
      }
      const keyCount = Number(call[1]);
      return call
        .slice(2, 2 + keyCount)
        .map((key: unknown) => String(key))
        .filter((key: string) => key.startsWith('maxapi:gcra:v1:message-mutation:'));
    });

    expect(messageMutationKeys).toEqual([
      'maxapi:gcra:v1:message-mutation:operation:send:scope:target:chat-send',
      'maxapi:gcra:v1:message-mutation:operation:send:scope:target:user%3Auser-send',
      'maxapi:gcra:v1:message-mutation:operation:send:scope:target:chat-queued-send',
      'maxapi:gcra:v1:message-mutation:operation:edit:scope:target:chat-edit',
      'maxapi:gcra:v1:message-mutation:operation:delete:scope:target:chat-delete',
      'maxapi:gcra:v1:message-mutation:operation:answer:scope:target:chat-answer',
    ]);

    await service.onModuleDestroy();
  });

  it('shares a smoothed two-per-second message mutation quota while isolating dimensions', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:02:00.000Z'));
    const config = {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_GLOBAL_RPS_CRITICAL: '100',
      MAX_API_CHAT_RPS: '100',
    };
    const firstService = createService({}, config);
    const secondService = createService({}, config);
    const reserve = (
      service: MaxClientService,
      operation: 'send' | 'edit' | 'delete' | 'answer',
      botId: string,
      entityId: string,
    ) =>
      (service as any).tryReserveRateLimitSlot(botId, entityId, 'critical', undefined, {
        operation,
        entityId,
      });

    await expect(reserve(firstService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API send message rate limit exceeded for target chat-a',
    });

    jest.advanceTimersByTime(500);
    await expect(reserve(secondService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(firstService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API send message rate limit exceeded for target chat-a',
    });

    await expect(reserve(secondService, 'edit', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'delete', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'send', 'bot-a', 'chat-b')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'send', 'bot-b', 'chat-a')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API send message rate limit exceeded for target chat-a',
    });
    await expect(reserve(firstService, 'answer', 'bot-a', 'chat-answer')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'answer', 'bot-a', 'chat-answer')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API answer message rate limit exceeded for target chat-answer',
    });

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('shares an open circuit across instances before dispatch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:05:00.000Z'));
    const upstreamFailure = Object.assign(new Error('MAX unavailable'), {
      response: { status: 500, data: { message: 'MAX unavailable' } },
    });
    const firstHttpService = {
      request: jest.fn().mockReturnValue(throwError(() => upstreamFailure)),
    };
    const firstService = createService(firstHttpService, {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '2',
    });
    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService, {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '2',
    });

    await expect(firstService.getChatSnapshot('chat-1')).rejects.toBe(upstreamFailure);
    const circuitError = await secondService
      .executeActionJob({
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'ban-open-circuit',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(circuitError).toMatchObject({
      name: 'MaxApiCircuitOpenError',
      code: 'MAX_API_CIRCUIT_OPEN',
      preDispatch: true,
      botId: '777000_bot',
      retryAfterMs: 2_000,
    });
    expect(wasMaxMemberMutationAttempted(circuitError)).toBe(false);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it.each([
    ['connection reset', 'ECONNRESET'],
    ['DNS lookup failure', 'ENOTFOUND'],
    ['connection refusal', 'ECONNREFUSED'],
    ['TLS certificate failure', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ])('opens the shared circuit after a %s without an HTTP response', async (_label, code) => {
    const transportFailure = Object.assign(new Error(`MAX transport failed: ${code}`), { code });
    const firstService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => transportFailure)),
      },
      {
        MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
        MAX_API_CIRCUIT_WINDOW_SEC: '30',
        MAX_API_CIRCUIT_OPEN_SEC: '2',
      },
    );
    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService, {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '2',
    });

    await expect(firstService.getChatSnapshot('chat-transport')).rejects.toBe(transportFailure);
    await expect(secondService.getChatSnapshot('chat-transport')).rejects.toBeInstanceOf(
      MaxApiCircuitOpenError,
    );
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('keeps a half-open circuit open when its probe times out', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:07:00.000Z'));
    const config = {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '1',
      MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '60',
    };
    const initialFailure = Object.assign(new Error('MAX unavailable'), {
      response: { status: 500 },
    });
    const timeoutFailure = Object.assign(new Error('request timed out'), {
      code: 'ETIMEDOUT',
    });
    const firstService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => initialFailure)),
      },
      config,
    );
    const probeService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => timeoutFailure)),
      },
      config,
    );
    const blockedHttpService = { request: jest.fn() };
    const blockedService = createService(blockedHttpService, config);

    await expect(firstService.getChatSnapshot('chat-probe')).rejects.toBe(initialFailure);
    jest.advanceTimersByTime(1_000);
    await expect(probeService.getChatSnapshot('chat-probe')).rejects.toBe(timeoutFailure);
    await expect(blockedService.getChatSnapshot('chat-probe')).rejects.toBeInstanceOf(
      MaxApiCircuitOpenError,
    );
    expect(blockedHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await probeService.onModuleDestroy();
    await blockedService.onModuleDestroy();
  });

  it('closes a half-open circuit after an ordinary HTTP 4xx response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:08:00.000Z'));
    const config = {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '1',
      MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '60',
    };
    const firstService = createService({}, config);
    const initialPermit = await (firstService as any).acquireCircuitPermit('777000_bot');
    await (firstService as any).registerCriticalFailure('777000_bot', initialPermit);
    jest.advanceTimersByTime(1_000);

    const forbidden = Object.assign(new Error('forbidden'), {
      response: { status: 403 },
    });
    const probeService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => forbidden)),
      },
      config,
    );
    await expect(probeService.getChatSnapshot('chat-forbidden')).rejects.toBe(forbidden);

    const nextService = createService({}, config);
    await expect((nextService as any).acquireCircuitPermit('777000_bot')).resolves.toEqual({
      halfOpenProbeToken: null,
    });

    await firstService.onModuleDestroy();
    await probeService.onModuleDestroy();
    await nextService.onModuleDestroy();
  });

  it('allows only one shared half-open probe and closes it with a fenced token', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:10:00.000Z'));
    const config = {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '1',
      MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '60',
    };
    const firstService = createService({}, config);
    const secondService = createService({}, config);
    const thirdService = createService({}, config);
    const firstPermit = await (firstService as any).acquireCircuitPermit('777000_bot');
    await (firstService as any).registerCriticalFailure('777000_bot', firstPermit);

    jest.advanceTimersByTime(1_000);
    const probePermit = await (secondService as any).acquireCircuitPermit('777000_bot');
    expect(probePermit.halfOpenProbeToken).toEqual(expect.any(String));
    await expect((thirdService as any).acquireCircuitPermit('777000_bot')).rejects.toBeInstanceOf(
      MaxApiCircuitOpenError,
    );

    await (secondService as any).closeCircuitAfterSuccessfulProbe('777000_bot', probePermit);
    await expect((thirdService as any).acquireCircuitPermit('777000_bot')).resolves.toEqual({
      halfOpenProbeToken: null,
    });

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
    await thirdService.onModuleDestroy();
  });

  it('records internal limiter rejection separately from an external MAX 429', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:15:00.000Z'));
    const internalService = createService(
      { request: jest.fn() },
      {
        MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
      },
    );
    const internalRedis = (internalService as any).limiterRedis;
    const internalDiagnostics = {
      recordProblemChat: jest.fn().mockResolvedValue(undefined),
    };
    (internalService as any).runtimeDiagnosticsService = internalDiagnostics;
    const internalWarn = jest.spyOn((internalService as any).logger, 'warn');
    internalRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 250]);

    await expect(internalService.getChatSnapshot('chat-internal')).rejects.toMatchObject({
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
      retryAfterMs: 250,
    });
    const nowSec = Math.floor(Date.now() / 1_000);
    await expect(
      internalRedis.get(`maxapi:rate-limit:v1:internal_limiter:777000_bot:interactive:${nowSec}`),
    ).resolves.toBe('1');
    expect(internalDiagnostics.recordProblemChat).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'max_api_internal_limiter', statusCode: null }),
    );
    expect(internalWarn).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'internal_limiter' }),
      'MAX API internal limiter rejected request before dispatch',
    );
    await (internalService as any).recordRateLimitOutcome({
      origin: 'internal_limiter',
      botId: '777000_bot',
      chatId: 'chat-internal-2',
      trafficClass: 'interactive',
      reason: 'another internal reject',
      retryAfterMs: 200,
    });
    await expect(
      internalRedis.get(`maxapi:rate-limit:v1:internal_limiter:777000_bot:interactive:${nowSec}`),
    ).resolves.toBe('2');
    expect(internalWarn).toHaveBeenCalledTimes(1);
    await internalService.onModuleDestroy();

    (
      Redis as unknown as { __store: Map<string, { value: string; expiresAtMs: number | null }> }
    ).__store.clear();
    const externalError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const externalService = createService({
      request: jest.fn().mockReturnValue(throwError(() => externalError)),
    });
    const externalRedis = (externalService as any).limiterRedis;
    const externalDiagnostics = {
      recordProblemChat: jest.fn().mockResolvedValue(undefined),
    };
    (externalService as any).runtimeDiagnosticsService = externalDiagnostics;
    const externalWarn = jest.spyOn((externalService as any).logger, 'warn');

    await expect(externalService.getChatSnapshot('chat-external')).rejects.toBe(externalError);
    await expect(
      externalRedis.get(`maxapi:rate-limit:v1:external_429:777000_bot:interactive:${nowSec}`),
    ).resolves.toBe('1');
    expect(externalDiagnostics.recordProblemChat).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'max_api_external_429', statusCode: 429 }),
    );
    expect(externalWarn).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'external_429', statusCode: 429 }),
      'MAX API returned external HTTP 429',
    );
    await externalService.onModuleDestroy();
  });

  it('lets user-facing traffic classes borrow spare global headroom while capping background work', async () => {
    const service = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '30',
        MAX_API_GLOBAL_RPS_CRITICAL: '12',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '10',
        MAX_API_GLOBAL_RPS_BACKGROUND: '4',
      },
    );

    expect((service as any).resolveTrafficClassEffectiveRpsLimit('critical')).toBe(16);
    expect((service as any).resolveTrafficClassEffectiveRpsLimit('interactive')).toBe(14);
    expect((service as any).resolveTrafficClassEffectiveRpsLimit('background')).toBe(4);

    await service.onModuleDestroy();
  });

  it('reuses Redis cache for bot chat discovery across service instances', async () => {
    const firstHttpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [
              {
                chat_id: 'chat-1',
                title: 'Chat 1',
                last_event_time: 1710000000000,
                type: 'chat',
                link: 'https://max.ru/chat-1',
              },
            ],
            marker: null,
          },
        }),
      ),
    };
    const firstService = createService(firstHttpService, {
      MAX_API_LIST_BOT_CHATS_CACHE_SEC: '15',
    });

    const firstResult = await firstService.listBotChats();

    const secondHttpService = {
      request: jest.fn(),
    };
    const secondService = createService(secondHttpService, {
      MAX_API_LIST_BOT_CHATS_CACHE_SEC: '15',
    });

    const secondResult = await secondService.listBotChats();

    expect(firstResult).toEqual(secondResult);
    expect(firstHttpService.request).toHaveBeenCalledTimes(1);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('paginates bot chat discovery beyond twenty pages', async () => {
    const request = jest.fn();
    for (let index = 0; index < 21; index += 1) {
      request.mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [
              {
                chat_id: `chat-${index + 1}`,
                title: `Chat ${index + 1}`,
                type: 'chat',
              },
            ],
            marker: index < 20 ? index + 1 : null,
          },
        }),
      );
    }
    const service = createService({ request });

    await expect(service.listBotChats({ bypassCache: true })).resolves.toEqual(
      Array.from({ length: 21 }, (_, index) => ({
        chatId: `chat-${index + 1}`,
        title: `Chat ${index + 1}`,
        lastEventTime: null,
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        botId: '777000_bot',
        botIds: ['777000_bot'],
      })),
    );
    expect(request).toHaveBeenCalledTimes(21);

    await service.onModuleDestroy();
  });

  it('shares an in-flight bot chat discovery request for the same bot', async () => {
    let resolveResponse!: (value: { status: number; data: Record<string, unknown> }) => void;
    const response = new Promise<{ status: number; data: Record<string, unknown> }>((resolve) => {
      resolveResponse = resolve;
    });
    const request = jest.fn().mockReturnValue(from(response));
    const service = createService({ request });

    const first = service.listBotChats({ bypassCache: true });
    const second = service.listBotChats({ bypassCache: true });

    await new Promise((resolve) => setImmediate(resolve));
    expect(request).toHaveBeenCalledTimes(1);

    resolveResponse({
      status: 200,
      data: {
        chats: [
          {
            chat_id: 'chat-1',
            title: 'Chat 1',
            type: 'chat',
          },
        ],
        marker: null,
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          chatId: 'chat-1',
          title: 'Chat 1',
          lastEventTime: null,
          entityType: 'chat',
          link: null,
          avatarUrl: null,
          botId: '777000_bot',
          botIds: ['777000_bot'],
        },
      ],
      [
        {
          chatId: 'chat-1',
          title: 'Chat 1',
          lastEventTime: null,
          entityType: 'chat',
          link: null,
          avatarUrl: null,
          botId: '777000_bot',
          botIds: ['777000_bot'],
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('blocks legacy bot chat discovery in production before limiter or HTTP calls', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      NODE_ENV: 'production',
    });
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;

    await expect(service.listBotChats({ bypassCache: true })).rejects.toThrow(
      'MAX API GET /chats is not supported in production',
    );

    expect(limiterRedis.eval).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('bypasses cached chat snapshot when explicitly requested', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
              is_public: false,
              last_event_time: '2026-03-26T10:00:00.000Z',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1 Updated',
              participants_count: 12,
              status: 'active',
              is_public: true,
              link: 'https://max.ru/chat-1',
              last_event_time: '2026-03-26T10:00:05.000Z',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_API_CHAT_SNAPSHOT_CACHE_SEC: '10',
    });

    const firstSnapshot = await service.getChatSnapshot('chat-1');
    const cachedSnapshot = await service.getChatSnapshot('chat-1');
    const freshSnapshot = await service.getChatSnapshot('chat-1', { bypassCache: true });

    expect(firstSnapshot.title).toBe('Chat 1');
    expect(cachedSnapshot.title).toBe('Chat 1');
    expect(freshSnapshot.title).toBe('Chat 1 Updated');
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('resolves channel snapshots by public chat link without listing bot chats', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chat_id: 'channel-1',
            title: 'Новости MAX',
            participants_count: 10,
            status: 'active',
            is_public: true,
            link: 'https://max.ru/channels/news-max',
            type: 'channel',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChannelSnapshotByLink('news-max')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: 'https://max.ru/channels/news-max',
      }),
    );
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/news-max',
      }),
    );

    await service.onModuleDestroy();
  });

  it('detects channel snapshots from public /channels links when MAX omits an explicit type', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Новости MAX',
            participants_count: 10,
            status: 'active',
            is_public: true,
            link: 'https://max.ru/channels/news-max',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatSnapshot('channel-1')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: 'https://max.ru/channels/news-max',
      }),
    );

    await service.onModuleDestroy();
  });

  it('detects private channel snapshots from is_channel when MAX omits type and link', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Приватный канал',
            participants_count: 4,
            status: 'active',
            is_public: false,
            is_channel: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatSnapshot('channel-private-1')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-private-1',
        title: 'Приватный канал',
        entityType: 'channel',
        isPublic: false,
        link: null,
      }),
    );

    await service.onModuleDestroy();
  });

  it('applies background MAX API rate limit to background snapshot reads', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_BACKGROUND: '2',
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(service.getChatSnapshot('chat-1', { trafficClass: 'background' })).rejects.toThrow(
      'MAX API background rate limit exceeded',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('records source-level MAX API usage for tagged background reads', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:05.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Chat 1',
            participants_count: 10,
            status: 'active',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (service as unknown as { limiterRedis: { get: jest.Mock } }).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Chat 1',
      }),
    );

    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:background:managed_refresh:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('records shared usage once while isolating service-scoped class metrics', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:10.000Z'));

    const response = {
      status: 200,
      data: {
        title: 'Chat 1',
        participants_count: 10,
        status: 'active',
      },
    };
    const serviceA = createService(
      { request: jest.fn().mockReturnValueOnce(of(response)) },
      { APP_SERVICE_NAME: 'API Action / A' },
    );
    const serviceB = createService(
      { request: jest.fn().mockReturnValueOnce(of(response)) },
      { APP_SERVICE_NAME: 'API Action / B' },
    );
    const limiterRedis = (
      serviceA as unknown as { limiterRedis: { get: jest.Mock; pttl: jest.Mock } }
    ).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await serviceA.getChatSnapshot('chat-a', { trafficClass: 'background' });
    await serviceB.getChatSnapshot('chat-b', { trafficClass: 'background' });

    await expect(limiterRedis.get(`maxapi:rps:global:777000_bot:${nowSec}`)).resolves.toBe('2');
    await expect(
      limiterRedis.get(`maxapi:rps:global:777000_bot:background:${nowSec}`),
    ).resolves.toBe('2');
    await expect(limiterRedis.get(`maxapi:rps:stack:${nowSec}`)).resolves.toBe('2');
    await expect(limiterRedis.get(`maxapi:rps:stack:background:${nowSec}`)).resolves.toBe('2');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_a:bot:777000_bot:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_b:bot:777000_bot:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_a:stack:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_b:stack:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.pttl(`maxapi:rps:service:v1:api_action_a:stack:background:${nowSec}`),
    ).resolves.toBe(120_000);
    await expect(limiterRedis.pttl(`maxapi:rps:stack:background:${nowSec}`)).resolves.toBe(
      6 * 60 * 60 * 1_000,
    );

    await serviceA.onModuleDestroy();
    await serviceB.onModuleDestroy();
  });

  it('scopes class and source limiter budgets by service while retaining one 30 rps stack guard', async () => {
    const service = createService(
      { request: jest.fn() },
      {
        APP_SERVICE_NAME: 'API Action / A',
        MAX_API_GLOBAL_RPS: '45',
      },
    );
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;

    await (
      service as unknown as {
        tryReserveRateLimitSlot: (
          botId: string,
          chatId: string,
          trafficClass: 'background',
          sourceTag: string,
        ) => Promise<{ ok: boolean }>;
      }
    ).tryReserveRateLimitSlot(
      '777000_bot',
      'chat-1',
      'background',
      MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
    );

    const call = limiterRedis.eval.mock.calls.at(-1) as unknown[];
    const keyCount = Number(call[1]);
    const keys = call.slice(2, 2 + keyCount);
    const limits = call.slice(2 + keyCount, 2 + keyCount * 2);
    expect(keys).toEqual([
      'maxapi:gcra:v1:bot:777000_bot:all',
      'maxapi:gcra:v1:service:api_action_a:bot:777000_bot:class:background',
      'maxapi:gcra:v1:chat:777000_bot:chat-1',
      'maxapi:gcra:v1:stack:all',
      'maxapi:gcra:v1:service:api_action_a:stack:class:background',
      'maxapi:gcra:v1:service:api_action_a:source:777000_bot:managed_refresh',
      'maxapi:gcra:v1:service:api_action_a:source:stack:managed_refresh',
    ]);
    expect(limits[3]).toBe('30');
    expect(limits.slice(-2)).toEqual(['2', '2']);

    await service.onModuleDestroy();
  });

  it('applies the managed_refresh source budget before background reads consume the shared pool', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:01:05.000Z'));

    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_API_MANAGED_REFRESH_RPS: '1',
      MAX_API_MANAGED_REFRESH_STACK_RPS: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '0',
    });

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).resolves.toEqual(expect.objectContaining({ chatId: 'chat-1' }));

    await expect(
      service.getChatSnapshot('chat-2', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).rejects.toThrow('MAX API managed_refresh source limit exceeded for bot 777000_bot');
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('preserves source-level MAX API usage tags for immediate dispatched mutations', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:25.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { success: true },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (service as unknown as { limiterRedis: { get: jest.Mock } }).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await expect(
      service.deleteMessage('channel-1', 'mid-1', {
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      }),
    ).resolves.toBeUndefined();

    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:background:channel_auto_post:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('can record admin MAX reads in a background action health lane while keeping interactive traffic class', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Chat 1',
            participants_count: 10,
            status: 'active',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccessForLane: jest.Mock;
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Chat 1',
      }),
    );

    expect(actionHealthService.recordSuccessForLane).toHaveBeenCalledWith(
      'background',
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('preserves a background action health lane for mutations even when traffic stays critical', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            message_id: 'mid-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccessForLane: jest.Mock;
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.sendMessageImmediateWithId('chat-1', 'Фоновое сообщение', undefined, {
        actionHealthLane: 'background',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'mid-1',
      }),
    );

    expect(actionHealthService.recordSuccessForLane).toHaveBeenCalledWith(
      'background',
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies per-chat MAX API rate limit to profile lookups', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_CHAT_RPS: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 3, 1]);

    await expect(service.getChatMemberProfiles('chat-1', ['user-1'])).rejects.toThrow(
      'MAX API per-chat rate limit exceeded for bot 777000_bot chat chat-1',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('extends webhook subscriptions with churn update types', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: ['message_created', 'user_added', 'bot_started'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
    });

    const result = await service.ensureWebhookSubscription([
      'message_created',
      'user_added',
      'user_removed',
      'bot_added',
      'bot_removed',
      'bot_started',
    ]);

    expect(result).toEqual({
      url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
      updateTypes: [
        'bot_added',
        'bot_removed',
        'bot_started',
        'message_created',
        'user_added',
        'user_removed',
      ],
    });
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: {
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          update_types: [
            'bot_added',
            'bot_removed',
            'bot_started',
            'message_created',
            'user_added',
            'user_removed',
          ],
          secret: 'header-secret',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('replaces webhook update types only when exact reconciliation is requested', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: ['message_created', 'message_removed'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
    });

    const result = await service.ensureWebhookSubscription(['message_created'], {
      replaceUpdateTypes: true,
    });

    expect(result).toEqual({
      url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
      updateTypes: ['message_created'],
    });
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: {
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          update_types: ['message_created'],
          secret: 'header-secret',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('forces a webhook subscription POST upsert for secret rotation without deleting first', async () => {
    const updateTypes = ['message_created', 'bot_added'];
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: updateTypes,
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'rotated-header-secret',
    });

    await service.ensureWebhookSubscription(updateTypes, { forceUpsert: true });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: expect.objectContaining({
          secret: 'header-secret',
        }),
      }),
    );

    await service.onModuleDestroy();
  });
});

describe('MaxClientService delayed member actions', () => {
  function createServiceWithQueue(
    queue: { add: jest.Mock; getJob: jest.Mock },
    actionLedgerService?: {
      assertCanEnqueue?: jest.Mock;
      recordEnqueuedIfAbsent?: jest.Mock;
      recordEnqueueFailedIfAbsent?: jest.Mock;
      recordEnqueueAmbiguousIfAbsent?: jest.Mock;
      hasExecutionEvidenceSince?: jest.Mock;
    },
    maxBotLinkService?: {
      resolveBotRoute?: jest.Mock;
    },
    laneQueues: Partial<
      Record<
        | typeof MAX_ACTION_CRITICAL_QUEUE
        | typeof MAX_ACTION_INTERACTIVE_QUEUE
        | typeof MAX_ACTION_BACKGROUND_QUEUE,
        { add: jest.Mock; getJob: jest.Mock }
      >
    > = {},
  ) {
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api2.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: '777000_bot',
        token: 'test-token',
        webhookSecretPath: 'secret-path',
        webhookHeaderSecret: 'header-secret',
        webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) =>
        !botId || botId === '777000_bot'
          ? {
              id: '777000_bot',
              token: 'test-token',
              webhookSecretPath: 'secret-path',
              webhookHeaderSecret: 'header-secret',
              webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
              maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
            }
          : null,
      ),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue(null),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };

    return new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      queue as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
      laneQueues[MAX_ACTION_CRITICAL_QUEUE] as never,
      laneQueues[MAX_ACTION_INTERACTIVE_QUEUE] as never,
      laneQueues[MAX_ACTION_BACKGROUND_QUEUE] as never,
    );
  }

  function createCollapsingQueue() {
    const jobsById = new Map<string, unknown>();
    return {
      jobsById,
      queue: {
        add: jest.fn().mockImplementation(async (_name: string, job: unknown, options: unknown) => {
          const jobId = (options as { jobId?: string }).jobId;
          if (jobId && !jobsById.has(jobId)) {
            jobsById.set(jobId, job);
          }
          return { id: jobId };
        }),
        getJob: jest.fn().mockResolvedValue(null),
      },
    };
  }

  it('routes queued actions into physical traffic lanes while keeping legacy as fallback', async () => {
    const createQueue = () => ({
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    });
    const legacy = createQueue();
    const critical = createQueue();
    const interactive = createQueue();
    const background = createQueue();
    const service = createServiceWithQueue(legacy, undefined, undefined, {
      [MAX_ACTION_CRITICAL_QUEUE]: critical,
      [MAX_ACTION_INTERACTIVE_QUEUE]: interactive,
      [MAX_ACTION_BACKGROUND_QUEUE]: background,
    });

    await service.sendMessage('chat-1', 'interactive notice');
    await service.deleteMessage('chat-1', 'message-1');
    await service.sendMessage('chat-1', 'background notice', undefined, {
      trafficClass: 'background',
    });

    expect(interactive.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({ actionType: 'SEND_MESSAGE', text: 'interactive notice' }),
      expect.any(Object),
    );
    expect(critical.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({ actionType: 'DELETE_MESSAGE', messageId: 'message-1' }),
      expect.any(Object),
    );
    expect(background.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        text: 'background notice',
        trafficClass: 'background',
      }),
      expect.any(Object),
    );
    expect(legacy.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('dispatches queued delete actions with the active bot context when botId is omitted', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api2.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: 'id613002203036_bot',
        token: 'default-token',
        webhookSecretPath: 'default-secret',
        webhookHeaderSecret: 'default-header-secret',
        webhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/default-secret',
        maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId || botId === 'id613002203036_bot') {
          return {
            id: 'id613002203036_bot',
            token: 'default-token',
            webhookSecretPath: 'default-secret',
            webhookHeaderSecret: 'default-header-secret',
            webhookUrl:
              'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/default-secret',
            maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/***',
          };
        }

        if (botId === 'id613002203036_4_bot') {
          return {
            id: 'id613002203036_4_bot',
            token: 'secondary-token',
            webhookSecretPath: 'secondary-secret',
            webhookHeaderSecret: 'secondary-header-secret',
            webhookUrl:
              'https://major-maksimov.ru/api/webhook/max/id613002203036_4_bot/secondary-secret',
            maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_4_bot/***',
          };
        }

        return null;
      }),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/default-secret',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };
    const service = new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      queue as never,
    );

    await service.deleteMessage('-72881707399277', 'mid-delete-1');

    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: '-72881707399277',
        messageId: 'mid-delete-1',
        botId: 'id613002203036_4_bot',
      }),
      expect.objectContaining({
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 1_000,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses caller-provided idempotency keys as stable BullMQ job ids', async () => {
    const { jobsById, queue } = createCollapsingQueue();
    const service = createServiceWithQueue(queue);

    await service.sendMessage('chat-1', 'first notice', undefined, {
      idempotencyKey: ' moderation:notice:chat-1:user-1 ',
    });
    await service.sendMessage('chat-1', 'second notice', undefined, {
      idempotencyKey: 'moderation:notice:chat-1:user-1',
    });

    const firstJobId = queue.add.mock.calls[0][2].jobId;
    const secondJobId = queue.add.mock.calls[1][2].jobId;

    expect(firstJobId).toBe(secondJobId);
    expect(firstJobId).toMatch(/^max-action__explicit__/);
    expect(firstJobId).not.toContain(':');
    expect(jobsById.size).toBe(1);
    expect([...jobsById.values()][0]).toEqual(
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        text: 'first notice',
        idempotencyKey: firstJobId,
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps routed job ids logical and carries route candidates into BullMQ', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(queue);

    await service.sendMessage('chat-1', 'notice', undefined, {
      botId: '777000_bot',
      candidateBotIds: ['777000_bot', 'standby-bot'],
      routing: {
        purpose: 'send_message',
        primaryBotId: '777000_bot',
        reason: 'primary_confirmed',
        routingVersion: 7,
      },
      idempotencyKey: 'publication:occurrence-1:chat-1',
    });

    const queuedJob = queue.add.mock.calls[0][1];
    expect(queuedJob).toEqual(
      expect.objectContaining({
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        routing: expect.objectContaining({
          purpose: 'send_message',
          routingVersion: 7,
        }),
      }),
    );
    expect(queuedJob.idempotencyKey).toMatch(/^max-action__explicit__send_message__/);
    expect(queuedJob.idempotencyKey).not.toContain('777000_bot');

    await service.onModuleDestroy();
  });

  it('resolves managed-chat route candidates when callers do not bind a bot', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: '-100-chat-1',
        primaryBotId: '777000_bot',
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        reason: 'primary_confirmed',
      }),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await service.sendMessage('-100-chat-1', 'notice', undefined, {
      idempotencyKey: 'publication:occurrence-1:chat-1',
    });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: '-100-chat-1',
      fallbackToPrimary: true,
    });
    expect(queue.add.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        routing: expect.objectContaining({ purpose: 'send_message' }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('fails closed when a managed group route resolves without an eligible bot', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: '-100-chat-without-route',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
        routingVersion: 3,
      }),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await expect(
      service.sendMessage('-100-chat-without-route', 'must not use default'),
    ).rejects.toThrow('has no eligible routed bot candidate');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('fails closed without default-bot fallback when managed route resolution throws', async () => {
    const routeError = new Error('managed route lookup timed out');
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockRejectedValue(routeError),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);
    const getDefaultBot = (service as any).botRegistry.getDefaultBot as jest.Mock;
    getDefaultBot.mockClear();

    await expect(service.sendMessage('-100-route-error', 'must retry routing')).rejects.toBe(
      routeError,
    );

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(getDefaultBot).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps private dialog sends on their explicit bot context instead of managed routing', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn(),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await service.sendMessage('123456789', 'private notice');

    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(queue.add.mock.calls[0][1]).toEqual(
      expect.not.objectContaining({
        routing: expect.anything(),
        candidateBotIds: expect.anything(),
      }),
    );

    await service.onModuleDestroy();
  });

  it('dedupes delete and ban state while assigning a fresh id to each kick episode', async () => {
    const { jobsById, queue } = createCollapsingQueue();
    const service = createServiceWithQueue(queue);

    await service.deleteMessage('chat-1', 'mid-1');
    await service.deleteMessage('chat-1', 'mid-1');
    await service.kickMember('chat-1', 'user-1');
    await service.kickMember('chat-1', 'user-1');
    await service.banMember('chat-1', 'user-1');

    const deleteJobId = queue.add.mock.calls[0][2].jobId;
    const duplicateDeleteJobId = queue.add.mock.calls[1][2].jobId;
    const kickJobId = queue.add.mock.calls[2][2].jobId;
    const duplicateKickJobId = queue.add.mock.calls[3][2].jobId;
    const banJobId = queue.add.mock.calls[4][2].jobId;

    expect(duplicateDeleteJobId).toBe(deleteJobId);
    expect(duplicateKickJobId).not.toBe(kickJobId);
    expect(deleteJobId).toMatch(/^max-action__logical__/);
    expect(kickJobId).not.toMatch(/^max-action__logical__/);
    expect(duplicateKickJobId).not.toMatch(/^max-action__logical__/);
    expect(banJobId).toMatch(/^max-action__logical__/);
    expect(new Set([deleteJobId, kickJobId, duplicateKickJobId, banJobId]).size).toBe(4);
    expect(jobsById.size).toBe(4);

    await service.onModuleDestroy();
  });

  it('records queued actions only after BullMQ accepts the job', async () => {
    const bullMqCreatedAt = Date.parse('2026-07-16T12:00:00.000Z');
    const queue = {
      add: jest.fn().mockResolvedValue({ timestamp: bullMqCreatedAt }),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await service.banMember('chat-1', 'user-1', {
      botId: '777000_bot',
      sourceTag: 'interactive',
    });

    const job = queue.add.mock.calls[0][1];
    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(
      job,
      new Date(bullMqCreatedAt),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordEnqueuedIfAbsent.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps an accepted BullMQ action when create-only ledger bookkeeping fails', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockRejectedValue(new Error('database unavailable')),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(
      queue.add.mock.calls[0][1],
      undefined,
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not enqueue actions blocked by a durable ambiguous ledger entry', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockRejectedValue(new UnrecoverableError('manual review')),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBeInstanceOf(UnrecoverableError);

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('records queue add failures in the durable ledger', async () => {
    const error = new Error('redis is unavailable');
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBe(error);

    const job = queue.add.mock.calls[0][1];
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).toHaveBeenCalledWith(job, error);

    await service.onModuleDestroy();
  });

  it('recovers an ambiguous BullMQ add when the deterministic job is retained', async () => {
    const error = new Error('redis reply lost');
    const bullMqCreatedAt = Date.parse('2026-07-16T12:00:00.000Z');
    const retainedJob = {
      id: 'retained-job',
      timestamp: bullMqCreatedAt,
      getState: jest.fn().mockResolvedValue('waiting'),
    };
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(retainedJob),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    const job = queue.add.mock.calls[0][1];
    expect(queue.getJob).toHaveBeenLastCalledWith(job.idempotencyKey);
    expect(actionLedgerService.hasExecutionEvidenceSince).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(
      job,
      new Date(bullMqCreatedAt),
    );

    await service.onModuleDestroy();
  });

  it('recovers an ambiguous BullMQ add when a fast worker already recorded execution', async () => {
    const error = new Error('redis reply lost after completion');
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(true),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    const job = queue.add.mock.calls[0][1];
    expect(actionLedgerService.hasExecutionEvidenceSince).toHaveBeenCalledWith(
      job.idempotencyKey,
      expect.any(Date),
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(job, undefined);

    await service.onModuleDestroy();
  });

  it('retries the same job id when BullMQ ownership lookup is unavailable', async () => {
    const error = new Error('redis response was lost');
    const queue = {
      add: jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined),
      getJob: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('redis lookup unavailable')),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueAmbiguousIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('quarantines SEND_MESSAGE when both add attempts and ownership lookup are ambiguous', async () => {
    const error = new Error('redis response was lost');
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockRejectedValue(new Error('redis lookup unavailable')),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueAmbiguousIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.sendMessage('chat-1', 'notice')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
    expect(actionLedgerService.recordEnqueueAmbiguousIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'SEND_MESSAGE' }),
      expect.any(UnrecoverableError),
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not accept a retained final job without fresh execution evidence', async () => {
    const error = new Error('redis add failed');
    const retainedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
    };
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(retainedJob),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBe(error);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).toHaveBeenCalledWith(
      expect.any(Object),
      error,
    );
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('replaces retained failed logical jobs so repair retries are not swallowed', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const failedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      remove,
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(failedJob),
    };
    const service = createServiceWithQueue(queue);

    await service.deleteMessage('chat-1', 'mid-1');
    const firstJobId = queue.add.mock.calls[0][2].jobId;
    await service.deleteMessage('chat-1', 'mid-1');

    expect(queue.getJob).toHaveBeenNthCalledWith(2, firstJobId);
    expect(failedJob.getState).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[1][2].jobId).toBe(firstJobId);

    await service.onModuleDestroy();
  });

  it('does not replace retained ambiguous irreversible action jobs', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const failedJob = {
      data: {
        actionType: 'BAN_MEMBER',
      },
      failedReason: 'Ambiguous MAX BAN_MEMBER transport failure for chat chat-1 user user-1',
      getState: jest.fn().mockResolvedValue('failed'),
      remove,
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(failedJob),
    };
    const service = createServiceWithQueue(queue);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBeInstanceOf(UnrecoverableError);

    expect(queue.getJob).toHaveBeenCalledTimes(1);
    expect(failedJob.getState).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps an existing logical job on the legacy drain queue during lane rollout', async () => {
    const retainedJob = {
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn(),
    };
    const legacy = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(retainedJob),
    };
    const interactive = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(legacy, undefined, undefined, {
      [MAX_ACTION_INTERACTIVE_QUEUE]: interactive,
    });

    await service.sendMessage('chat-1', 'same logical notice', undefined, {
      idempotencyKey: 'notice-1',
    });

    expect(retainedJob.getState).toHaveBeenCalledTimes(1);
    expect(legacy.add).toHaveBeenCalledTimes(1);
    expect(interactive.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('uses deterministic queue job id for delayed unban', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(queue);
    const expectedJobId = 'member-action__777000_bot__UNBAN_MEMBER__chat-1__user-1';

    await service.unbanMember('chat-1', 'user-1', {
      delayMs: 60_000,
      idempotencyKey: 'manual-unban:user-1',
    });

    expect(queue.getJob).toHaveBeenCalledWith(expectedJobId);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expectedJobId,
        createdAt: '2026-07-16T12:00:00.000Z',
        scheduledFor: '2026-07-16T12:01:00.000Z',
      }),
      expect.objectContaining({
        jobId: expectedJobId,
        delay: 60_000,
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 1_000,
        },
      }),
    );
    expect(expectedJobId.includes(':')).toBe(false);

    await service.onModuleDestroy();
  });

  it('uses bot-independent delayed unban ids for routed jobs', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: '-100-chat-1',
        primaryBotId: '777000_bot',
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        reason: 'primary_confirmed',
        action: 'moderate_member',
      }),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await service.unbanMember('-100-chat-1', 'user-1', { delayMs: 60_000 });

    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        candidateBotIds: ['777000_bot', 'standby-bot'],
        idempotencyKey: 'member-action__logical__UNBAN_MEMBER__-100-chat-1__user-1',
      }),
      expect.objectContaining({
        jobId: 'member-action__logical__UNBAN_MEMBER__-100-chat-1__user-1',
      }),
    );

    await service.onModuleDestroy();
  });

  it('removes queued delayed unban when cancelling manual override', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValueOnce({ remove }).mockResolvedValueOnce(null),
    };
    const service = createServiceWithQueue(queue);

    await service.cancelScheduledUnban('chat-1', 'user-2');

    expect(queue.getJob).toHaveBeenCalledWith(
      'member-action__777000_bot__UNBAN_MEMBER__chat-1__user-2',
    );
    expect(queue.getJob).toHaveBeenCalledWith(
      'member-action__logical__UNBAN_MEMBER__chat-1__user-2',
    );
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('removes a delayed unban found in a split action lane', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const legacy = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const critical = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValueOnce({ remove }).mockResolvedValueOnce(null),
    };
    const service = createServiceWithQueue(legacy, undefined, undefined, {
      [MAX_ACTION_CRITICAL_QUEUE]: critical,
    });

    await service.cancelScheduledUnban('chat-1', 'user-3');

    expect(critical.getJob).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
