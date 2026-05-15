import { buildCompactProfileMentionStartPayload } from '../max/max-deep-link.util';
import {
  appendAdminContactMarkdownLink,
  buildAdminContactMarkdownLink,
  resolveAdminContactMarkdownUrl,
} from './admin-contact-link.util';

describe('admin contact markdown links', () => {
  const botToken = 'test-max-bot-token';

  it('keeps direct profile links as markdown urls', () => {
    expect(resolveAdminContactMarkdownUrl(' https://max.ru/designer#profile ')).toBe(
      'https://max.ru/designer',
    );
  });

  it('keeps valid compact profile handoff links as clickable https urls', () => {
    const startPayload = buildCompactProfileMentionStartPayload(
      { chatId: 'chat-1', entityType: 'chat', userId: 'admin-1' },
      botToken,
    );
    const handoffUrl = `https://max.ru/777000_bot?start=${startPayload}`;

    expect(startPayload).toBeTruthy();
    expect(resolveAdminContactMarkdownUrl(handoffUrl, [botToken])).toBe(handoffUrl);
  });

  it('keeps valid legacy profile handoff links as clickable https urls', () => {
    const startPayload = `pmh-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'profile-mention',
        c: 'chat-1',
        e: 'chat',
        u: 'admin-2',
        n: 'Админ',
      }),
      'utf8',
    ).toString('base64url')}`;
    const handoffUrl = `https://max.ru/777000_bot?start=${startPayload}`;

    expect(resolveAdminContactMarkdownUrl(handoffUrl)).toBe(handoffUrl);
  });

  it('does not use max user mentions for fixed-label admin contact links', () => {
    expect(resolveAdminContactMarkdownUrl('max://user/admin-1')).toBeNull();
  });

  it('does not fall back to a bot handoff link when the profile payload is invalid', () => {
    expect(resolveAdminContactMarkdownUrl('https://max.ru/777000_bot?start=pmh-bad')).toBeNull();
  });

  it('appends a fixed admin contact markdown line when enabled', () => {
    expect(
      appendAdminContactMarkdownLink('Правило 1', {
        enabled: true,
        url: 'https://max.ru/designer',
      }),
    ).toBe('Правило 1\n\n[Связь с админом](https://max.ru/designer)');
    expect(
      buildAdminContactMarkdownLink({
        enabled: false,
        url: 'https://max.ru/designer',
      }),
    ).toBeNull();
  });
});
