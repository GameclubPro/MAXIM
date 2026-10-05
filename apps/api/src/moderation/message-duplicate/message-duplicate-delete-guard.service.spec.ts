import { ConfigService } from '@nestjs/config';
import {
  MessageDuplicateDeleteGuardService,
  MessageDuplicateGuardRejectedError,
} from './message-duplicate-delete-guard.service';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  extractDuplicateMessageContent,
  exactImageSourceDigest,
} from './message-duplicate-content';
import { duplicateSourceDigest } from './message-duplicate-history.service';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
  messageDuplicateSanctionSettingsDigest,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import {
  duplicateSettings,
  duplicateUpdate,
  preUnicodeNearSettingsDigests,
  preSafeTextSettingsDigests,
  preBoundedPhoneSettingsDigests,
  prePhoneBoundarySettingsDigests,
  preSourceBoundPhoneSettingsDigests,
} from './message-duplicate-test-fixtures';

function setup() {
  const update = duplicateUpdate();
  const settings = {
    ...duplicateSettings(),
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const content = extractDuplicateMessageContent(update.raw);
  const binding: MessageDuplicateBinding = {
    version: 3,
    enforcementScope: 'delete_only',
    lifecycleRevision: 'd'.repeat(64),
    policyRevision: settings.duplicatePolicyRevision,
    authorization: {
      eventTimestampMs: Date.parse(update.message!.createdAt),
      deadlineAtMs: Date.parse(update.message!.createdAt) + 600_000,
    },
    senderId: '123',
    messageId: 'm2',
    eventTimestampMs: Date.parse(update.message!.createdAt),
    controlRevision: 1,
    settingsDigest: messageDuplicateSettingsDigest(settings),
    sourceDigest: content.sourceDigest,
    contentDigest: buildMessageDuplicateIdentity(content, 'MESSAGE')!,
    fingerprint: 'b'.repeat(64),
    compareMode: 'MESSAGE',
    mediaHashes: [],
    mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
    hasPhotos: false,
    photoControlRevision: null,
    windowSeconds: 3600,
    requiredCount: 2,
  };
  binding.original = {
    member: digestDuplicateContent('m1'),
    author: digestDuplicateContent('123'),
    messageId: 'm1',
    senderId: '123',
    publishedAtMs: binding.eventTimestampMs - 1000,
    observedAtMs: binding.eventTimestampMs - 1000,
    expiresAtMs: binding.eventTimestampMs + 3599000,
    sourceDigest: binding.sourceDigest,
    contentDigest: binding.contentDigest,
    mediaHashes: [],
    epoch: 0,
    revision: 'e'.repeat(64),
    originalId: 'f'.repeat(64),
  };
  const policy = {
    resolve: jest.fn().mockResolvedValue({
      mode: 'delete_only',
      revision: 1,
      effectiveAtMs: Date.now() - 10000,
      expiresAtMs: Date.now() + 3600000,
    }),
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    moderationDeleteIntent: { findUnique: jest.fn().mockResolvedValue(null) },
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([
        {
          reasonKey: 'MESSAGE_DUPLICATE:v1',
          ruleCode: 'DUPLICATE_DELETE',
          metadata: { duplicateSource: 'message_v1', messageDuplicate: binding },
        },
      ]),
    },
  };
  const max = {
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ userId: '123', isAdmin: false, isOwner: false }),
    getExactMessageRow: jest.fn().mockResolvedValue((update.raw as { message: unknown }).message),
  };
  const targetLookup = max.getExactMessageRow;
  const originalUpdate = duplicateUpdate('m1', binding.original.publishedAtMs);
  const originalRaw = (originalUpdate.raw as { message: unknown }).message;
  const originalLookup = jest.fn(async () => originalRaw);
  const guardedMax = {
    ...max,
    getExactMessageRow: async (chatId: string, messageId: string, options: unknown) =>
      messageId === 'm1'
        ? originalLookup()
        : (targetLookup as (...args: unknown[]) => Promise<unknown>)(chatId, messageId, options),
  };
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const photos = {
    resolveEffectivePolicy: jest.fn().mockResolvedValue({
      enforce: true,
      allowedMatchKinds: ['canonical_sha256'],
      controlRevision: 1,
    }),
  };
  const history = {
    stillMatches: jest.fn().mockResolvedValue(true),
    remove: jest.fn(),
    observeLifecycle: jest.fn(),
    invalidateLifecycle: jest.fn(),
    qualified: jest.fn().mockResolvedValue(null),
    qualify: jest.fn().mockResolvedValue(1),
  };
  const authorization = { isAllowed: jest.fn().mockResolvedValue(true) };
  const metrics = { record: jest.fn(), recordGuardRejection: jest.fn() };
  const service = new MessageDuplicateDeleteGuardService(
    prisma as never,
    guardedMax as never,
    bots as never,
    immunity as never,
    policy as never,
    history as never,
    new ConfigService(),
    authorization as never,
    metrics as never,
  );
  const params = {
    intentId: 'intent',
    chatId: '-123',
    messageId: 'm2',
    subjectUserId: '123',
    botId: 'bot',
  };
  return {
    service,
    originalRaw,
    originalLookup,
    binding,
    params,
    settings,
    policy,
    prisma,
    max,
    bots,
    immunity,
    photos,
    history,
    authorization,
    metrics,
  };
}

