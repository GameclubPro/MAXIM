import { LinkPolicy } from '../../prisma/prisma-client';
import { detectBlockedLink } from '../rule-engine-link-detector';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
} from './enabled-navigation-targets';
import { isEnforceableLinkPolicyTarget } from './link-policy-target.util';
import { adaptMaxMessageNavigationView } from './max-navigation-view.adapter';

describe('enabled navigation targets', () => {
  it('enforces structured and client-clickable text targets by default', () => {
    expect(resolveEnabledNavigationTargetOptions()).toEqual({
      structuredTargetsEnabled: true,
      profileMentionsEnabled: false,
      forwardedTargetsEnabled: true,
      textClickabilityEnabled: true,
    });
  });

  it('keeps a bare-domain candidate shadow-only during explicit rollback', () => {
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({ body: { text: 'Открыть plain.example.com/path' } }),
      resolveEnabledNavigationTargetOptions({
        get: <T = unknown>(key: string) =>
          (key === 'MODERATION_LINK_TEXT_CLICKABILITY_ENABLED' ? false : undefined) as
            | T
            | undefined,
      }),
    );

    expect(targets).toEqual([
      expect.objectContaining({
        normalizedTarget: 'https://plain.example.com/path',
        enforceable: false,
        origins: [expect.objectContaining({ carrier: 'plain_text', enforcement: 'shadow_only' })],
      }),
    ]);
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBeNull();
  });

  it('enforces client-clickable bare domains by default', () => {
    const options = resolveEnabledNavigationTargetOptions();
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({ body: { text: 'Открыть plain.example.com/path' } }),
      options,
    );

    expect(targets[0]).toEqual(
      expect.objectContaining({
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'plain_text', enforcement: 'eligible' })],
      }),
    );
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBe(
      'Links are not allowed by policy',
    );
  });

  it('enforces an explicit HTTP URL without enabling fuzzy text matching', () => {
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({ body: { text: 'Открыть https://plain.example/path' } }),
      { ...resolveEnabledNavigationTargetOptions(), textClickabilityEnabled: false },
    );

    expect(targets[0]).toEqual(
      expect.objectContaining({
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'plain_text', enforcement: 'eligible' })],
      }),
    );
  });

  it('enforces a forwarded Cyrillic domain without link markup and respects its allowlist', () => {
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({
        body: { text: '', markup: [{ type: 'heading', from: 0, length: 8 }] },
        link: {
          type: 'forward',
          message: { text: 'Наш сайт: иксфлоу.рф', markup: [] },
        },
      }),
      resolveEnabledNavigationTargetOptions(),
    );

    expect(targets).toEqual([
      expect.objectContaining({
        normalizedTarget: new URL('https://иксфлоу.рф').toString(),
        enforceable: true,
        origins: [
          expect.objectContaining({ carrier: 'plain_text', provenance: 'visible_forward' }),
        ],
      }),
    ]);
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).not.toBeNull();
    expect(detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, [], undefined, targets)).not.toBeNull();
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['иксфлоу.рф'], undefined, targets),
    ).toBeNull();
    expect(detectBlockedLink('', LinkPolicy.ALERT_ONLY, [], undefined, targets)).toBeNull();
  });

  it.each(['mail test@example.com', 'Цена 18.00', 'ул.Ленина', 'report.pdf', 'release.notes'])(
    'does not enforce non-link text by default: %s',
    (text) => {
      const targets = extractEnabledNavigationTargets(
        adaptMaxMessageNavigationView({ body: { text } }),
        resolveEnabledNavigationTargetOptions(),
      );
      expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBeNull();
    },
  );

  it('does not enforce a bare domain inside code or a reply quotation', () => {
    for (const message of [
      {
        body: {
          text: 'example.com',
          markup: [{ type: 'monospaced', from: 0, length: 11 }],
        },
      },
      { body: { text: 'Ответ' }, link: { type: 'reply', message: { text: 'example.com' } } },
    ]) {
      const targets = extractEnabledNavigationTargets(
        adaptMaxMessageNavigationView(message),
        resolveEnabledNavigationTargetOptions(),
      );
      expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBeNull();
    }
  });

  it('uses structured markup as the sole target for a URL-shaped link label', () => {
    const text = 'structured.example.com/path';
    const target = 'https://structured.example.com/path';
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({
        body: {
          text,
          markup: [{ type: 'link', from: 0, length: text.length, url: target }],
        },
      }),
      resolveEnabledNavigationTargetOptions({
        get: <T = unknown>(key: string) =>
          (key === 'MODERATION_LINK_TEXT_CLICKABILITY_ENABLED' ? false : undefined) as
            | T
            | undefined,
      }),
    );

    expect(targets).toEqual([
      expect.objectContaining({
        normalizedTarget: target,
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'link_markup', enforcement: 'eligible' })],
      }),
    ]);
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBe(
      'Links are not allowed by policy',
    );
  });

  it.each([LinkPolicy.BLOCKLIST_ONLY, LinkPolicy.ALLOWLIST_ONLY])(
    'preserves a platform user mention under %s even when mention extraction is enabled',
    (policy) => {
      const label = '@participant';
      const targets = extractEnabledNavigationTargets(
        adaptMaxMessageNavigationView({
          body: {
            text: label,
            markup: [{ type: 'user_mention', from: 0, length: label.length, user_link: label }],
          },
        }),
        { ...resolveEnabledNavigationTargetOptions(), profileMentionsEnabled: true },
      );

      expect(targets).toEqual([
        expect.objectContaining({
          kind: 'profile_mention',
          normalizedTarget: label,
          enforceable: true,
        }),
      ]);
      expect(targets.some(isEnforceableLinkPolicyTarget)).toBe(false);
      expect(detectBlockedLink('', policy, [], undefined, targets)).toBeNull();
    },
  );

  it('allows a schema-valid targetless mention while still finding a URL outside its range', () => {
    const mention = '@participant.example';
    const outsideUrl = 'https://outside.example/path';
    const text = `${mention} ${outsideUrl}`;
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({
        body: {
          text,
          markup: [{ type: 'user_mention', from: 0, length: mention.length }],
        },
      }),
      resolveEnabledNavigationTargetOptions(),
    );

    expect(targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        normalizedTarget: outsideUrl,
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'plain_text' })],
      }),
    ]);
  });

  it('blocks an unexpected URL carried by user-mention markup', () => {
    const label = '@participant';
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({
        body: {
          text: label,
          markup: [
            {
              type: 'user_mention',
              from: 0,
              length: label.length,
              user_id: 67123224,
              url: 'https://outside.example/hidden',
            },
          ],
        },
      }),
      resolveEnabledNavigationTargetOptions(),
    );

    expect(targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        normalizedTarget: 'https://outside.example/hidden',
        enforceable: true,
      }),
    ]);
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBe(
      'Links are not allowed by policy',
    );
  });

  it.each([
    ['external resource', 'https://outside.example/path'],
    ['MAX channel', 'https://max.ru/channels/blocked-channel'],
    ['custom-scheme resource', 'tg://resolve?domain=outside'],
  ])('blocks an @-shaped label that is really a link to an %s', (_kind, url) => {
    const label = '@participant';
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({
        body: {
          text: label,
          markup: [{ type: 'link', from: 0, length: label.length, url }],
        },
      }),
      resolveEnabledNavigationTargetOptions(),
    );

    expect(targets).toEqual([
      expect.objectContaining({
        kind: 'external_url',
        normalizedTarget: url,
        enforceable: true,
      }),
    ]);
    expect(targets.some(isEnforceableLinkPolicyTarget)).toBe(true);
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBe(
      'Links are not allowed by policy',
    );
  });

  it('lets a real link win when link and user-mention markup overlap', () => {
    const label = '@participant';
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({
        body: {
          text: label,
          markup: [
            {
              type: 'user_mention',
              from: 0,
              length: label.length,
              user_id: 67123224,
            },
            {
              type: 'link',
              from: 0,
              length: label.length,
              url: 'https://outside.example/hidden',
            },
          ],
        },
      }),
      { ...resolveEnabledNavigationTargetOptions(), profileMentionsEnabled: true },
    );

    expect(targets.map((target) => target.kind)).toEqual(['profile_mention', 'external_url']);
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).toBe(
      'Links are not allowed by policy',
    );
  });
});
