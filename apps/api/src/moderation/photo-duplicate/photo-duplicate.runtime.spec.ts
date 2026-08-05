import {
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
    ).toEqual({ mode: 'shadow', enforce: false, advancedCanary: false });
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

  it('allows an explicit global enforcement marker', () => {
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
    ).toBe(true);
  });
});
