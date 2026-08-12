import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';

import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import {
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  parseCommercialOcrDeleteBinding,
} from './commercial-ocr-delete-guard.service';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from './commercial-ocr-decision-policy';
import { CommercialOcrModerationService } from './commercial-ocr-moderation.service';
import { COMMERCIAL_OCR_JOB_SCHEMA_VERSION, type CommercialOcrJob } from './commercial-ocr.queue';

const sourceCreatedAt = '2026-08-12T08:00:00.000Z';
const jobId = 'commercial-image-ocr__fixture';

type AnalysisFixture =
  | {
      kind: 'complete';
      decision: {
        action: 'DELETE' | 'NO_ACTION';
        reasonCodes: string[];
      };
    }
  | {
      kind: 'incomplete';
      reason: string;
      imageIndex?: number;
      pass?: 'primary' | 'confirmation';
    }
  | { kind: 'retry'; reason: 'download_failed' | 'ocr_failed' };

type AccessFixture = {
  userId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

type HarnessOptions = {
  mode?: 'on' | 'shadow';
  normalizedUpdate?: MaxUpdate;
  exactRows?: Array<Record<string, unknown> | null>;
  analysis?: AnalysisFixture;
  latches?: boolean[];
  admissionStates?: Array<'pending' | 'actionable' | 'observation'>;
  finalSettings?: ChatSettings;
  initialAdminUserIds?: string[];
  finalAdminUserIds?: string[];
  accessRows?: AccessFixture[];
  immunityResult?: 'granted' | 'not_granted';
  immunityError?: Error;
};

describe('CommercialOcrModerationService', () => {
  it.each([
    {
      label: 'normalized source identity mismatch',
      options: { normalizedUpdate: update({ messageId: 'other-message' }) },
    },
    {
      label: 'incomplete normalized photo identity',
      options: { normalizedUpdate: update({ incompleteAttachment: true }) },
    },
    {
      label: 'exact source photo mismatch',
      options: { exactRows: [exactMessage({ photoId: 'other-photo' })] },
    },
    {
      label: 'incomplete exact stable photo identity',
      options: { exactRows: [exactMessage({ photoId: null })] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'fails open on $label',
    async ({ options }) => {
      const harness = buildHarness(options);

      await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(harness.moderationDeleteIntents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'safe no-action decision',
      analysis: {
        kind: 'complete',
        decision: { action: 'NO_ACTION', reasonCodes: ['caption-safe-context:job_offer'] },
      },
    },
    {
      label: 'incomplete OCR analysis',
      analysis: { kind: 'incomplete', reason: 'ocr_failed' },
    },
  ] satisfies Array<{ label: string; analysis: AnalysisFixture }>)(
    'does not create an intent for $label',
    async ({ analysis }) => {
      const harness = buildHarness({ analysis });

      await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(harness.moderationDeleteIntents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it('runs shadow analysis without claiming or creating a delete intent', async () => {
    const harness = buildHarness({ mode: 'shadow', admissionStates: ['observation'] });

    await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
      kind: 'completed',
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
    expect(harness.moderationDeleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('logs completed decisions at info level with privacy-safe structured fields only', async () => {
    const harness = buildHarness({
      mode: 'shadow',
      admissionStates: ['observation'],
      analysis: {
        kind: 'complete',
        decision: {
          action: 'NO_ACTION',
          reasonCodes: ['image-safe-context:0:request_or_recommendation'],
        },
      },
    });
    const log = jest.spyOn((harness.service as any).logger, 'log').mockImplementation(() => {});

    await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
      kind: 'completed',
    });

    expect(log).toHaveBeenCalledWith(
      {
        chatId: 'chat-1',
        messageId: 'message-1',
        imageCount: 1,
        rolloutMode: 'shadow',
        action: 'NO_ACTION',
        reasonCodes: ['image-safe-context:0:request_or_recommendation'],
      },
      'Commercial OCR decision completed',
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Buy now|photo-1|i\.oneme\.ru/u);
  });

  it('logs incomplete analysis coverage without OCR text or source media', async () => {
    const harness = buildHarness({
      mode: 'shadow',
      admissionStates: ['observation'],
      analysis: {
        kind: 'incomplete',
        reason: 'ocr_truncated',
        imageIndex: 0,
        pass: 'primary',
      },
    });
    const log = jest.spyOn((harness.service as any).logger, 'log').mockImplementation(() => {});

    await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
      kind: 'completed',
    });

    expect(log).toHaveBeenCalledWith(
      {
        chatId: 'chat-1',
        messageId: 'message-1',
        imageCount: 1,
        rolloutMode: 'shadow',
        outcome: 'INCOMPLETE',
        reason: 'ocr_truncated',
        imageIndex: 0,
        pass: 'primary',
      },
      'Commercial OCR analysis incomplete',
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Buy now|photo-1|i\.oneme\.ru/u);
  });

  it('defers without loading the source while action admission is pending', async () => {
    const harness = buildHarness({ admissionStates: ['pending'] });

    await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
      kind: 'defer',
      delayMs: 5_000,
      reason: 'admission_pending',
    });
    expect(harness.prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
  });

  it.each(['download_failed', 'ocr_failed'] as const)(
    'propagates transient analysis failure %s to the queue processor',
    async (reason) => {
      const harness = buildHarness({ analysis: { kind: 'retry', reason } });

      await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
        kind: 'retry',
        reason,
      });
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(harness.moderationDeleteIntents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'absorbing admission latch is lowered immediately before action',
      options: { latches: [true, true, false] },
    },
    {
      label: 'commercial settings change after analysis',
      options: { finalSettings: settings({ commercialAdsWarnThreshold: 46 }) },
    },
    {
      label: 'exact source changes after analysis',
      options: {
        exactRows: [exactMessage(), exactMessage({ caption: 'Edited after analysis' })],
      },
    },
    {
      label: 'author becomes a remote administrator after analysis',
      options: {
        accessRows: [nonAdminAccess(), { ...nonAdminAccess(), isAdmin: true }],
      },
    },
    {
      label: 'author becomes a local administrator after analysis',
      options: { finalAdminUserIds: ['user-1'] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'rechecks final authorization when $label',
    async ({ options }) => {
      const harness = buildHarness(options);

      await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(harness.moderationDeleteIntents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'participant immunity is granted', options: { immunityResult: 'granted' as const } },
    {
      label: 'participant immunity lookup fails',
      options: { immunityError: new Error('db down') },
    },
  ])('fails open before action ownership when $label', async ({ options }) => {
    const harness = buildHarness(options);

    await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
      kind: 'completed',
    });

    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      scope: 'commercial_ocr_delete',
      nightModeTimezone: 'Europe/Moscow',
    });
    expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
    expect(harness.moderationDeleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('durably claims the message before creating an intent with binding-only metadata', async () => {
    const harness = buildHarness();

    await expect(harness.service.processCommercialOcrJob(job(), jobId)).resolves.toEqual({
      kind: 'completed',
    });

    expect(harness.prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'message-1',
          userId: 'user-1',
          ruleCode: 'COMMERCIAL_OCR_MESSAGE_ACTION',
          updateType: 'message_action',
        }),
      ],
      skipDuplicates: true,
    });
    expect(harness.moderationDeleteIntents.ensureIntent).toHaveBeenCalledTimes(1);
    expect(harness.participantImmunity.consumeForMessage.mock.invocationCallOrder[0]).toBeLessThan(
      harness.prisma.moderationViolationMessageClaim.createMany.mock.invocationCallOrder[0]!,
    );
    expect(
      harness.prisma.moderationViolationMessageClaim.createMany.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.moderationDeleteIntents.ensureIntent.mock.invocationCallOrder[0]!);

    const intent = harness.moderationDeleteIntents.ensureIntent.mock.calls[0]![0];
    expect(intent).toMatchObject({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: `commercial-ocr-delete:${jobId}`,
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: 'user-1',
      sourceMessageAt: sourceCreatedAt,
      originBotId: 'execution-bot',
      routingPolicy: 'delete_capable',
      event: { userId: 'user-1', eventType: 'MESSAGE', score: 1 },
    });
    expect(Object.keys(intent.event.metadata)).toEqual(['commercialOcrBinding']);
    const binding = parseCommercialOcrDeleteBinding(intent.event.metadata);
    expect(binding).toMatchObject({
      version: 2,
      policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
      ocrVersion: 'tesseract-rus-eng-v1',
      senderId: 'user-1',
      expectedImageCount: 1,
    });
    expect(JSON.stringify(intent.event.metadata)).not.toContain('Buy now');
    expect(JSON.stringify(intent.event.metadata)).not.toContain('photo-1');
    expect(JSON.stringify(intent.event.metadata)).not.toContain('BALANCED');
  });
});

function buildHarness(options: HarnessOptions = {}) {
  const initialSettings = settings();
  const finalSettings = options.finalSettings ?? initialSettings;
  const normalizedUpdate = options.normalizedUpdate ?? update();
  const exactRows = options.exactRows ?? [exactMessage(), exactMessage()];
  const accessRows = options.accessRows ?? [nonAdminAccess(), nonAdminAccess()];
  const admissionStates =
    options.admissionStates ??
    (options.latches ?? [true, true, true]).map((eligible) =>
      eligible ? ('actionable' as const) : ('observation' as const),
    );
  let exactRowIndex = 0;
  let accessRowIndex = 0;
  let latchIndex = 0;

  const prisma = {
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue({
        botId: 'webhook-bot',
        status: WebhookStatus.PROCESSED,
        nextEnqueueAt: null,
        normalizedPayload: normalizedUpdate,
        executionClaims: [{ executionBotId: 'execution-bot' }],
      }),
    },
    chat: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: initialSettings,
          admins: (options.initialAdminUserIds ?? []).map((userId) => ({ userId })),
        })
        .mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: finalSettings,
          admins: (options.finalAdminUserIds ?? []).map((userId) => ({ userId })),
        }),
    },
    moderationViolationMessageClaim: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
  };
  const analysisService = {
    analyzeAlbum: jest.fn().mockResolvedValue(options.analysis ?? deleteAnalysis()),
  };
  const admissionStore = {
    resolveState: jest.fn().mockImplementation(async () => {
      const state = readSequence(admissionStates, latchIndex);
      latchIndex += 1;
      return { kind: 'available', state };
    }),
  };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'run' }) };
  const maxClient = {
    getExactMessageRow: jest.fn().mockImplementation(async () => {
      const row = readSequence(exactRows, exactRowIndex);
      exactRowIndex += 1;
      return row;
    }),
    getChatMemberAccess: jest.fn().mockImplementation(async () => {
      const access = readSequence(accessRows, accessRowIndex);
      accessRowIndex += 1;
      return access;
    }),
  };
  const maxBotContextService = {
    runWithBot: jest.fn(async (_botId: string, operation: () => Promise<unknown>) => operation()),
  };
  const maxBotLinkService = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
    getDefaultBotId: jest.fn().mockReturnValue('default-bot'),
  };
  const participantImmunity = {
    consumeForMessage: jest.fn().mockImplementation(async () => {
      if (options.immunityError) {
        throw options.immunityError;
      }
      return options.immunityResult ?? 'not_granted';
    }),
  };
  const moderationDeleteIntents = {
    getRolloutForRule: jest.fn().mockReturnValue('execute'),
    ensureIntent: jest.fn().mockResolvedValue({}),
  };
  const configService = new ConfigService({
    COMMERCIAL_OCR_ROLLOUT_MODE: options.mode ?? 'on',
  });
  const service = new CommercialOcrModerationService(
    prisma as never,
    analysisService as never,
    admissionStore as never,
    governor as never,
    maxClient as never,
    maxBotContextService as never,
    maxBotLinkService as never,
    participantImmunity as never,
    moderationDeleteIntents as never,
    configService,
  );

  return {
    service,
    prisma,
    analysisService,
    admissionStore,
    maxClient,
    participantImmunity,
    moderationDeleteIntents,
  };
}