describe('scheduled duplicate final action guard', () => {
  it('rechecks the end boundary after external calls', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T14:59Z'));
    try {
      const s = setup();
      s.settings.duplicateWindowMode = 'DAILY';
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      s.binding.original!.expiresAtMs = Date.parse('2026-09-29T15:00Z');
      s.immunity.consumeForMessage.mockImplementation(async () => {
        clock.mockReturnValue(Date.parse('2026-09-29T15:00Z'));
        return 'not_granted';
      });
      await expect(
        s.service.assertMessageStillActionable({ ...s.params, binding: s.binding }),
      ).rejects.toMatchObject({ code: 'message_duplicate_schedule_closed' });
    } finally {
      clock.mockRestore();
    }
  });
  it('rejects queued decisions after changing the timezone', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T10:00Z'));
    try {
      const s = setup();
      s.settings.duplicateWindowMode = 'DAILY';
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      s.binding.original!.expiresAtMs = Date.parse('2026-09-29T15:00Z');
      s.settings.duplicateTimezone = 'Asia/Tokyo';
      await expect(
        s.service.assertMessageStillActionable({ ...s.params, binding: s.binding }),
      ).rejects.toMatchObject({ code: 'message_duplicate_settings_changed' });
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('message duplicate final delete guard', () => {
  it.each([
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)(
    'rejects previous %s grants before qualification and MAX dispatch',
    async (key, overrides) => {
      const s = setup();
      Object.assign(s.settings, overrides);
      for (const digests of [
        preSafeTextSettingsDigests,
        preBoundedPhoneSettingsDigests,
        prePhoneBoundarySettingsDigests,
        preSourceBoundPhoneSettingsDigests,
      ]) {
        s.binding.settingsDigest = digests[key];
        await expect(
          s.service.assertQualificationAuthority(s.params.chatId, s.binding),
        ).rejects.toMatchObject({
          code: 'message_duplicate_settings_changed',
        });
        for (const authorityOnly of [false, true]) {
          await expect(
            s.service.assertIntentStillActionable({ ...s.params, authorityOnly }),
          ).rejects.toMatchObject({
            code: 'message_duplicate_settings_changed',
          });
        }
      }
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it.each(['STRICT', 'CUSTOM'] as const)(
    'rejects stored pre-Unicode %s grants at both dispatch boundaries',
    async (preset) => {
      const s = setup();
      s.settings.duplicateDetectionPreset = preset;
      s.settings.duplicateNearMatchEnabled = true;
      s.binding.settingsDigest = preUnicodeNearSettingsDigests[preset];
      for (const authorityOnly of [false, true]) {
        await expect(
          s.service.assertIntentStillActionable({ ...s.params, authorityOnly }),
        ).rejects.toMatchObject({
          code: 'message_duplicate_settings_changed',
        });
      }
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2] as const)('rejects legacy binding v%i before any MAX lookup', async (version) => {
    const s = setup();
    s.binding.version = version;
    delete s.binding.enforcementScope;
    delete s.binding.lifecycleRevision;
    delete s.binding.policyRevision;
    delete s.binding.original!.revision;
    delete s.binding.original!.originalId;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_binding_invalid',
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('blocks a persisted decision after its authorization is revoked', async () => {
    const s = setup();
    s.authorization.isAllowed.mockResolvedValue(false);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      /message_duplicate_/,
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('rechecks authorization after external content and participant checks', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockImplementation(async () => {
      s.authorization.isAllowed.mockResolvedValue(false);
      return (duplicateUpdate('m2', s.binding.eventTimestampMs).raw as { message: unknown })
        .message;
    });
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      /message_duplicate_/,
    );
    expect(s.authorization.isAllowed.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.history.stillMatches).toHaveBeenCalled();
  });

  it('rejects a returned settings value with a newer policy revision', async () => {
    const s = setup();
    s.settings.duplicatePolicyRevision += 2;
    expect(messageDuplicateSettingsDigest(s.settings)).toBe(s.binding.settingsDigest);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_settings_changed',
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('reuses a qualified stage only while its current authorization remains allowed', async () => {
    const s = setup();
    s.history.qualified.mockResolvedValue(1);
    const request = { ...s.params, binding: s.binding };
    await expect(s.service.qualify(request)).resolves.toBe(1);
    expect(s.history.qualify).not.toHaveBeenCalled();
    s.authorization.isAllowed.mockResolvedValue(false);
    await expect(s.service.qualify(request)).rejects.toThrow(/message_duplicate_/);
    expect(s.history.qualify).not.toHaveBeenCalled();
  });

  it('does not reserve a stage after revocation or policy changes during qualification', async () => {
    for (const change of ['authorization', 'settings', 'history']) {
      const s = setup();
      if (change === 'authorization') s.authorization.isAllowed.mockResolvedValue(false);
      if (change === 'settings') s.settings.duplicatePolicyRevision += 1;
      if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
      await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toThrow(
        /message_duplicate_/,
      );
      expect(s.history.qualify).not.toHaveBeenCalled();
    }
  });

  it('invalidates a changed original without inventing its edit timestamp', async () => {
    const s = setup();
    const original = s.originalRaw as { body: { text: string } };
    original.body.text = 'Changed remotely';
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_original_changed',
    );
    expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
      chatId: s.params.chatId,
      messageId: s.binding.original!.messageId,
      content: expect.objectContaining({ text: 'changed remotely' }),
    });
    expect(s.history.observeLifecycle).not.toHaveBeenCalled();
  });

  it.each(
    (['current', 'original'] as const).flatMap((stage) =>
      (['TEXT', 'MESSAGE'] as const).map((mode) => ({ stage, mode })),
    ),
  )(
    'revokes $mode evidence when the $stage hidden links swap visible ranges',
    async ({ stage, mode }) => {
      const s = setup();
      s.settings.duplicateCompareMode = mode;
      s.binding.compareMode = mode;
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      const linked = (messageId: string, swapped = false) => {
        const update = duplicateUpdate(messageId, s.binding.eventTimestampMs, 'Первый второй');
        const raw = (update.raw as { message: { body: Record<string, unknown> } }).message;
        raw.body.markup = [
          {
            type: 'link',
            from: 0,
            length: 6,
            url: `https://example.org/${swapped ? 'second' : 'first'}`,
          },
          {
            type: 'link',
            from: 7,
            length: 6,
            url: `https://example.org/${swapped ? 'first' : 'second'}`,
          },
        ];
        return update;
      };
      const recorded = linked('m2');
      const content = extractDuplicateMessageContent(recorded.raw);
      s.binding.sourceDigest = duplicateSourceDigest(content, mode);
      s.binding.contentDigest = buildMessageDuplicateIdentity(content, mode)!;
      Object.assign(s.binding.original!, {
        sourceDigest: s.binding.sourceDigest,
        contentDigest: s.binding.contentDigest,
      });
      s.max.getExactMessageRow.mockResolvedValue((recorded.raw as { message: unknown }).message);
      s.originalLookup.mockResolvedValue(
        (linked('m1').raw as { message: typeof s.originalRaw }).message,
      );
      await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');

      const changedUpdate = linked(stage === 'current' ? 'm2' : 'm1', true);
      const changedContent = extractDuplicateMessageContent(changedUpdate.raw);
      expect(changedContent.text).toBe(content.text);
      const targetSet = (value: typeof content) =>
        value.navigationTargets.map((target) => target.normalizedTarget).sort();
      expect(targetSet(changedContent)).toEqual(targetSet(content));
      const changed = (changedUpdate.raw as { message: typeof s.originalRaw }).message;
      if (stage === 'current') s.max.getExactMessageRow.mockResolvedValue(changed);
      else s.originalLookup.mockResolvedValue(changed);
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code:
          stage === 'current'
            ? 'message_duplicate_content_changed'
            : 'message_duplicate_original_changed',
      });
      expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
        chatId: s.params.chatId,
        messageId: stage === 'current' ? 'm2' : 'm1',
        content: expect.objectContaining({ text: content.text }),
      });
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
    },
  );

  it('rejects queued thumbnail-era evidence before any MAX lookup', async () => {
    const s = setup();
    Object.assign(s.binding, { mediaVersion: 'sha256-v1:sharp-rgb512-pdq-v2' });
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
      code: 'message_duplicate_binding_invalid',
    });
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('ends enforcement for a confirmed departed author without retrying or applying immunity', async () => {
    const s = setup();
    s.max.getChatMemberAccess.mockResolvedValue(null);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
      name: 'MessageDuplicateGuardRejectedError',
      code: 'message_duplicate_author_not_member',
    });
    expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
      '-123',
      '123',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(s.metrics.recordGuardRejection).toHaveBeenCalledWith(
      'message_duplicate_author_not_member',
    );
  });

  it.each(['transport', 'malformed', 'mismatched'])(
    'keeps %s author access failures retryable',
    async (kind) => {
      const s = setup();
      if (kind === 'mismatched')
        s.max.getChatMemberAccess.mockResolvedValue({
          userId: '456',
          isAdmin: false,
          isOwner: false,
        });
      else s.max.getChatMemberAccess.mockRejectedValue(new Error(kind));
      const failure = await s.service
        .assertIntentStillActionable(s.params)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(MessageDuplicateGuardRejectedError);
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('guard.unavailable');
      expect(s.metrics.recordGuardRejection).not.toHaveBeenCalled();
    },
  );

  it('still expires a duplicate at its own absolute enforcement deadline', async () => {
    const s = setup();
    s.binding.eventTimestampMs = Date.now() - 3_600_001;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_policy_changed',
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });
  it('does not execute delayed deletion after the original window expires', async () => {
    const s = setup();
    s.binding.original!.expiresAtMs = Date.now() - 1;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow('policy_changed');
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('rejects historical rolling-window intents that lack original evidence', async () => {
    const s = setup();
    delete s.binding.original;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'binding_invalid',
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('allows a renewed photo URL with verified content, but rejects a replacement photo', async () => {
    const s = setup();
    s.binding.enforcementScope = 'full';
    s.binding.hasPhotos = true;
    s.binding.compareMode = 'IMAGE';
    s.binding.imageScope = 'SAME_AUTHOR';
    s.binding.settingsDigest = exactImageSettingsDigest(s.settings);
    s.binding.mediaHashes = ['c'.repeat(64)];
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: Date.now() - 10000,
    });
    const image = (id: string, url: string) =>
      duplicateUpdate('m2', s.binding.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: id, url } },
      ]);
    const original = image('photo', 'https://i.oneme.ru/old');
    const content = extractDuplicateMessageContent(original.raw);
    s.binding.sourceDigest = exactImageSourceDigest(content);
    s.binding.contentDigest = buildMessageDuplicateIdentity(
      content,
      'IMAGE',
      s.binding.mediaHashes,
    )!;
    const originalImage = (original.raw as { message: Record<string, unknown> }).message;
    Object.assign(s.binding.original!, {
      sourceDigest: s.binding.sourceDigest,
      contentDigest: s.binding.contentDigest,
      mediaHashes: s.binding.mediaHashes,
    });
    Object.assign(s.originalRaw as object, originalImage, {
      body: { ...(originalImage.body as object), mid: 'm1' },
    });
    const renewed = image('photo', 'https://i.oneme.ru/new');
    s.max.getExactMessageRow.mockResolvedValue((renewed.raw as { message: unknown }).message);
    await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');
    expect(s.photos.resolveEffectivePolicy).not.toHaveBeenCalled();
    const replaced = image('different', 'https://i.oneme.ru/new');
    s.max.getExactMessageRow.mockResolvedValue((replaced.raw as { message: unknown }).message);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'content_changed',
    );
  });

  it.each(
    (['current', 'original'] as const).flatMap((stage) =>
      (['link', 'callback'] as const).map((type) => ({ stage, type })),
    ),
  )(
    'revokes IMAGE evidence after the $stage keyboard $type action changes',
    async ({ stage, type }) => {
      const s = setup();
      s.settings.duplicatePhotoScope = 'SAME_AUTHOR';
      Object.assign(s.binding, {
        enforcementScope: 'full',
        hasPhotos: true,
        compareMode: 'IMAGE',
        imageScope: 'SAME_AUTHOR',
        settingsDigest: exactImageSettingsDigest(s.settings),
        mediaHashes: ['c'.repeat(64)],
      });
      s.policy.resolve.mockResolvedValue({
        mode: 'full',
        revision: 1,
        effectiveAtMs: Date.now() - 10000,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      });
      const image = (messageId: string, action: string) =>
        duplicateUpdate(messageId, s.binding.eventTimestampMs, 'caption', [
          { type: 'image', payload: { photo_id: 'photo', url: 'https://i.oneme.ru/photo' } },
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [
                  {
                    type,
                    text: 'Open',
                    ...(type === 'link'
                      ? { url: `https://example.org/${action}` }
                      : { payload: action }),
                  },
                ],
              ],
            },
          },
        ]);
      const recorded = image('m2', 'recorded-action');
      const content = extractDuplicateMessageContent(recorded.raw);
      s.binding.sourceDigest = exactImageSourceDigest(content);
      s.binding.contentDigest = buildMessageDuplicateIdentity(
        content,
        'IMAGE',
        s.binding.mediaHashes,
      )!;
      Object.assign(s.binding.original!, {
        sourceDigest: s.binding.sourceDigest,
        contentDigest: s.binding.contentDigest,
        mediaHashes: s.binding.mediaHashes,
      });
      s.max.getExactMessageRow.mockResolvedValue((recorded.raw as { message: unknown }).message);
      s.originalLookup.mockResolvedValue(
        (image('m1', 'recorded-action').raw as { message: typeof s.originalRaw }).message,
      );
      await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');

      const changed = (
        image(stage === 'current' ? 'm2' : 'm1', 'new-action').raw as {
          message: typeof s.originalRaw;
        }
      ).message;
      if (stage === 'current') s.max.getExactMessageRow.mockResolvedValue(changed);
      else s.originalLookup.mockResolvedValue(changed);
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code:
          stage === 'current'
            ? 'message_duplicate_content_changed'
            : 'message_duplicate_original_changed',
      });
      expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
        chatId: s.params.chatId,
        messageId: stage === 'current' ? 'm2' : 'm1',
        content: expect.objectContaining({ complete: true, actions: expect.any(Array) }),
      });
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
    },
  );

  function full() {
    const s = setup();
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: Date.now() - 10000,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    s.settings.duplicateBanEnabled = true;
    s.settings.duplicateBanMaxCount = 1;
    s.binding.enforcementScope = 'full';
    s.binding.sanction = {
      action: 'BAN',
      repeatCount: 1,
      threshold: 1,
      settingsDigest: messageDuplicateSanctionSettingsDigest(s.settings),
    };
    s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
    return { ...s, request: { ...s.params, binding: s.binding, sanctionIntentId: 'intent' } };
  }
  it('allows configured full sanctions only after fresh source and policy checks', async () => {
    const s = full();
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    s.settings.duplicateBanEnabled = false;
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'settings_changed',
    );
  });
  it('rejects a sanction after a runtime downgrade, changed history, or participant immunity', async () => {
    for (const change of ['policy', 'history', 'immunity']) {
      const s = full();
      if (change === 'policy')
        s.policy.resolve.mockResolvedValue({
          mode: 'delete_only',
          revision: 1,
          effectiveAtMs: Date.now() - 10000,
        });
      if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
      if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow();
    }
  });
  it('requires our matching successful DELETE receipt when sanctioning an already removed duplicate', async () => {
    const s = full();
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
    const receipt = {
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          createdAt: new Date(Date.now() - 500),
          metadata: { duplicateSource: 'message_v1', messageDuplicate: { ...s.binding } },
        },
      ],
    };
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(receipt);
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    receipt.remoteDeleteSucceededAt = new Date(s.binding.eventTimestampMs - 1);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
    receipt.remoteDeleteSucceededAt = new Date();
    receipt.reasons[0]!.metadata.messageDuplicate.contentDigest = 'a'.repeat(64);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
  });

  it.each([
    { code: 'message.not.found' },
    { error: { code: 'message_not_found' } },
    { code: 'message.not_found' },
  ])(
    'recognizes structured current-message absence without authorizing a sanction (%j)',
    async (data) => {
      const s = full();
      const absent = { response: { status: 404, data } };
      s.max.getExactMessageRow.mockRejectedValue(absent);
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
        code: 'message_duplicate_unproven_absence',
      });
      expect(s.metrics.record).toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.unavailable');
      expect(s.originalLookup).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();

      await expect(
        s.service.assertMessageStillActionable({ ...s.request, sanctionIntentId: undefined }),
      ).resolves.toBe('absent');
    },
  );

  it('allows a sanction after structured absence only with our unchanged exact successful DELETE receipt', async () => {
    const s = full();
    s.max.getExactMessageRow.mockRejectedValue({
      response: { status: 404, data: { code: 'message.not.found' } },
    });
    const receipt = {
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          createdAt: new Date(Date.now() - 500),
          metadata: { duplicateSource: 'message_v1', messageDuplicate: { ...s.binding } },
        },
      ],
    };
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(receipt);
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    expect(s.originalLookup).toHaveBeenCalledTimes(1);
    receipt.reasons[0]!.metadata.messageDuplicate.contentDigest = 'a'.repeat(64);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
      code: 'message_duplicate_unproven_absence',
    });
  });

  it.each([
    { code: 'message.not.found' },
    { error: { code: 'message_not_found' } },
    { code: 'message.not_found' },
  ])(
    'tombstones a confirmed absent original without inventing a new publication (%j)',
    async (data) => {
      const s = setup();
      s.originalLookup.mockRejectedValue({ response: { status: 404, data } });
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code: 'message_duplicate_original_missing',
      });
      expect(s.history.remove).toHaveBeenCalledWith('-123', 'm1');
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('guard.original_lookup_confirmed_absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.unavailable');
    },
  );

  it.each(
    [
      ['bare 404', { response: { status: 404, data: {} } }],
      [
        'chat 404',
        {
          response: { status: 404, data: { code: 'chat.not.found', message: 'Message not found' } },
        },
      ],
      ['proxy text', { response: { status: 404, data: { message: 'Message not found' } } }],
      ['forbidden', { response: { status: 403, data: { code: 'message.not.found' } } }],
      ['server error', { response: { status: 500, data: { code: 'message.not.found' } } }],
      [
        'successful error payload',
        { response: { status: 200, data: { code: 'message.not.found' } } },
      ],
      ['malformed body', { response: { status: 404, data: [{ code: 'message.not.found' }] } }],
      ['transport', new Error('Private source unavailable https://secret.example')],
    ].flatMap(([reason, error]) =>
      (['current', 'original'] as const).map((stage) => ({ reason, error, stage })),
    ),
  )('preserves $stage evidence and retry for $reason', async ({ stage, error }) => {
    const s = setup();
    if (stage === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
    else s.originalLookup.mockRejectedValue(error);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toBe(error);
    expect(s.history.remove).not.toHaveBeenCalled();
    expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
    expect(s.metrics.record).toHaveBeenCalledWith(`guard.${stage}_lookup_unavailable`);
    expect(s.metrics.record).toHaveBeenCalledWith('guard.unavailable');
    expect(s.metrics.record).not.toHaveBeenCalledWith(`guard.${stage}_lookup_confirmed_absent`);
    expect(JSON.stringify(s.metrics.record.mock.calls)).not.toMatch(/secret|https/);
  });

  it('uses server receipt ordering instead of comparing the MAX clock with the database clock', async () => {
    const s = full();
    s.binding.eventTimestampMs = Date.now() + 1000;
    s.max.getExactMessageRow.mockResolvedValue(null);
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          createdAt: new Date(Date.now() - 500),
          metadata: { duplicateSource: 'message_v1', messageDuplicate: { ...s.binding } },
        },
      ],
    });
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
  });
  it('checks the current source, fresh policy twice, and read-only history before permitting delete', async () => {
    const s = setup();
    await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');
    expect(s.policy.resolve).toHaveBeenCalledTimes(2);
    expect(s.policy.resolve).toHaveBeenLastCalledWith('-123', true);
    expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(s.immunity.consumeForMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm2', scope: 'duplicate:v1' }),
    );
  });
  it.each([
    'policy',
    'settings',
    'admin',
    'owner',
    'bot',
    'immunity',
    'manual_release',
    'history',
    'edit',
    'sender',
    'photo',
  ])('rejects changed %s', async (change) => {
    const s = setup();
    if (change === 'policy') s.policy.resolve.mockResolvedValue({ mode: 'off' });
    if (change === 'settings') s.settings.antiDuplicateEnabled = false;
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({ userId: '123', isAdmin: true });
    if (change === 'owner')
      s.max.getChatMemberAccess.mockResolvedValue({ userId: '123', isOwner: true });
    if (change === 'bot') s.bots.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'manual_release')
      s.prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'release' });
    if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
    if (change === 'edit')
      s.max.getExactMessageRow.mockResolvedValue(
        (duplicateUpdate('m2', Date.now(), 'b').raw as { message: unknown }).message,
      );
    if (change === 'sender') s.params.subjectUserId = '456';
    if (change === 'photo') {
      s.binding.hasPhotos = true;
      s.binding.photoControlRevision = 2;
    }
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      /message_duplicate_/,
    );
  });
  it('does not confuse a missing exact row with a transport failure', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('absent');
    s.max.getExactMessageRow.mockRejectedValue(new Error('transport'));
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow('transport');
  });
  it('catches a control change during the MAX request', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockImplementation(async () => {
      s.policy.resolve.mockResolvedValue({ mode: 'off' });
      return (duplicateUpdate('m2').raw as { message: unknown }).message;
    });
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_policy_changed',
    );
  });
  it('does not bypass a malformed new binding because an independent guarded reason exists', async () => {
    const s = setup();
    s.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      {
        reasonKey: 'MESSAGE_DUPLICATE:v1',
        ruleCode: 'DUPLICATE_DELETE',
        metadata: { duplicateSource: 'message_v1' },
      },
      { reasonKey: 'LINK', ruleCode: 'LINK', metadata: {} },
    ]);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_binding_invalid',
    );
  });
});
