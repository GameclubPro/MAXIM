import { LinkPolicy } from '../../prisma/prisma-client';
import { detectBlockedLink } from '../rule-engine-link-detector';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
} from './enabled-navigation-targets';
import { adaptMaxMessageNavigationView } from './max-navigation-view.adapter';

describe('enabled navigation targets', () => {
  it('defaults structured and explicit HTTP targets to enforcement but fuzzy text to shadow-only', () => {
    expect(resolveEnabledNavigationTargetOptions()).toEqual({
      structuredTargetsEnabled: true,
      profileMentionsEnabled: true,
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
});
