import { ConfigService } from '@nestjs/config';
import { extractLogicalPhotoAlbumResult } from '../photo-duplicate/photo-attachment-extractor';

import {
  buildCommercialOcrDeleteBinding,
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  CommercialOcrDeleteGuardService,
  extractCommercialOcrDeleteSource,
  parseCommercialOcrDeleteBinding,
  type CommercialOcrPolicySettings,
} from './commercial-ocr-delete-guard.service';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from './commercial-ocr-decision-policy';

const sourceCreatedAt = '2026-08-12T08:00:00.000Z';
const controlExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
const ocrDeadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
const commercialPolicySettings: CommercialOcrPolicySettings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
};
const baseInput = {
  intentId: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  sourceMessageAt: new Date(sourceCreatedAt),
  botId: 'delete-bot',
};

describe('CommercialOcrDeleteGuardService', () => {
  it('builds and parses a versioned binding without retaining caption or photo ids', () => {
    const binding = bindingFor(messageRow());

    expect(parseCommercialOcrDeleteBinding({ commercialOcrBinding: binding })).toEqual(binding);
    expect(binding).toMatchObject({
      version: 4,
      policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
      ocrVersion: 'tesseract-rus-eng-v1',
      senderId: 'user-1',
      expectedImageCount: 2,
    });
    expect(binding.commercialPolicyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(binding)).not.toContain('photo-1');
    expect(JSON.stringify(binding)).not.toContain('Buy now');
    expect(JSON.stringify(binding)).not.toContain('BALANCED');
  });

  it.each([
    { commercialAdsFilterEnabled: false },
    { commercialAdsSensitivity: 'STRICT' as const },
    { commercialAdsWarnThreshold: 46 },
    { commercialAdsDeleteThreshold: 66 },
  ])('binds the delete intent to commercial policy fields: %o', (settingsOverride) => {
    const original = bindingFor(messageRow());
    const changed = bindingFor(messageRow(), settingsOverride);

    expect(changed.commercialPolicyDigest).not.toBe(original.commercialPolicyDigest);
  });

  it('rejects legacy bindings and bindings without a valid commercial policy digest', () => {
    const binding = bindingFor(messageRow());

    expect(parseCommercialOcrDeleteBinding({ ...binding, version: 1 })).toBeNull();
    expect(
      parseCommercialOcrDeleteBinding({ ...binding, commercialPolicyDigest: undefined }),
    ).toBeNull();
    expect(parseCommercialOcrDeleteBinding({ ...binding, commercialPolicyDigest: 'invalid' })).toBe(
      null,
    );
  });

  it('allows an OCR-only deletion only after fresh exact content and immunity checks', async () => {
    const harness = buildHarness();

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');

    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      scope: 'commercial_ocr_delete',
      nightModeTimezone: 'Europe/Moscow',
    });
  });

  it.each([
    {
      label: 'immunity is granted after intent creation',
      options: { immunityResult: 'granted' as const },
      code: 'commercial_ocr_participant_immune',
    },
    {
      label: 'immunity cannot be checked',
      options: { immunityError: new Error('db down') },
      code: 'commercial_ocr_participant_immunity_unknown',
    },
  ])('blocks dispatch when $label', async ({ options, code }) => {
    const harness = buildHarness(options);

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code,
    });
  });

  it('rejects changed caption, photo order, author or source timestamp', async () => {
    for (const exactRow of [
      messageRow({ caption: 'Changed text' }),
      messageRow({ photoIds: ['photo-2', 'photo-1'] }),
      messageRow({ senderId: 'user-2' }),
      messageRow({ timestamp: '2026-08-12T08:00:01.000Z' }),
    ]) {
      const harness = buildHarness({ exactRow });
      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'commercial_ocr_message_changed',
      });
    }
  });

  it('fails open when the exact message has only URL-derived image identity', async () => {
    const exactRow = messageRow();
    const attachments = (exactRow.body as { attachments: Array<Record<string, unknown>> })
      .attachments;
    attachments[0] = {
      type: 'image',
      payload: { url: 'https://i.oneme.ru/no-stable-photo-id' },
    };
    const harness = buildHarness({ exactRow });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_message_ambiguous',
    });
  });

  it.each([
    {
      label: 'rollout authorization is revoked',
      config: { COMMERCIAL_OCR_ROLLOUT_MODE: 'off' },
      code: 'commercial_ocr_runtime_revoked',
    },
    {
      label: 'OCR behavior version changed',
      config: { COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2' },
      code: 'commercial_ocr_version_changed',
    },
  ])('rejects when $label', async ({ config, code }) => {
    const harness = buildHarness({ config });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code,
    });
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('keeps a transient runtime-control read failure retryable', async () => {
    const harness = buildHarness({ runtimeEnforcementAuthority: 'unavailable' });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_runtime_control_unavailable',
    });
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('rejects after filter disable or a fresh local/remote admin result', async () => {
    const disabled = buildHarness({ filterEnabled: false });
    await expect(disabled.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_filter_disabled',
    });

    const localAdmin = buildHarness({ adminUserIds: ['user-1'] });
    await expect(localAdmin.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_admin_immune',
    });

    const remoteAdmin = buildHarness({
      remoteAccess: { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
    });
    await expect(remoteAdmin.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_admin_immune',
    });
  });

  it.each([
    { commercialAdsSensitivity: 'STRICT' as const },
    { commercialAdsWarnThreshold: 46 },
    { commercialAdsDeleteThreshold: 66 },
  ])('rejects a fresh commercial policy change before MAX calls: %o', async (settingsOverride) => {
    const harness = buildHarness({ settingsOverride });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_policy_changed',
    });
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('keeps validating its durable OCR binding when an independent reason is attached', async () => {
    const harness = buildHarness({ independentReason: true });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
  });

  it('reports exact message absence without treating arbitrary lookup errors as absence', async () => {
    const absent = buildHarness({ exactRow: null });
    await expect(absent.service.assertIntentStillActionable(baseInput)).resolves.toBe('absent');

    const lookupError = buildHarness();
    lookupError.maxClient.getExactMessageRow.mockRejectedValueOnce(new Error('transport failed'));
    await expect(lookupError.service.assertIntentStillActionable(baseInput)).rejects.toThrow(
      'transport failed',
    );
  });
});

