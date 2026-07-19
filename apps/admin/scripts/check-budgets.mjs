import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const workspace = resolve(import.meta.dirname, '..');
const assetsDir = resolve(workspace, 'dist/assets');
const config = JSON.parse(readFileSync(resolve(workspace, 'bundle-budgets.json'), 'utf8'));

if (config.schemaVersion !== 1) {
  throw new Error('Unsupported Safety Desk bundle budget schema.');
}

const assets = readdirSync(assetsDir).map((name) => {
  const contents = readFileSync(resolve(assetsDir, name));
  return { name, rawBytes: contents.length, gzipBytes: gzipSync(contents).length };
});

for (const [label, extension, budget] of [
  ['JavaScript', '.js', config.javascript],
  ['CSS', '.css', config.css],
]) {
  const matching = assets.filter(({ name }) => name.endsWith(extension));
  const rawBytes = matching.reduce((total, asset) => total + asset.rawBytes, 0);
  const gzipBytes = matching.reduce((total, asset) => total + asset.gzipBytes, 0);
  assertBudget(`${label} raw`, rawBytes, budget.rawBytes, config.toleranceBytes);
  assertBudget(`${label} gzip`, gzipBytes, budget.gzipBytes, config.toleranceBytes);
  process.stdout.write(
    `${label}: ${format(rawBytes)} raw / ${format(gzipBytes)} gzip; budget ${format(budget.rawBytes)} / ${format(budget.gzipBytes)}\n`,
  );
}

function assertBudget(label, actual, budget, tolerance) {
  if (actual > budget + tolerance) {
    throw new Error(`${label}: ${format(actual)} exceeds ${format(budget)} + ${format(tolerance)} tolerance.`);
  }
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
