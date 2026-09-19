import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const baselinePath = 'scripts/api-http-input-baseline.json';
const inputDecorators = new Set(['Query', 'Body']);
const validatingPipes = new Set([
  'ParseIntPipe',
  'ParseBoolPipe',
  'ParseUUIDPipe',
  'ParseEnumPipe',
]);
const printer = ts.createPrinter({ removeComments: true });

export function findHttpInputFindings(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = new Map();
  const namespaces = new Set();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@nestjs/common')
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        imports.set(specifier.name.text, (specifier.propertyName ?? specifier.name).text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  const nestName = (node) => {
    if (ts.isIdentifier(node)) return imports.get(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      return node.name.text;
    }
    return undefined;
  };
  const findings = [];
  function visit(node) {
    if (ts.isParameter(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call) || !inputDecorators.has(nestName(call.expression))) continue;
        if (node.type?.kind === ts.SyntaxKind.UnknownKeyword) continue;
        const pipes = call.arguments.slice(ts.isStringLiteral(call.arguments[0] ?? file) ? 1 : 0);
        if (
          pipes.some((pipe) =>
            validatingPipes.has(nestName(ts.isNewExpression(pipe) ? pipe.expression : pipe)),
          )
        )
          continue;
        const handler = node.parent;
        const owner = handler.parent;
        findings.push({
          key: `${filename}:${owner.name?.getText(file) ?? '<anonymous>'}.${handler.name?.getText(file) ?? '<anonymous>'}:${node.name.getText(file)}`,
          handlerSha256: createHash('sha256')
            .update(printer.printNode(ts.EmitHint.Unspecified, handler, file))
            .digest('hex'),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return findings;
}

export function collectHttpInputFindings(root) {
  function walk(directory) {
    return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const filename = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'generated' ? [] : walk(filename);
      if (!entry.name.endsWith('.ts') || /\.(spec|test|generated)\.ts$/u.test(entry.name))
        return [];
      const source = readFileSync(resolve(root, filename), 'utf8');
      return source.includes('@nestjs/common') ? findHttpInputFindings(source, filename) : [];
    });
  }
  return walk('apps/api/src').sort((a, b) => a.key.localeCompare(b.key, 'en'));
}

export function compareHttpInputBaseline(findings, baseline) {
  if (baseline.version !== 1 || !Array.isArray(baseline.exceptions))
    throw new Error('Invalid HTTP input baseline.');
  const expected = new Map(baseline.exceptions.map((entry) => [entry.key, entry.handlerSha256]));
  if (expected.size !== baseline.exceptions.length)
    throw new Error('Duplicate HTTP input baseline keys.');
  const violations = findings
    .filter((entry) => expected.get(entry.key) !== entry.handlerSha256)
    .map(
      (entry) =>
        `${entry.key}: accept unknown and parse a runtime schema before use (or use a supported validating pipe).`,
    );
  const actual = new Set(findings.map((entry) => entry.key));
  for (const key of expected.keys()) {
    if (!actual.has(key))
      violations.push(`${key}: remove the obsolete HTTP input baseline exception.`);
  }
  return violations;
}

export function assertHttpInputBoundaries(root) {
  const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'));
  const violations = compareHttpInputBaseline(collectHttpInputFindings(root), baseline);
  if (violations.length) throw new Error(violations.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    assertHttpInputBoundaries(resolve(import.meta.dirname, '..'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
