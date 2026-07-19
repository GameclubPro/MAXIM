import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildMiniappCssMetricBaseline,
  findMiniappCssArchitectureViolations,
} from './css-architecture.mjs';

const root = resolve(import.meta.dirname, '../../..');
const baselinePath = resolve(root, 'apps/miniapp/css-metrics-baseline.json');

if (process.argv.includes('--write-baseline')) {
  const baseline = buildMiniappCssMetricBaseline(root);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`Updated ${baselinePath}\n`);
} else {
  const violations = findMiniappCssArchitectureViolations(root, baselinePath);
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
