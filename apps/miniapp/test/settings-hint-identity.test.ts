import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('every inline settings explanation has the identity used by dismissal handlers', () => {
  const directory = new URL('../src/pages/settings/', import.meta.url);
  const files = [
    new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
    ...readdirSync(directory)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => new URL(name, directory)),
  ];
  let checked = 0;
  for (const file of files) {
    const source = ts.createSourceFile(
      file.pathname,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button') {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const expanded = attributes.find(
          (attribute) => attribute.name.getText(source) === 'aria-expanded',
        );
        const expression = expanded?.initializer;
        if (
          expression &&
          ts.isJsxExpression(expression) &&
          expression.expression &&
          ts.isBinaryExpression(expression.expression) &&
          expression.expression.left.getText(source) === 'openHintKey' &&
          ts.isStringLiteral(expression.expression.right)
        ) {
          const key = expression.expression.right.text;
          const identity = attributes.find(
            (attribute) => attribute.name.getText(source) === 'data-hint-key',
          );
          assert.ok(
            identity?.initializer && ts.isStringLiteral(identity.initializer),
            `${file.pathname}: ${key}`,
          );
          assert.equal(identity.initializer.text, key);
          checked += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked >= 24, `Expected all inline explanations, found ${checked}`);
});