describe('extractCommercialOcrDeleteSource', () => {
  it('extracts exact message identity, direct caption and ordered stable photos', () => {
    expect(extractCommercialOcrDeleteSource(messageRow())).toEqual({
      messageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceCreatedAt,
      caption: 'Buy now',
      orderedPhotoIds: ['photo-1', 'photo-2'],
    });
  });

  it('uses canonical legacy and nested forward content while excluding reply previews', () => {
    const row = messageRow({ caption: 'Current offer', photoIds: ['photo-1'] });
    Object.assign(row, {
      link: {
        type: 'forward',
        message: {
          body: {
            text: 'Modern forward',
            attachments: [{ type: 'image', payload: { photo_id: 'photo-modern' } }],
            forwarded_message: {
              content: {
                caption: 'Nested forward',
                attachments: [{ type: 'image', payload: { photo_id: 'photo-nested' } }],
              },
            },
          },
        },
      },
      content: {
        forwarded_messages: [
          {
            body: {
              text: 'Legacy forward',
              attachments: [{ type: 'image', payload: { photo_id: 'photo-legacy' } }],
            },
          },
          {
            type: 'reply',
            text: 'Hidden reply',
            attachments: [{ type: 'image', payload: { photo_id: 'photo-reply' } }],
          },
        ],
      },
    });

    expect(extractCommercialOcrDeleteSource(row)).toEqual({
      messageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceCreatedAt,
      caption: 'Current offer Modern forward Nested forward Legacy forward',
      orderedPhotoIds: ['photo-1', 'photo-modern', 'photo-nested', 'photo-legacy'],
    });
  });

  it('matches canonical webhook album content for the same raw message', () => {
    const row = messageRow({ caption: 'Current offer', photoIds: ['photo-1'] });
    Object.assign(row.body as Record<string, unknown>, {
      forwarded_message: {
        body: {
          text: 'Legacy forward',
          attachments: [{ type: 'image', payload: { photo_id: 'photo-forward' } }],
        },
      },
    });
    const update = {
      updateId: 'update-parity-1',
      type: 'message_created',
      message: {
        messageId: 'message-1',
        chatId: 'chat-1',
        senderId: 'user-1',
        text: 'Current offer Legacy forward',
        createdAt: sourceCreatedAt,
      },
      raw: { update_type: 'message_created', message: row },
    } as const;
    const album = extractLogicalPhotoAlbumResult(update);
    const source = extractCommercialOcrDeleteSource(row);

    expect(album.kind).toBe('complete');
    expect(source).not.toBeNull();
    if (album.kind !== 'complete' || !source) {
      throw new Error('Canonical extraction fixture is incomplete');
    }
    expect({
      caption: album.album.caption,
      photoIds: album.album.images.map((image) => image.photoId),
    }).toEqual({ caption: source.caption, photoIds: source.orderedPhotoIds });
  });
});

