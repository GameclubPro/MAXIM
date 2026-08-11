import { LinkPolicy } from '../prisma/prisma-client';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import { detectBlockedLink } from './rule-engine-link-detector';

function target(
  kind: NavigationTargetEvidence['kind'],
  value: string,
  enforceable = true,
  allowlistAliases?: NavigationTargetEvidence['allowlistAliases'],
): NavigationTargetEvidence {
  return {
    kind,
    target: value,
    normalizedTarget: value,
    enforceable,
    origins: [],
    ...(allowlistAliases ? { allowlistAliases } : {}),
  };
}

describe('typed link moderation', () => {
  it('blocks a hidden structured URL even when visible text has no URL', () => {
    expect(
      detectBlockedLink('обычный текст', LinkPolicy.BLOCKLIST_ONLY, [], undefined, [
        target('external_url', 'https://blocked.example/path'),
      ]),
    ).toBe('Links are not allowed by policy');
  });

  it('never treats a MAX profile mention as a link-policy target', () => {
    const profile = [target('profile_mention', 'max://user/67123224')];

    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, profile)).toBeNull();
    expect(detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, [], undefined, profile)).toBeNull();
    expect(detectBlockedLink('', LinkPolicy.ALERT_ONLY, [], undefined, profile)).toBeNull();
  });

  it('supports typed MAX entity allowlist entries', () => {
    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fjoin%2Fallowed'],
        undefined,
        [target('external_url', 'https://max.ru/join/allowed')],
      ),
    ).toBeNull();
  });

  it('requires every target in allowlist-only mode to be allowed', () => {
    const result = detectBlockedLink(
      '',
      LinkPolicy.ALLOWLIST_ONLY,
      ['domain:allowed.example'],
      undefined,
      [
        target('external_url', 'https://allowed.example/a'),
        target('external_url', 'https://blocked.example/b'),
      ],
    );

    expect(result).toBe('Link https://blocked.example/b is not in allowlist');
  });

  it('fails closed for a custom-scheme target in allowlist-only mode', () => {
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['domain:allowed.example'], undefined, [
        target('external_url', 'tg://resolve?domain=outside'),
      ]),
    ).toBe('Link tg://resolve?domain=outside is not in allowlist');
  });

  it('allows one open-app action by either its URL or contact alias', () => {
    const openApp = target('mini_app', 'https://apps.example/start', true, [
      {
        kind: 'mini_app',
        target: 'contact_id:101',
        normalizedTarget: 'contact_id:101',
      },
    ]);

    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['mini-app:contact-id%3A101'], undefined, [
        openApp,
      ]),
    ).toBeNull();
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['https://apps.example/start'], undefined, [
        openApp,
      ]),
    ).toBeNull();
  });

  it('allows an official open-app bot URL by its username identity', () => {
    const openApp = target('mini_app', 'https://max.ru/Some_Public_Bot', true, [
      {
        kind: 'mini_app',
        target: 'bot:some_public_bot',
        normalizedTarget: 'bot:some_public_bot',
      },
    ]);

    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['mini-app:bot%3Asome_public_bot'],
        undefined,
        [openApp],
      ),
    ).toBeNull();
  });

  it('does not let one contact alias allow a different button with the same URL', () => {
    const actions = ['101', '202'].map((contactId) =>
      target('mini_app', 'https://apps.example/start', true, [
        {
          kind: 'mini_app',
          target: `contact_id:${contactId}`,
          normalizedTarget: `contact_id:${contactId}`,
        },
      ]),
    );

    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['mini-app:contact-id%3A101'],
        undefined,
        actions,
      ),
    ).toBe('Link https://apps.example/start is not in allowlist');
  });

  it('keeps WEB_EXACT exact when a clickable target has a parenthesized suffix', () => {
    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['https://allowed.example/path'],
        undefined,
        [target('external_url', 'https://allowed.example/path(evil)')],
      ),
    ).toBe('Link https://allowed.example/path(evil) is not in allowlist');
  });

  it('does not enforce ambiguous shadow-only navigation', () => {
    expect(
      detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, [
        target('external_url', 'https://shadow.example', false),
      ]),
    ).toBeNull();
  });

  it('does not suppress a client-verified uppercase bare link as a brand label', () => {
    expect(
      detectBlockedLink(
        'https://ura.news/news/1 Читайте на URA.RU',
        LinkPolicy.ALLOWLIST_ONLY,
        ['https://ura.news/news/1'],
        undefined,
        [
          target('external_url', 'https://ura.news/news/1'),
          target('external_url', 'https://ura.ru'),
        ],
      ),
    ).toBe('Link https://ura.ru is not in allowlist');
  });
});
