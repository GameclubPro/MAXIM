import { LinkPolicy } from '../../prisma/prisma-client';
import { detectBlockedLink } from '../rule-engine-link-detector';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
} from './enabled-navigation-targets';
import { isEnforceableLinkPolicyTarget } from './link-policy-target.util';
import { adaptMaxMessageNavigationView } from './max-navigation-view.adapter';

describe('enabled navigation targets', () => {
  it('defaults structured and explicit HTTP targets to enforcement but fuzzy text to shadow-only', () => {
    expect(resolveEnabledNavigationTargetOptions()).toEqual({
      structuredTargetsEnabled: true,
      profileMentionsEnabled: false,
      forwardedTargetsEnabled: true,
      textClickabilityEnabled: false,
    });
  });

  it('keeps a fuzzy bare-domain candidate visible but non-enforceable by default', () => {
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({ body: { text: 'Открыть plain.example.com/path' } }),
      resolveEnabledNavigationTargetOptions(),
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

  it('enforces fuzzy plain-text targets only after explicit opt-in', () => {
    const options = resolveEnabledNavigationTargetOptions({
      get: <T = unknown>(key: string) =>
        (key === 'MODERATION_LINK_TEXT_CLICKABILITY_ENABLED' ? true : undefined) as T | undefined,
    });
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
      resolveEnabledNavigationTargetOptions(),
    );

    expect(targets[0]).toEqual(
      expect.objectContaining({
        enforceable: true,
        origins: [expect.objectContaining({ carrier: 'plain_text', enforcement: 'eligible' })],
      }),
    );
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
