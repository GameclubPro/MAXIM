import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const printer = ts.createPrinter({ removeComments: true });
const baselinePath = 'scripts/runtime-context-baseline.json';

export function findRuntimeContextFindings(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const add = (name, node) =>
    findings.push({
      key: `${filename}:${name}`,
      definitionSha256: createHash('sha256')
        .update(printer.printNode(ts.EmitHint.Unspecified, node, file))
        .digest('hex'),
    });
  const hasUnsafeContext = (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (node.type.getText(file) !== 'const') return true;
    }
    if (
      ts.isParameter(node) &&
      (!node.type ||
        [
          ts.SyntaxKind.ObjectKeyword,
          ts.SyntaxKind.AnyKeyword,
          ts.SyntaxKind.UnknownKeyword,
        ].includes(node.type.kind))
    )
      return true;
    return ts.forEachChild(node, hasUnsafeContext) === true;
  };
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      /^create\w*RuntimeContext$/u.test(node.name.getText(file)) &&
      hasUnsafeContext(node)
    ) {
      add(node.name.getText(file), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // Compatibility ports declare their own capabilities, independently of the legacy class.
  if (filename.endsWith('-legacy.port.ts')) {
    for (const node of file.statements) {
      if (
        ts.isImportDeclaration(node) &&
        /admin\.service(?:\.impl|\.legacy)?$/u.test(node.moduleSpecifier.text)
      ) {
        add(`legacy-import:${node.moduleSpecifier.text}`, node);
      }
    }
  }
  return findings;
}

export function collectRuntimeContextFindings(root) {
  const walk = (directory) =>
    readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const filename = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'generated' ? [] : walk(filename);
      if (!entry.name.endsWith('.ts') || /\.(?:spec|test|generated)\.ts$/u.test(entry.name))
        return [];
      const source = readFileSync(resolve(root, filename), 'utf8');
      return source.includes('RuntimeContext') || filename.endsWith('-legacy.port.ts')
        ? findRuntimeContextFindings(source, filename)
        : [];
    });
  return walk('apps/api/src').sort((a, b) => a.key.localeCompare(b.key, 'en'));
}

export function compareRuntimeContextBaseline(findings, baseline) {
  if (baseline.version !== 1 || !Array.isArray(baseline.exceptions))
    throw new Error('Invalid runtime context baseline.');
  const expected = new Map(baseline.exceptions.map((entry) => [entry.key, entry.definitionSha256]));
  if (expected.size !== baseline.exceptions.length)
    throw new Error('Duplicate runtime context baseline keys.');
  const violations = findings
    .filter((entry) => expected.get(entry.key) !== entry.definitionSha256)
    .map(
      (entry) =>
        `${entry.key}: declare explicit dependencies without legacy class imports, broad context parameters or type assertions.`,
    );
  const actual = new Set(findings.map((entry) => entry.key));
  for (const key of expected.keys()) {
    if (!actual.has(key))
      violations.push(`${key}: remove the obsolete runtime context baseline exception.`);
  }
  return violations;
}

export function assertRuntimeContextBoundaries(root) {
  const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'));
  const violations = compareRuntimeContextBaseline(collectRuntimeContextFindings(root), baseline);
  if (violations.length) throw new Error(violations.join('\n'));
}
