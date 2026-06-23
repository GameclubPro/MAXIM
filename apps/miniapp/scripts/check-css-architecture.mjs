import { dirname, relative, resolve } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const root = resolve(import.meta.dirname, '../../..');
const miniappSourceRoot = resolve(root, 'apps/miniapp/src');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const cssExtension = new Set(['.css']);
const ignoredDirectoryNames = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const importStatementPattern =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

const metricGuards = [
  {
    name: 'hardcoded color references outside tokens.css',
    max: 6291,
    count: countHardcodedColorReferences,
    reason:
      'New colors should be introduced through semantic design tokens instead of component-local literals.',
  },
  {
    name: '!important declarations',
    max: 8,
    count: countImportantDeclarations,
    reason:
      'New cascade fixes should use layers, scopes, and tokens instead of adding specificity escapes.',
  },
];

let failed = false;

for (const violation of findDirectCssLayerViolations()) {
  failed = true;
  console.error(
    [
      `${violation.importer} imports ${violation.cssPath} without full CSS cascade-layer coverage.`,
      violation.reason,
      'Every miniapp CSS file imported directly from TS/TSX/JS must be fully wrapped in an @layer block.',
      'Keep globally imported base files routed through apps/miniapp/src/styles.css with @import ... layer(...).',
    ].join('\n'),
  );
}

for (const guard of metricGuards) {
  const actual = guard.count();
  if (actual <= guard.max) {
    continue;
  }

  failed = true;
  console.error(
    [
      `Miniapp CSS has ${actual} ${guard.name}, over the ${guard.max} refactor guard.`,
      guard.reason,
      'If this growth is intentional, update the guard in the same change with the architectural reason.',
    ].join('\n'),
  );
}

if (failed) {
  process.exitCode = 1;
}

function findDirectCssLayerViolations() {
  const violations = [];

  for (const filePath of walkFilesByExtension(miniappSourceRoot, sourceExtensions)) {
    const contents = readFileSync(filePath, 'utf8');
    for (const match of contents.matchAll(importStatementPattern)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (!specifier.startsWith('.') || !specifier.endsWith('.css')) {
        continue;
      }

      const cssPath = resolve(dirname(filePath), specifier);
      const cssContents = readFileSync(cssPath, 'utf8');
      if (toRepoPath(cssPath) === 'apps/miniapp/src/styles.css') {
        const entrypointViolationReason = getCssEntrypointViolationReason(cssContents);
        if (!entrypointViolationReason) {
          continue;
        }

        violations.push({
          importer: toRepoPath(filePath),
          cssPath: toRepoPath(cssPath),
          reason: entrypointViolationReason,
        });
        continue;
      }

      const layerViolationReason = getCssLayerViolationReason(cssContents);
      if (!layerViolationReason) {
        continue;
      }

      violations.push({
        importer: toRepoPath(filePath),
        cssPath: toRepoPath(cssPath),
        reason: layerViolationReason,
      });
    }
  }

  return violations;
}

function countHardcodedColorReferences() {
  const colorPattern =
    /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bhwb\(|\bcolor-mix\(/gu;
  let count = 0;

  for (const filePath of walkFilesByExtension(miniappSourceRoot, cssExtension)) {
    if (toRepoPath(filePath) === 'apps/miniapp/src/styles/tokens.css') {
      continue;
    }

    count += stripCssComments(readFileSync(filePath, 'utf8')).match(colorPattern)?.length ?? 0;
  }

  return count;
}

function countImportantDeclarations() {
  let count = 0;

  for (const filePath of walkFilesByExtension(miniappSourceRoot, cssExtension)) {
    count += stripCssComments(readFileSync(filePath, 'utf8')).match(/!important\b/gu)?.length ?? 0;
  }

  return count;
}

function getCssLayerViolationReason(contents) {
  const withoutComments = stripCssComments(contents);
  const trimmed = withoutComments.trim();
  if (!trimmed) {
    return null;
  }

  const importViolation = findUnlayeredCssImport(trimmed);
  if (importViolation) {
    return `CSS @import must include layer(...): ${importViolation}`;
  }

  if (!/^@layer\s+[-\w.]+(?:\s*,\s*[-\w.]+)*\s*\{/u.test(trimmed)) {
    return 'The file must start with a wrapping @layer <name> { ... } block.';
  }

  const endIndex = findMatchingBlockEnd(trimmed, trimmed.indexOf('{'));
  if (endIndex < 0) {
    return 'The opening @layer block is not balanced.';
  }

  const trailing = trimmed.slice(endIndex + 1).trim();
  if (trailing) {
    return 'Top-level CSS remains after the opening @layer block; keep the whole file inside the layer.';
  }

  return null;
}

function getCssEntrypointViolationReason(contents) {
  const withoutComments = stripCssComments(contents);
  const trimmed = withoutComments.trim();
  if (!trimmed) {
    return 'The global CSS entrypoint must declare cascade layers and import layered CSS files.';
  }

  const importViolation = findUnlayeredCssImport(trimmed);
  if (importViolation) {
    return `CSS @import must include layer(...): ${importViolation}`;
  }

  const withoutLayerList = trimmed.replace(
    /^@layer\s+[-\w.]+(?:\s*,\s*[-\w.]+)*\s*;\s*/u,
    '',
  );
  const withoutLayeredImports = withoutLayerList
    .replace(/@import\s+(?:url\()?['"][^'"]+\.css['"]\)?\s+layer\([-\w.]+\)\s*;\s*/gu, '')
    .trim();

  if (withoutLayeredImports) {
    return 'The global CSS entrypoint may only declare layer order and import CSS with layer(...).';
  }

  return null;
}

function findUnlayeredCssImport(contents) {
  const importPattern = /@import\s+(?:url\()?['"][^'"]+\.css['"]\)?[^;]*;/gu;
  for (const match of contents.matchAll(importPattern)) {
    if (!/\blayer\s*\(/u.test(match[0])) {
      return match[0];
    }
  }

  return null;
}

function findMatchingBlockEnd(contents, openBraceIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openBraceIndex; index < contents.length; index += 1) {
    const char = contents[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripCssComments(contents) {
  return contents.replace(/\/\*[\s\S]*?\*\//gu, '');
}

function walkFilesByExtension(directory, extensions) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      if (ignoredDirectoryNames.has(entry)) {
        continue;
      }
      files.push(...walkFilesByExtension(entryPath, extensions));
      continue;
    }

    if (stats.isFile() && extensions.has(readExtension(entry))) {
      files.push(entryPath);
    }
  }

  return files;
}

function readExtension(fileName) {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index) : '';
}

function toRepoPath(filePath) {
  return relative(root, filePath).split('\\').join('/');
}