function buildHarness(
  options: {
    exactRow?: Record<string, unknown> | null;
    independentReason?: boolean;
    filterEnabled?: boolean;
    adminUserIds?: string[];
    remoteAccess?: {
      userId: string | null;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    } | null;
    config?: Record<string, unknown>;
    settingsOverride?: Partial<typeof commercialPolicySettings>;
    immunityResult?: 'granted' | 'not_granted';
    immunityError?: Error;
    runtimeEnforcementAuthority?: 'authorized' | 'revoked' | 'unavailable';
  } = {},
) {
  const exactRow = options.exactRow === undefined ? messageRow() : options.exactRow;
  const binding = bindingFor(messageRow());
  const prisma = {
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([
        {
          ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
          metadata: { commercialOcrBinding: binding },
        },
        ...(options.independentReason ? [{ ruleCode: 'BLOCKED_WORD_DELETE', metadata: null }] : []),
      ]),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue({
        ...commercialPolicySettings,
        ...options.settingsOverride,
        commercialAdsFilterEnabled:
          options.filterEnabled ??
          options.settingsOverride?.commercialAdsFilterEnabled ??
          commercialPolicySettings.commercialAdsFilterEnabled,
        nightModeTimezone: 'Europe/Moscow',
        chat: {
          admins: (options.adminUserIds ?? []).map((userId) => ({ userId })),
        },
      }),
    },
  };
  const maxClient = {
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue(
        options.remoteAccess === undefined
          ? { userId: 'user-1', isAdmin: false, isOwner: false, permissions: [] }
          : options.remoteAccess,
      ),
    getExactMessageRow: jest.fn().mockResolvedValue(exactRow),
  };
  const maxBotLinkService = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const participantImmunity = {
    consumeForMessage: jest.fn().mockImplementation(async () => {
      if (options.immunityError) {
        throw options.immunityError;
      }
      return options.immunityResult ?? 'not_granted';
    }),
  };
  const runtimePolicy = {
    resolveEffectivePolicy: jest.fn().mockImplementation(async () => {
      const envEnabled = options.config?.COMMERCIAL_OCR_ROLLOUT_MODE !== 'off';
      const enforcementAuthority =
        options.runtimeEnforcementAuthority ?? (envEnabled ? 'authorized' : 'revoked');
      const enforce = envEnabled && enforcementAuthority === 'authorized';
      return {
        mode: enforce ? (options.config?.COMMERCIAL_OCR_ROLLOUT_MODE ?? 'on') : 'shadow',
        process: envEnabled,
        enforce,
        controlRevision: enforce ? 1 : null,
        controlExpiresAt: enforce ? controlExpiresAt : null,
        enforcementAuthority,
      };
    }),
  };
  const service = new CommercialOcrDeleteGuardService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
    new ConfigService({
      COMMERCIAL_OCR_ROLLOUT_MODE: 'on',
      COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v1',
      ...options.config,
    }),
    participantImmunity as never,
    runtimePolicy as never,
  );
  return {
    service,
    prisma,
    maxClient,
    maxBotLinkService,
    participantImmunity,
    runtimePolicy,
  };
}

function bindingFor(
  row: Record<string, unknown>,
  settingsOverride: Partial<typeof commercialPolicySettings> = {},
) {
  const source = extractCommercialOcrDeleteSource(row);
  if (!source) {
    throw new Error('Fixture did not produce a commercial OCR source');
  }
  return buildCommercialOcrDeleteBinding({
    ocrVersion: 'tesseract-rus-eng-v1',
    settings: { ...commercialPolicySettings, ...settingsOverride },
    senderId: source.senderId,
    orderedPhotoIds: source.orderedPhotoIds,
    caption: source.caption,
    sourceCreatedAt: source.sourceCreatedAt,
    expectedImageCount: source.orderedPhotoIds.length,
    controlRevision: 1,
    controlExpiresAt,
    ocrDeadlineAt,
  });
}

function messageRow(
  options: {
    caption?: string;
    photoIds?: string[];
    senderId?: string;
    timestamp?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: options.timestamp ?? sourceCreatedAt,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: options.senderId ?? 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: options.caption ?? 'Buy now',
      attachments: (options.photoIds ?? ['photo-1', 'photo-2']).map((photoId) => ({
        type: 'image',
        payload: { photo_id: photoId, url: `https://i.oneme.ru/${photoId}` },
      })),
    },
  };
}
