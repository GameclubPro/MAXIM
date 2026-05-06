import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from '../src/lib/max-markdown';

test('renders compact bold italic marker runs without leaking markdown punctuation', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('***MAX Docs***', { blockMode: 'inline' }),
    '<strong><em>MAX Docs</em></strong>',
  );
  assert.equal(
    renderSupportedMarkdownAsHtml('___++~~MAX Docs~~++___', { blockMode: 'inline' }),
    '<strong><em><u><s>MAX Docs</s></u></em></strong>',
  );
  assert.equal(stripSupportedMarkdownToPlainText('___++~~MAX Docs~~++___'), 'MAX Docs');
});

test('renders every nested rich text modifier combination without leaking markers', () => {
  for (const source of buildNestedModifierSamples()) {
    assert.doesNotMatch(
      renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' }),
      /(?:\*\*|__|\+\+|~~)/u,
    );
    assert.equal(stripSupportedMarkdownToPlainText(source), 'MAX Docs');
  }
});

function buildNestedModifierSamples(): string[] {
  const wrappers: Array<[string, string]> = [
    ['**', '**'],
    ['_', '_'],
    ['++', '++'],
    ['~~', '~~'],
  ];

  return permute(wrappers).map((permutation) =>
    permutation.reduce((content, [prefix, suffix]) => `${prefix}${content}${suffix}`, 'MAX Docs'),
  );
}

function permute<T>(items: T[]): T[][] {
  if (items.length === 0) {
    return [[]];
  }

  return items.flatMap((item, index) =>
    permute([...items.slice(0, index), ...items.slice(index + 1)]).map((permutation) => [
      item,
      ...permutation,
    ]),
  );
}
