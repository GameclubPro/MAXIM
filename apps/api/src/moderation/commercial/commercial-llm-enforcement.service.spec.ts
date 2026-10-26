import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import {
  CommercialLlmEnforcementMailbox,
  type CommercialLlmAdmissionResult,
} from './commercial-llm-enforcement.mailbox';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { prepareCommercialLlmOffer } from './commercial-llm-enforcement.protocol';
import { withCanonicalWebhookOrigin } from '../webhook-effect-origin-context';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  textFiltersBanEnabled: true,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: true,
};
function input(now: number) {
  return {
    chatId: 'chat',
    messageId: 'message',
    userId: 'user',
    originBotId: 'bot',
    text: 'Наша мастерская принимает заказы на ремонт.',
    eventAt: new Date(now).toISOString(),
    settings,
    origin: {
      sourceWebhookEventId: 'receipt',
      sourceReceivingBotId: 'bot',
      sourceExecutionBotId: 'bot',
      sourceEventAtMs: now,
      sourceEvidenceVersion: 1 as const,
    },
  };
}
describe('commercial AI eligibility accounting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it('separates disabled/missing-origin inputs from eligible busy and accepted sources', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
    const mailbox = new CommercialLlmEnforcementMailbox(redis);
    let finish!: (value: CommercialLlmAdmissionResult) => void;
    const pending = new Promise<CommercialLlmAdmissionResult>((resolve) => {
      finish = resolve;
    });
    const submit = jest.spyOn(mailbox, 'offerDetailed').mockReturnValue(pending);
    jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
    const source = input(now);
    service.offer({ ...source, settings: { ...settings, commercialAdsFilterEnabled: false } });
    service.offer(source);
    await withCanonicalWebhookOrigin(
      {
        webhookEvent: { id: 'receipt', botId: 'bot' },
        activeBotId: 'bot',
        update: {
          updateId: 'update',
          botId: 'bot',
          type: 'message_created',
          eventTimestampSource: 'payload',
          raw: { timestamp: now },
          message: {
            chatId: 'chat',
            messageId: 'message',
            senderId: 'user',
            text: source.text,
            createdAt: source.eventAt,
          },
        },
      },
      async () => {
        service.offer(source);
        service.offer(source);
      },
    );
    expect(submit).toHaveBeenCalledTimes(1);
    now += 31_000;
    finish('accepted');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      logs.mock.calls
        .filter(([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission')
        .at(-1)?.[0],
    ).toMatchObject({
      schemaVersion: 3,
      offered: 4,
      ineligible: 2,
      eligible: 2,
      accepted: 1,
      skipped: 1,
      unavailable: 0,
      inFlight: 0,
      ineligibleReasons: { filter_disabled: 1, invalid_origin: 1 },
      skipReasons: { producer_busy: 1 },
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(source.text);
    service.onModuleDestroy();
    redis.disconnect();
  });
  it('settles a delayed admission in its original UTC window and never closes it while in flight', async () => {
    const now = Date.parse('2026-10-27T12:00:59.000Z');
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
    const mailbox = new CommercialLlmEnforcementMailbox(redis);
    let finish!: (value: CommercialLlmAdmissionResult) => void;
    jest.spyOn(mailbox, 'offerDetailed').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
    service.onModuleInit();
    const source = input(now);
    await withCanonicalWebhookOrigin(
      {
        webhookEvent: { id: 'receipt', botId: 'bot' },
        activeBotId: 'bot',
        update: {
          updateId: 'update',
          botId: 'bot',
          type: 'message_created',
          eventTimestampSource: 'payload',
          raw: { timestamp: now },
          message: {
            chatId: 'chat',
            messageId: 'message',
            senderId: 'user',
            text: source.text,
            createdAt: source.eventAt,
          },
        },
      },
      async () => {
        service.offer(source);
      },
    );
    jest.advanceTimersByTime(11_000);
    const windows = () =>
      logs.mock.calls.filter(
        ([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission-window',
      );
    expect(windows()).toHaveLength(0);
    finish('buffer_full');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(windows()).toHaveLength(1);
    expect(windows()[0]?.[0]).toMatchObject({
      windowStartAt: '2026-10-27T12:00:00.000Z',
      windowEndAt: '2026-10-27T12:01:00.000Z',
      offered: 1,
      eligible: 1,
      accepted: 0,
      skipped: 1,
      unavailable: 0,
      inFlight: 0,
    });
    jest.advanceTimersByTime(60_000);
    expect(windows()).toHaveLength(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(source.text);
    service.onModuleDestroy();
    redis.disconnect();
  });
  it('reports ineligibility without conflating it with an AI decision or capacity failure', () => {
    const now = Date.now(),
      source = input(now);
    expect(prepareCommercialLlmOffer({ ...source, text: '' }, now)).toEqual({
      reason: 'empty_text',
    });
    expect(prepareCommercialLlmOffer({ ...source, text: 'a'.repeat(2501) }, now)).toEqual({
      reason: 'oversized_text',
    });
    expect(prepareCommercialLlmOffer({ ...source, eventAt: 'invalid' }, now)).toEqual({
      reason: 'invalid_event_time',
    });
    expect(
      prepareCommercialLlmOffer({ ...source, eventAt: new Date(now - 10_001).toISOString() }, now),
    ).toEqual({ reason: 'stale_event' });
    expect(
      prepareCommercialLlmOffer(
        { ...source, origin: { ...source.origin, sourceEventAtMs: now - 1 } },
        now,
      ),
    ).toEqual({ reason: 'invalid_origin' });
    expect(prepareCommercialLlmOffer(source, now).offer).toBeDefined();
  });
});
