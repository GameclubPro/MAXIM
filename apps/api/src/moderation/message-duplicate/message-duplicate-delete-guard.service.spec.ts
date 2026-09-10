import { ConfigService } from '@nestjs/config';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateSettingsDigest,
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
