import { ConfigService } from '@nestjs/config';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateSettingsDigest,
  messageDuplicateSanctionSettingsDigest,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';

function setup() {
  const update = duplicateUpdate();
  const settings = {
    ...duplicateSettings(),
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const content = extractDuplicateMessageContent(update.raw);
  const binding: MessageDuplicateBinding = {
    version: 1,
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
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const photos = {
    resolveEffectivePolicy: jest.fn().mockResolvedValue({
      enforce: true,
      allowedMatchKinds: ['canonical_sha256'],
      controlRevision: 1,
    }),
  };
  const history = { stillMatches: jest.fn().mockResolvedValue(true) };
  const service = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    photos as never,
    policy as never,
    history as never,
    new ConfigService(),
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
  };
}

describe('message duplicate final delete guard', () => {
  it('allows a renewed photo URL with verified content, but rejects a replacement photo', async () => {
    const s = setup();
    s.binding.version = 2;
    s.binding.hasPhotos = true;
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
    s.binding.sourceDigest = content.sourceDigest;
    s.binding.contentDigest = buildMessageDuplicateIdentity(
      content,
      'MESSAGE',
      s.binding.mediaHashes,
    )!;
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
    s.binding.version = 2;
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
