import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('publish bar owns stable icon dimensions outside viewport media queries', () => {
  assert.match(
    readSource('../src/components/broadcast-publish-bar.tsx'),
    /import '\.\/broadcast-publish-bar\.css'/u,
  );
  const css = postcss.parse(readSource('../src/components/broadcast-publish-bar.css'));
  let checked = false;
  css.walkRules((rule) => {
    if (!rule.selectors.includes('.broadcast-publish-bar__primary svg')) return;
    assert.equal(rule.parent?.type, 'atrule');
    assert.equal((rule.parent as postcss.AtRule).name, 'layer');
    const values = new Map<string, string>();
    rule.walkDecls((declaration) => {
      values.set(declaration.prop, declaration.value);
    });
    assert.equal(values.get('width'), '18px');
    assert.equal(values.get('height'), '18px');
    assert.equal(values.get('flex'), '0 0 18px');
    checked = true;
  });
  assert.equal(checked, true);
});

test('delivery text and final review keep their dedicated presentation boundaries', () => {
  assert.match(
    readSource('../src/features/publications/publication-details-sheet.tsx'),
    /<span className="publication-deliveries__copy">/u,
  );
  assert.match(
    readSource('../src/pages/publications-page.tsx'),
    /\.\.\.publicationPostPublishLabels\(draft\.postPublish\)/u,
  );
});
