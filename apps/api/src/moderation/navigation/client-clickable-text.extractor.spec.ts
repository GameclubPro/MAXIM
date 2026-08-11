import { adaptMaxMessageNavigationView } from './max-navigation-view.adapter';
import { extractClientClickableTextEvidence } from './client-clickable-text.extractor';

describe('extractClientClickableTextEvidence', () => {
  it('extracts client-compatible web links with exact UTF-16 ranges', () => {
    const text = 'emoji \ud83d\ude80 https://example.com/a_(b) and max.ru/join/abc';
    const result = extractClientClickableTextEvidence(
      adaptMaxMessageNavigationView({ body: { text } }),
    );

    expect(result).toEqual([
      {
        provenance: 'direct',
        target: 'https://example.com/a_(b)',
        from: text.indexOf('https://'),
        length: 'https://example.com/a_(b)'.length,
        sourcePath: 'message.body.text',
      },
      {
        provenance: 'direct',
        target: 'https://max.ru/join/abc',
        from: text.indexOf('max.ru'),
        length: 'max.ru/join/abc'.length,
        sourcePath: 'message.body.text',
      },
    ]);
  });

  it('supports explicit IPv6 and IDN links', () => {
    const result = extractClientClickableTextEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'http://[2001:db8::1]/x \u043c\u0435\u0431\u0435\u043b\u044c\u0442\u044e\u043c\u0435\u043d\u044c.\u0440\u0444 https://\u4f8b\u3048.\u30c6\u30b9\u30c8/\u30d1\u30b9',
        },
      }),
    );

    expect(result.map((item) => item.target)).toEqual([
      'http://[2001:db8::1]/x',
      'https://xn--90ahba3acej6b8feu.xn--p1ai/',
      'https://xn--r8jz45g.xn--zckzah/%E3%83%91%E3%82%B9',
    ]);
  });

  it('uses the current IANA root-zone delta for bare domains', () => {
    const result = extractClientClickableTextEvidence(
      adaptMaxMessageNavigationView({
        body: {
          text: 'new registry.merck and launch.web; retired brand.goo and old.wolterskluwer',
        },
      }),
    );

    expect(result.map((item) => item.target)).toEqual([
      'https://registry.merck/',
      'https://launch.web/',
    ]);
  });

  it.each([
    'mail test@example.com',
    'release.notes item.local report.pdf',
    'address 18.00 and 2.Humako Inches',
    'broken exa\u200bmple.com and https://bad.ex\u200bample/path',
  ])('does not promote non-clickable lookalikes: %s', (text) => {
    expect(
      extractClientClickableTextEvidence(adaptMaxMessageNavigationView({ body: { text } })),
    ).toEqual([]);
  });

  it.each(['code', 'pre', 'monospaced'])(
    'keeps URLs intersecting %s markup shadow-only',
    (type) => {
      const target = 'https://example.com/not-clickable';
      const text = `AA ${target} ZZ`;
      const targetFrom = text.indexOf(target);
      const targetEnd = targetFrom + target.length;
      const overlappingRanges = [
        { from: 0, length: targetFrom + 5 },
        { from: targetEnd - 5, length: text.length - targetEnd + 5 },
        { from: targetFrom + 8, length: 4 },
        { from: targetFrom, length: target.length },
      ];

      for (const range of overlappingRanges) {
        const view = adaptMaxMessageNavigationView({
          body: {
            text,
            markup: [{ type, ...range }],
          },
        });

        expect(extractClientClickableTextEvidence(view)).toEqual([]);
      }
    },
  );

  it.each(['code', 'pre', 'monospaced'])(
    'keeps URLs adjacent to %s markup client-clickable',
    (type) => {
      const target = 'https://example.com/clickable';
      const text = `AA ${target} ZZ`;
      const targetFrom = text.indexOf(target);
      const targetEnd = targetFrom + target.length;
      const adjacentRanges = [
        { from: 0, length: targetFrom },
        { from: targetEnd, length: text.length - targetEnd },
      ];

      for (const range of adjacentRanges) {
        const view = adaptMaxMessageNavigationView({
          body: {
            text,
            markup: [{ type, ...range }],
          },
        });

        expect(extractClientClickableTextEvidence(view).map((item) => item.target)).toEqual([
          target,
        ]);
      }
    },
  );

  it.each(['code', 'pre', 'monospaced'])(
    'returns no plain-text candidates when %s markup has an invalid range',
    (type) => {
      const target = 'https://example.com/uncertain';

      for (const range of [
        { from: -1, length: target.length },
        { from: 0, length: 0 },
        { from: 0, length: target.length + 1 },
        { from: 'invalid', length: target.length },
      ]) {
        const view = adaptMaxMessageNavigationView({
          body: {
            text: target,
            markup: [{ type, ...range }],
          },
        });

        expect(extractClientClickableTextEvidence(view)).toEqual([]);
      }
    },
  );

  it.each(['link', 'user_mention'])(
    'does not infer a visible URL inside valid %s navigation markup',
    (type) => {
      const structuredLabel = 'https://visible.example.com/path';
      const plainTarget = 'https://plain.example.com/path';
      const text = `${structuredLabel} ${plainTarget}`;
      const view = adaptMaxMessageNavigationView({
        body: {
          text,
          markup: [{ type, from: 0, length: structuredLabel.length }],
        },
      });

      expect(extractClientClickableTextEvidence(view).map((item) => item.target)).toEqual([
        plainTarget,
      ]);
    },
  );

  it.each(['link', 'user_mention'])(
    'does not hide an explicit text URL behind malformed %s markup',
    (type) => {
      const target = 'https://visible.example.com/path';
      const view = adaptMaxMessageNavigationView({
        body: {
          text: target,
          markup: [{ type, from: target.length + 1, length: 4 }],
        },
      });

      expect(extractClientClickableTextEvidence(view).map((item) => item.target)).toEqual([target]);
    },
  );

  it('does not treat a repeated media attachment URL as authored navigation', () => {
    const mediaUrl = 'https://i.oneme.ru/i?r=preview-token';
    const view = adaptMaxMessageNavigationView({
      body: {
        text: `Фото ${mediaUrl} https://example.com/authored`,
        attachments: [{ type: 'image', payload: { url: mediaUrl } }],
      },
    });

    expect(extractClientClickableTextEvidence(view).map((item) => item.target)).toEqual([
      'https://example.com/authored',
    ]);
  });
});
