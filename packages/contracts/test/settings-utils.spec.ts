import { describe, expect, it } from 'vitest';

import {
  addDomainRequestSchema,
  buildNavigationAllowlistPolicyKeys,
  domainAllowlistEntrySchema,
  normalizeAllowlistLink,
  normalizeNavigationAllowlistTarget,
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
} from '@maxim/contracts';

describe('allowlist URL normalization', () => {
  it('removes the complete supported trailing punctuation set', () => {
    expect(normalizeAllowlistLink('Ссылка: https://example.com/path)]},.;!?:')).toBe(
      'https://example.com/path',
    );
    expect(normalizeAllowlistLink('https://example.com/a!b')).toBe('https://example.com/a!b');
  });

  it('handles adversarial trailing punctuation in a linear pass', () => {
    const repeatedPunctuation = '!'.repeat(100_000);
    const embeddedPunctuationUrl = `https://example.com/path${repeatedPunctuation}tail`;

    expect(normalizeAllowlistLink(`https://example.com/path${repeatedPunctuation}`)).toBe(
      'https://example.com/path',
    );
    expect(normalizeAllowlistLink(embeddedPunctuationUrl)).toBe(embeddedPunctuationUrl);
  });
});

describe('typed navigation allowlist normalization', () => {
  it('preserves legacy exact and domain storage formats', () => {
    const exact = normalizeStoredAllowlistEntry('https://Example.com/path', 'EXACT');
    const domain = normalizeStoredAllowlistEntry('https://www.Example.com/path', 'DOMAIN');

    expect(exact).toBe('https://example.com/path');
    expect(domain).toBe('domain:www.example.com');
    expect(parseStoredAllowlistEntry(exact as string)).toEqual({
      domain: 'https://example.com/path',
      target: 'https://example.com/path',
      normalizedValue: 'https://example.com/path',
      matchType: 'EXACT',
      kind: 'WEB_EXACT',
    });
    expect(parseStoredAllowlistEntry(domain as string)).toEqual({
      domain: 'www.example.com',
      target: 'www.example.com',
      normalizedValue: 'domain:www.example.com',
      matchType: 'DOMAIN',
      kind: 'WEB_DOMAIN',
    });

    expect(
      parseStoredAllowlistEntry(
        'https://max.ru/join/allowed%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82',
      ),
    ).toMatchObject({
      normalizedValue:
        'https://max.ru/join/allowed%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82',
      kind: 'WEB_EXACT',
    });
  });

  it('normalizes the entire exact target without truncating URL suffixes', () => {
    expect(
      normalizeNavigationAllowlistTarget('https://allowed.example/path(evil)', 'WEB_EXACT'),
    ).toBe('https://allowed.example/path(evil)');
    expect(normalizeStoredAllowlistEntry('https://allowed.example/path(evil)', 'WEB_EXACT')).toBe(
      'https://allowed.example/path(evil)',
    );
    expect(parseStoredAllowlistEntry('https://allowed.example/path(evil)')).toMatchObject({
      target: 'https://allowed.example/path(evil)',
      normalizedValue: 'https://allowed.example/path(evil)',
      kind: 'WEB_EXACT',
    });
    expect(
      normalizeNavigationAllowlistTarget('https://allowed.example/path hidden', 'WEB_EXACT'),
    ).toBeNull();
    expect(normalizeStoredAllowlistEntry('https://allowed.example/a%20b', 'WEB_EXACT')).toBe(
      'https://allowed.example/a%20b',
    );
    expect(parseStoredAllowlistEntry('https://allowed.example/a%20b')).toMatchObject({
      target: 'https://allowed.example/a%20b',
      normalizedValue: 'https://allowed.example/a%20b',
      kind: 'WEB_EXACT',
    });
    expect(
      normalizeStoredAllowlistEntry('Разрешить: https://allowed.example/path', 'WEB_EXACT'),
    ).toBeNull();
    expect(normalizeStoredAllowlistEntry('Разрешить: https://allowed.example/path', 'EXACT')).toBe(
      'https://allowed.example/path',
    );
  });

  it('keeps exact hosts and www domain scopes distinct', () => {
    expect(normalizeStoredAllowlistEntry('https://vk.ru/path', 'WEB_EXACT')).toBe(
      'https://vk.ru/path',
    );
    expect(normalizeStoredAllowlistEntry('https://vk.com/path', 'WEB_EXACT')).toBe(
      'https://vk.com/path',
    );
    expect(normalizeStoredAllowlistEntry('https://www.example.com/path', 'WEB_DOMAIN')).toBe(
      'domain:www.example.com',
    );
  });

  it('normalizes equivalent MAX profile IDs without synthesizing web URLs', () => {
    const inputs = ['123456', 'user/123456', '/user/123456', 'max://user/123456', 'user-id:123456'];

    for (const input of inputs) {
      expect(normalizeNavigationAllowlistTarget(input, 'MAX_PROFILE')).toBe('user-id:123456');
    }

    expect(normalizeNavigationAllowlistTarget('@Some_User', 'MAX_PROFILE')).toBe(
      'username:some_user',
    );
    expect(normalizeNavigationAllowlistTarget('Some_User', 'MAX_PROFILE')).toBe(
      'username:some_user',
    );
    expect(normalizeStoredAllowlistEntry('@Some_User', 'MAX_PROFILE')).toBeNull();
    for (const invalidId of [
      'user-id:Some_User',
      'user/Some_User',
      'max://user/Some_User',
      '0',
      '123456789012345678901',
    ]) {
      expect(normalizeStoredAllowlistEntry(invalidId, 'MAX_PROFILE')).toBeNull();
    }
    expect(
      normalizeNavigationAllowlistTarget('https://max.ru/user/123456', 'MAX_PROFILE'),
    ).toBeNull();

    const stored = normalizeStoredAllowlistEntry('max://user/123456', 'MAX_PROFILE');
    expect(stored).toBe('max-profile:user-id%3A123456');
    expect(parseStoredAllowlistEntry(stored as string)).toMatchObject({
      domain: 'user-id:123456',
      target: 'user-id:123456',
      matchType: 'EXACT',
      kind: 'MAX_PROFILE',
    });
    expect(parseStoredAllowlistEntry(stored as string)?.target).not.toMatch(/^https?:/u);
  });

  it('keeps stored MAX entity IDs readable but accepts only official URLs for new rules', () => {
    expect(normalizeNavigationAllowlistTarget('-00123', 'MAX_ENTITY')).toBe('chat-id:-123');
    expect(normalizeStoredAllowlistEntry('-00123', 'MAX_ENTITY')).toBeNull();
    expect(parseStoredAllowlistEntry('max-entity:chat-id%3A-123')).toMatchObject({
      normalizedValue: 'max-entity:chat-id%3A-123',
      target: 'chat-id:-123',
      kind: 'MAX_ENTITY',
    });
    expect(
      normalizeNavigationAllowlistTarget(
        'http://www.max.ru/chats/Team-Room/?utm_source=test',
        'MAX_ENTITY',
      ),
    ).toBe('url:https://max.ru/chats/Team-Room');
    expect(
      normalizeNavigationAllowlistTarget('https://example.com/chats/123', 'MAX_ENTITY'),
    ).toBeNull();
    expect(
      normalizeNavigationAllowlistTarget('https://max.ru/not-an-entity/123', 'MAX_ENTITY'),
    ).toBeNull();
    expect(normalizeNavigationAllowlistTarget('chat_uuid:987654', 'MAX_ENTITY')).toBeNull();
    expect(normalizeNavigationAllowlistTarget('chat-create', 'MAX_ENTITY')).toBeNull();
  });

  it('round-trips every typed storage prefix', () => {
    const cases = [
      {
        input: 'https://max.ru/chats/team-room',
        kind: 'MAX_ENTITY' as const,
        stored: 'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fchats%2Fteam-room',
        target: 'url:https://max.ru/chats/team-room',
      },
      {
        input: 'https://max.ru/MajorBot?startapp=chat-42',
        kind: 'MINI_APP' as const,
        stored: 'mini-app:bot%3Amajorbot',
        target: 'bot:majorbot',
      },
      {
        input: 'contact_id:42',
        kind: 'MINI_APP' as const,
        stored: 'mini-app:contact-id%3A42',
        target: 'contact-id:42',
      },
    ];

    for (const item of cases) {
      const stored = normalizeStoredAllowlistEntry(item.input, item.kind);
      expect(stored).toBe(item.stored);
      expect(parseStoredAllowlistEntry(stored as string)).toMatchObject({
        normalizedValue: item.stored,
        target: item.target,
        kind: item.kind,
      });
    }

    expect(parseStoredAllowlistEntry('mini-app:%E0%A4%A')).toBeNull();
  });

  it('rejects typed entries whose encoded storage value exceeds the response contract', () => {
    const oversized = `https://apps.example.com/${'я'.repeat(300)}`;
    const oversizedWebExact = `https://apps.example.com/${'я'.repeat(400)}`;

    expect(normalizeNavigationAllowlistTarget(oversized, 'MINI_APP')).not.toBeNull();
    expect(normalizeStoredAllowlistEntry(oversized, 'MINI_APP')).toBeNull();
    expect(addDomainRequestSchema.safeParse({ domain: oversized, kind: 'MINI_APP' }).success).toBe(
      false,
    );

    expect(normalizeNavigationAllowlistTarget(oversizedWebExact, 'WEB_EXACT')).not.toBeNull();
    expect(normalizeStoredAllowlistEntry(oversizedWebExact, 'WEB_EXACT')).toBeNull();
    expect(normalizeStoredAllowlistEntry(oversizedWebExact, 'EXACT')).toBeNull();
    expect(
      addDomainRequestSchema.safeParse({ domain: oversizedWebExact, kind: 'WEB_EXACT' }).success,
    ).toBe(false);
    expect(
      addDomainRequestSchema.safeParse({ domain: oversizedWebExact, matchType: 'EXACT' }).success,
    ).toBe(false);
  });

  it('supports exact web targets through the full 2048-character evidence boundary', () => {
    const target = `https://example.com/${'a'.repeat(2_028)}`;

    expect(target).toHaveLength(2_048);
    expect(normalizeStoredAllowlistEntry(target, 'WEB_EXACT')).toBe(target);
    expect(addDomainRequestSchema.safeParse({ domain: target, kind: 'WEB_EXACT' }).success).toBe(
      true,
    );
    expect(normalizeStoredAllowlistEntry(`${target}a`, 'WEB_EXACT')).toBeNull();
  });

  it('keys a MAX startapp route by bot and rejects ambiguous launch links', () => {
    expect(
      normalizeNavigationAllowlistTarget(
        'https://www.max.ru/MajorBot?startapp=chat-settings-123',
        'MINI_APP',
      ),
    ).toBe('bot:majorbot');
    expect(normalizeNavigationAllowlistTarget('bot:MajorBot', 'MINI_APP')).toBe('bot:majorbot');
    expect(normalizeNavigationAllowlistTarget('@MajorBot', 'MINI_APP')).toBe('bot:majorbot');
    expect(normalizeNavigationAllowlistTarget('MajorBot', 'MINI_APP')).toBe('bot:majorbot');
    expect(normalizeNavigationAllowlistTarget('contact_id:Contact-42', 'MINI_APP')).toBe(
      'contact-id:Contact-42',
    );
    expect(normalizeNavigationAllowlistTarget('contact-id:Contact-42', 'MINI_APP')).toBe(
      'contact-id:Contact-42',
    );
    expect(normalizeNavigationAllowlistTarget('https://max.ru/MajorBot', 'MINI_APP')).toBe(
      'url:https://max.ru/MajorBot',
    );
    expect(
      normalizeNavigationAllowlistTarget('https://apps.example.com/open?id=42', 'MINI_APP'),
    ).toBe('url:https://apps.example.com/open?id=42');
    expect(
      normalizeNavigationAllowlistTarget('http://apps.example.com/open', 'MINI_APP'),
    ).toBeNull();
    expect(
      normalizeNavigationAllowlistTarget(
        'https://max.ru/MajorBot?startapp=one&startapp=two',
        'MINI_APP',
      ),
    ).toBeNull();
    expect(
      normalizeNavigationAllowlistTarget('https://max.ru/join?startapp=tracking', 'MINI_APP'),
    ).toBeNull();
    expect(normalizeNavigationAllowlistTarget('@join', 'MINI_APP')).toBeNull();
    expect(
      normalizeNavigationAllowlistTarget(
        `https://max.ru/PublicBot?startapp=${'a'.repeat(512)}`,
        'MINI_APP',
      ),
    ).toBe('bot:publicbot');
    for (const invalidStartapp of [
      'bad%2Fpayload',
      'bad+payload',
      encodeURIComponent('плохо'),
      'a'.repeat(513),
    ]) {
      expect(
        normalizeNavigationAllowlistTarget(
          `https://max.ru/PublicBot?startapp=${invalidStartapp}`,
          'MINI_APP',
        ),
      ).toBeNull();
    }
  });
});

