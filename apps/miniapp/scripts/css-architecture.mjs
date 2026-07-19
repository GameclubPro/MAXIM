import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import postcss from 'postcss';

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const ignoredDirectoryNames = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const importStatementPattern =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
const colorPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bhwb\(|\bcolor-mix\(/gu;

export function buildMiniappCssMetricBaseline(root) {
  const sourceRoot = resolve(root, 'apps/miniapp/src');
  const files = walkFiles(sourceRoot, new Set(['.css']));
  return {
    schemaVersion: 1,
    files: Object.fromEntries(
      files
        .map((filePath) => {
          const metrics = readCssMetrics(filePath);
          return [toRepoPath(root, filePath), { colors: metrics.colors.length, important: metrics.important.length }];
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function findMiniappCssArchitectureViolations(root, baselinePath) {
  const violations = [];
  const sourceRoot = resolve(root, 'apps/miniapp/src');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (baseline.schemaVersion !== 1 || !baseline.files || typeof baseline.files !== 'object') {
    throw new Error(`Invalid mini app CSS metric baseline: ${baselinePath}`);
  }

  for (const violation of findDirectCssLayerViolations(root, sourceRoot)) {
    violations.push(
      `${violation.importer} imports ${violation.cssPath}: ${violation.reason}`,
    );
  }

  const currentFiles = new Set();
  for (const filePath of walkFiles(sourceRoot, new Set(['.css']))) {
    const repoPath = toRepoPath(root, filePath);
    currentFiles.add(repoPath);
    const metrics = readCssMetrics(filePath);
    const allowed = baseline.files[repoPath] ?? { colors: 0, important: 0 };
    appendMetricViolations(violations, repoPath, 'raw color', metrics.colors, allowed.colors ?? 0);
    appendMetricViolations(
      violations,
      repoPath,
      '!important declaration',
      metrics.important,
      allowed.important ?? 0,
    );
  }

  for (const repoPath of Object.keys(baseline.files)) {
    if (!currentFiles.has(repoPath)) {
      violations.push(`${repoPath} remains in css-metrics-baseline.json but the CSS file is gone.`);
    }
  }

  return violations;
}

function appendMetricViolations(violations, repoPath, label, occurrences, allowed) {
  if (occurrences.length <= allowed) {
    return;
  }
  for (const occurrence of occurrences.slice(allowed)) {
    violations.push(
      `${repoPath}:${occurrence.line}:${occurrence.column} adds ${label} in ${occurrence.property}; define a route/component semantic token or reduce that file's baseline.`,
    );
  }
}

function readCssMetrics(filePath) {
  const root = postcss.parse(readFileSync(filePath, 'utf8'), { from: filePath });
  const colors = [];
  const important = [];
  root.walkDecls((declaration) => {
    const location = declaration.source?.start ?? { line: 1, column: 1 };
    if (!declaration.prop.startsWith('--')) {
      for (const match of declaration.value.matchAll(colorPattern)) {
        colors.push({
          line: location.line,
          column: location.column + declaration.prop.length + 2 + (match.index ?? 0),
          property: declaration.prop,
        });
      }
    }
    if (declaration.important) {
      important.push({ line: location.line, column: location.column, property: declaration.prop });
    }
  });
  return { colors, important };
}

function findDirectCssLayerViolations(root, sourceRoot) {
  const violations = [];
  for (const filePath of walkFiles(sourceRoot, sourceExtensions)) {
    const contents = readFileSync(filePath, 'utf8');
    for (const match of contents.matchAll(importStatementPattern)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (!specifier.startsWith('.') || !specifier.endsWith('.css')) {
        continue;
      }
      const cssPath = resolve(dirname(filePath), specifier);
      if (!existsSync(cssPath)) {
        violations.push({
          importer: toRepoPath(root, filePath),
          cssPath: toRepoPath(root, cssPath),
          reason: 'the imported CSS file does not exist',
        });
        continue;
      }
      const cssRoot = postcss.parse(readFileSync(cssPath, 'utf8'), { from: cssPath });
      const repoPath = toRepoPath(root, cssPath);
      const reason =
        repoPath === 'apps/miniapp/src/styles.css'
          ? getEntrypointViolation(cssRoot)
          : getWrappedLayerViolation(cssRoot);
      if (reason) {
        violations.push({ importer: toRepoPath(root, filePath), cssPath: repoPath, reason });
      }
    }
  }
  return violations;
}

function meaningfulNodes(cssRoot) {
  return cssRoot.nodes.filter((node) => node.type !== 'comment');
}

function getEntrypointViolation(cssRoot) {
  const nodes = meaningfulNodes(cssRoot);
  if (nodes.length === 0) {
    return 'the global entrypoint is empty';
  }
  for (const node of nodes) {
    if (node.type === 'atrule' && node.name === 'layer' && !node.nodes) {
      continue;
    }
    if (node.type === 'atrule' && node.name === 'import' && /\blayer\s*\(/u.test(node.params)) {
      continue;
    }
    return 'the global entrypoint may only declare layer order and layered @import rules';
  }
  return null;
}

function getWrappedLayerViolation(cssRoot) {
  const nodes = meaningfulNodes(cssRoot);
  if (nodes.length === 0) {
    return null;
  }
  for (const node of nodes) {
    if (node.type === 'atrule' && node.name === 'import' && !/\blayer\s*\(/u.test(node.params)) {
      return `CSS @import must include layer(...): ${node.toString()}`;
    }
  }
  if (
    nodes.length !== 1 ||
    nodes[0].type !== 'atrule' ||
    nodes[0].name !== 'layer' ||
    !nodes[0].nodes
  ) {
    return 'the entire file must be wrapped in one @layer block';
  }
  return null;
}

function walkFiles(directory, extensions) {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return ignoredDirectoryNames.has(entry) ? [] : walkFiles(path, extensions);
    }
    const extension = entry.slice(entry.lastIndexOf('.'));
    return stats.isFile() && extensions.has(extension) ? [path] : [];
  });
}

function toRepoPath(root, filePath) {
  return relative(root, filePath).split('\\').join('/');
}
