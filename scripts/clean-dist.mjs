import { rmSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2);

if (targets.length === 0) {
  throw new Error('Usage: node scripts/clean-dist.mjs <dist-path> [...]');
}

for (const target of targets) {
  const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
  const relativeTarget = relative(repoRoot, absoluteTarget);

  if (
    relativeTarget === '' ||
    relativeTarget.startsWith('..') ||
    isAbsolute(relativeTarget) ||
    basename(absoluteTarget) !== 'dist'
  ) {
    throw new Error(`Refusing to remove non-dist path outside the repository: ${target}`);
  }

  rmSync(absoluteTarget, { force: true, recursive: true });
}