describe('navigation allowlist policy keys', () => {
  it('builds exact and domain keys for external URLs', () => {
    expect(buildNavigationAllowlistPolicyKeys('https://Example.com/path', 'external_url')).toEqual([
      { kind: 'WEB_EXACT', target: 'https://example.com/path' },
      { kind: 'WEB_DOMAIN', target: 'example.com' },
    ]);
  });

  it('classifies official startapp routes before generic MAX entities', () => {
    expect(
      buildNavigationAllowlistPolicyKeys(
        'https://max.ru/MajorBot?startapp=chat-settings-123',
        'external_url',
      ),
    ).toEqual([
      {
        kind: 'WEB_EXACT',
        target: 'https://max.ru/MajorBot?startapp=chat-settings-123',
      },
      { kind: 'WEB_DOMAIN', target: 'max.ru' },
      { kind: 'MINI_APP', target: 'bot:majorbot' },
    ]);
  });

  it('builds typed keys for entity routes, profile mentions, and mini apps', () => {
    expect(
      buildNavigationAllowlistPolicyKeys('https://max.ru/chats/team-room', 'external_url'),
    ).toEqual([
      { kind: 'WEB_EXACT', target: 'https://max.ru/chats/team-room' },
      { kind: 'WEB_DOMAIN', target: 'max.ru' },
      { kind: 'MAX_ENTITY', target: 'url:https://max.ru/chats/team-room' },
    ]);
    expect(buildNavigationAllowlistPolicyKeys('max://user/42', 'profile_mention')).toEqual([
      { kind: 'MAX_PROFILE', target: 'user-id:42' },
    ]);
    expect(
      buildNavigationAllowlistPolicyKeys('https://max.ru/MajorBot?startapp=one', 'mini_app'),
    ).toEqual([
      { kind: 'MINI_APP', target: 'bot:majorbot' },
      {
        kind: 'WEB_EXACT',
        target: 'https://max.ru/MajorBot?startapp=one',
      },
      { kind: 'WEB_DOMAIN', target: 'max.ru' },
    ]);
    expect(
      buildNavigationAllowlistPolicyKeys('https://apps.example.com/open?id=42', 'mini_app'),
    ).toEqual([
      { kind: 'MINI_APP', target: 'url:https://apps.example.com/open?id=42' },
      { kind: 'WEB_EXACT', target: 'https://apps.example.com/open?id=42' },
      { kind: 'WEB_DOMAIN', target: 'apps.example.com' },
    ]);
    expect(buildNavigationAllowlistPolicyKeys('contact_id:42', 'mini_app')).toEqual([
      { kind: 'MINI_APP', target: 'contact-id:42' },
    ]);
    expect(buildNavigationAllowlistPolicyKeys('chat_uuid:987654', 'max_entity')).toEqual([
      { kind: 'MAX_ENTITY', target: 'chat-uuid:987654' },
    ]);
  });

  it('fails closed for targets that cannot be normalized for their evidence kind', () => {
    expect(
      buildNavigationAllowlistPolicyKeys('https://example.com/user/42', 'profile_mention'),
    ).toEqual([]);
    expect(buildNavigationAllowlistPolicyKeys('contact_id:', 'mini_app')).toEqual([]);
  });
});

