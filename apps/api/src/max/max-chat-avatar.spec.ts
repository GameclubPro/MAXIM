import { readMaxChatAvatar } from './max-chat-avatar';

describe('MAX chat avatar observations', () => {
  it.each([
    { icon: { url: 'https://i.oneme.ru/p.webp' } },
    { full_icon_url: 'https://i.oneme.ru/p.webp' },
    { icon: { fullIconUrl: 'https://i.oneme.ru/p.webp' } },
    { avatarUrl: 'https://i.oneme.ru/p.webp' },
  ])('reads a supported present image from %j', (payload) => {
    expect(readMaxChatAvatar(payload)).toEqual({
      avatarUrl: 'https://i.oneme.ru/p.webp',
      avatarState: 'present',
    });
  });
  it.each([
    {},
    { icon: {} },
    { icon: '' },
    { avatar_url: null },
    { icon: { url: 'javascript:alert(1)' } },
    { icon: null, avatar_url: 'invalid' },
  ])('does not turn incomplete or malformed payloads into deletion proof: %j', (payload) => {
    expect(readMaxChatAvatar(payload)).toEqual({ avatarUrl: null, avatarState: 'unknown' });
  });
  it('recognizes explicit absence, while a valid full image defeats contradictory null icon', () => {
    expect(readMaxChatAvatar({ icon: null }).avatarState).toBe('absent');
    expect(
      readMaxChatAvatar({ icon: null, full_icon_url: 'https://i.oneme.ru/p.webp' }).avatarState,
    ).toBe('present');
  });
});
