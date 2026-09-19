import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function contractsSourceAliases(root, command) {
  if (command !== 'serve') return [];

  const manifest = JSON.parse(
    readFileSync(resolve(root, 'packages/contracts/package.json'), 'utf8'),
  );
  const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8'));
  return Object.keys(manifest.exports).map((key) => {
    if (key !== '.' && !/^\.\/[a-z0-9-]+$/u.test(key)) {
      throw new Error(`Unsupported contracts export: ${key}`);
    }
    const name = key === '.' ? 'index' : key.slice(2);
    const specifier = key === '.' ? '@maxim/contracts' : `@maxim/contracts/${name}`;
    const source = `packages/contracts/src/${name}.ts`;
    if (JSON.stringify(config.compilerOptions.paths[specifier]) !== JSON.stringify([source])) {
      throw new Error(`Contract source mapping is inconsistent: ${specifier}`);
    }
    const replacement = resolve(root, source);
    if (!existsSync(replacement)) throw new Error(`Missing contract source: ${source}`);
    // Exact matching prevents the root export from swallowing focused subpaths.
    return { find: new RegExp(`^${specifier}$`, 'u'), replacement };
  });
}