describe('navigation allowlist schemas', () => {
  it('accepts canonical kinds and legacy match types', () => {
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'max://user/42',
        kind: 'MAX_PROFILE',
      }).success,
    ).toBe(true);
    expect(
      addDomainRequestSchema.safeParse({
        domain: '42',
        kind: 'MAX_PROFILE',
      }).success,
    ).toBe(true);
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'example.com',
        matchType: 'DOMAIN',
      }).success,
    ).toBe(true);
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'https://example.com/path',
        kind: 'WEB_EXACT',
        matchType: 'EXACT',
      }).success,
    ).toBe(true);
  });

  it('rejects conflicting aliases and kind-specific invalid targets', () => {
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'https://example.com/path',
        kind: 'WEB_EXACT',
        matchType: 'DOMAIN',
      }).success,
    ).toBe(false);
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'https://example.com/user/42',
        kind: 'MAX_PROFILE',
      }).success,
    ).toBe(false);
    expect(
      addDomainRequestSchema.safeParse({
        domain: '@Some_User',
        kind: 'MAX_PROFILE',
      }).success,
    ).toBe(false);
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'Разрешить: https://example.com/path',
        kind: 'WEB_EXACT',
      }).success,
    ).toBe(false);
    expect(
      addDomainRequestSchema.safeParse({
        domain: '-123',
        kind: 'MAX_ENTITY',
      }).success,
    ).toBe(false);
    expect(
      addDomainRequestSchema.safeParse({
        domain: 'https://max.ru/join/team-room',
        kind: 'MAX_ENTITY',
      }).success,
    ).toBe(true);
  });

  it('parses both legacy and typed response entries', () => {
    const base = {
      domain: 'https://example.com/path',
      normalizedValue: 'https://example.com/path',
      matchType: 'EXACT' as const,
      removeAfterAt: null,
    };

    expect(domainAllowlistEntrySchema.safeParse(base).success).toBe(true);
    expect(
      domainAllowlistEntrySchema.safeParse({
        ...base,
        domain: 'user-id:42',
        target: 'user-id:42',
        normalizedValue: 'max-profile:user-id%3A42',
        kind: 'MAX_PROFILE',
      }).success,
    ).toBe(true);
    expect(
      domainAllowlistEntrySchema.safeParse({
        ...base,
        kind: 'WEB_DOMAIN',
      }).success,
    ).toBe(false);
  });
});
