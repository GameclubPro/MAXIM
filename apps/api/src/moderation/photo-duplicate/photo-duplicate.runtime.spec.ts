import {
  capPhotoDuplicateAction,
  isPhotoDuplicateMatchKindAllowed,
  resolvePhotoDuplicateAllowedMatchKinds,
  resolvePhotoDuplicateMaxAction,
  resolvePhotoDuplicateRolloutMode,
  resolvePhotoDuplicateRuntimePolicy,
} from './photo-duplicate.runtime';

function config(values: Record<string, string | undefined>) {
  return {
    get: (key: string) => values[key],
  };
}

describe('photo duplicate runtime policy', () => {
  it('defaults to non-mutating shadow mode', () => {
    expect(resolvePhotoDuplicateRolloutMode(config({}))).toBe('shadow');
    expect(
      resolvePhotoDuplicateRuntimePolicy({
        chatId: 'chat-1',
        preset: 'SAME_IMAGE',
        scope: 'SAME_AUTHOR',
        configService: config({}),
      }),
    ).toEqual({
      mode: 'shadow',
      enforce: false,
      advancedCanary: false,
      allowedMatchKinds: ['canonical_sha256'],
      maxAction: 'DELETE_MESSAGE',
    });
  });

  it('requires an explicit chat enforcement allowlist', () => {
    const configService = config({
      PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
      PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-2',
    });
    expect(
      resolvePhotoDuplicateRuntimePolicy({
        chatId: 'chat-1',
        preset: 'SAME_IMAGE',
        scope: 'SAME_AUTHOR',
        configService,
      }).enforce,
    ).toBe(false);
    expect(
      resolvePhotoDuplicateRuntimePolicy({
        chatId: 'chat-2',
        preset: 'SAME_IMAGE',
        scope: 'SAME_AUTHOR',
        configService,
      }).enforce,
    ).toBe(true);
  });

  it('keeps advanced modes in shadow outside their explicit canary', () => {
    const configService = config({
      PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
      PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-2',
      PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: 'chat-2',
    });
    expect(
      resolvePhotoDuplicateRuntimePolicy({
        chatId: 'chat-1',
        preset: 'MINOR_EDITS',
        scope: 'SAME_AUTHOR',
        configService,
      }).mode,
    ).toBe('shadow');
    expect(
      resolvePhotoDuplicateRuntimePolicy({
        chatId: 'chat-2',
        preset: 'MINOR_EDITS',
        scope: 'CHAT',
        configService,
      }).enforce,
    ).toBe(true);
  });

  it('rejects a wildcard global enforcement marker', () => {
    expect(
      resolvePhotoDuplicateRuntimePolicy({
        chatId: 'chat-1',
        preset: 'SAME_IMAGE',
        scope: 'SAME_AUTHOR',
        configService: config({
          PHOTO_DUPLICATE_ROLLOUT_MODE: 'delete_only',
          PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: '*',
        }),
      }).enforce,
    ).toBe(false);
  });

  it('defaults enforcement to canonical matches and delete-only actions', () => {
    const policy = resolvePhotoDuplicateRuntimePolicy({
      chatId: 'chat-1',
      preset: 'SAME_IMAGE',
      scope: 'SAME_AUTHOR',
      configService: config({
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
      }),
    });

    expect(policy.maxAction).toBe('DELETE_MESSAGE');
    expect(isPhotoDuplicateMatchKindAllowed(policy, 'canonical_sha256')).toBe(true);
    expect(isPhotoDuplicateMatchKindAllowed(policy, 'pdq')).toBe(false);
  });

  it('parses only explicit recognized enforcement match kinds', () => {
    expect(
      resolvePhotoDuplicateAllowedMatchKinds(
        config({ PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'pdq, canonical_sha256,pdq' }),
      ),
    ).toEqual(['canonical_sha256', 'pdq']);
    expect(
      resolvePhotoDuplicateAllowedMatchKinds(
        config({ PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'unknown' }),
      ),
    ).toEqual([]);
    expect(
      resolvePhotoDuplicateAllowedMatchKinds(
        config({ PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'platform_id,canonical_sha256' }),
      ),
    ).toEqual(['canonical_sha256']);
  });

  it('fails closed to delete-only for an absent or invalid maximum action', () => {
    expect(resolvePhotoDuplicateMaxAction(config({}))).toBe('DELETE_MESSAGE');
    expect(resolvePhotoDuplicateMaxAction(config({ PHOTO_DUPLICATE_MAX_ACTION: 'KICK' }))).toBe(
      'DELETE_MESSAGE',
    );
  });

  it.each([
    ['WARN', 'DELETE_MESSAGE', null],
    ['MUTE', 'WARN', 'WARN'],
    ['BAN', 'MUTE', 'MUTE'],
    ['WARN', 'BAN', 'WARN'],
    ['BAN', 'BAN', 'BAN'],
  ] as const)('caps %s at %s as %s', (action, maxAction, expected) => {
    expect(capPhotoDuplicateAction(action, maxAction)).toBe(expected);
  });
});