function job(): CommercialOcrJob {
  return {
    webhookEventId: 'webhook-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    sourceCreatedAt,
    imageCount: 1,
    schemaVersion: COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
    ocrVersion: 'tesseract-rus-eng-v1',
    actionEligible: true,
    idempotencyKey: jobId,
    sourceTag: 'commercial-image-ocr',
    createdAt: sourceCreatedAt,
  };
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    nightModeTimezone: 'Europe/Moscow',
    ...overrides,
  } as ChatSettings;
}

function update(options: { messageId?: string; incompleteAttachment?: boolean } = {}): MaxUpdate {
  const messageId = options.messageId ?? 'message-1';
  const attachment = options.incompleteAttachment
    ? { type: 'image', payload: {} }
    : photoAttachment('photo-1');
  return {
    updateId: 'update-1',
    botId: 'payload-bot',
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'User One',
      text: 'Buy now',
      createdAt: sourceCreatedAt,
    },
    raw: {
      message: {
        id: messageId,
        timestamp: sourceCreatedAt,
        recipient: { chat_id: 'chat-1' },
        sender: { user_id: 'user-1', is_bot: false },
        body: { mid: messageId, text: 'Buy now', attachments: [attachment] },
      },
    },
  };
}

function exactMessage(
  options: { photoId?: string | null; caption?: string } = {},
): Record<string, unknown> {
  const photoId = options.photoId === undefined ? 'photo-1' : options.photoId;
  return {
    id: 'message-1',
    timestamp: sourceCreatedAt,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: options.caption ?? 'Buy now',
      attachments: [
        {
          type: 'image',
          payload: {
            ...(photoId === null ? {} : { photo_id: photoId }),
            url: 'https://i.oneme.ru/photo-1',
          },
        },
      ],
    },
  };
}

function photoAttachment(photoId: string) {
  return {
    type: 'image',
    payload: {
      photo_id: photoId,
      url: `https://i.oneme.ru/${photoId}`,
    },
  };
}

function nonAdminAccess(): AccessFixture {
  return {
    userId: 'user-1',
    isAdmin: false,
    isOwner: false,
    permissions: [],
  };
}

function deleteAnalysis(): AnalysisFixture {
  return {
    kind: 'complete',
    decision: { action: 'DELETE', reasonCodes: ['image-independent-two-pass-delete'] },
  };
}

function readSequence<T>(values: readonly T[], index: number): T {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) {
    throw new Error('Fixture sequence is empty');
  }
  return value;
}
