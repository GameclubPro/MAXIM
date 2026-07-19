import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE_IMPORT_ALLOWLIST = new Set(['broadcast.ts', 'index.ts', 'settings.ts', 'system.ts']);

function toRepoPath(root, filePath) {
  return relative(root, filePath).split('\\').join('/');
}

function walk(directory, extension) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? walk(path, extension)
      : path.endsWith(extension)
        ? [path]
        : [];
  });
}

function expectedContractEntry(exportKey) {
  const name = exportKey === '.' ? 'index' : exportKey.slice(2);
  const importKey = exportKey === '.' ? '@maxim/contracts' : `@maxim/contracts/${name}`;

  return {
    name,
    importKey,
    sourcePath: `packages/contracts/src/${name}.ts`,
    typeTarget: `./dist/${name}.d.ts`,
    defaultTarget: `./dist/${name}.js`,
    jestTarget: `<rootDir>/../../packages/contracts/src/${name}.ts`,
  };
}

export function findContractsArchitectureViolations(root) {
  const violations = [];
  const contractsSrcRoot = resolve(root, 'packages/contracts/src');
  const contractsPackagePath = resolve(root, 'packages/contracts/package.json');
  const tsconfigPath = resolve(root, 'tsconfig.base.json');
  const apiJestConfigPath = resolve(root, 'apps/api/jest.config.cjs');

  for (const filePath of walk(contractsSrcRoot, '.js')) {
    violations.push({
      message: `${toRepoPath(root, filePath)} is generated JavaScript under contracts src and must not be tracked.`,
    });
  }

  const contractsPackage = JSON.parse(readFileSync(contractsPackagePath, 'utf8'));
  const packageExports = contractsPackage.exports ?? {};
  const entries = Object.keys(packageExports).map(expectedContractEntry);
  const expectedKeys = new Set(entries.map((entry) => entry.importKey));
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  const tsPaths = tsconfig.compilerOptions?.paths ?? {};
  const require = createRequire(apiJestConfigPath);
  delete require.cache[require.resolve(apiJestConfigPath)];
  const jestMappers = require(apiJestConfigPath).moduleNameMapper ?? {};

  for (const entry of entries) {
    const sourceName = entry.sourcePath.slice(entry.sourcePath.lastIndexOf('/') + 1);
    if (CORE_IMPORT_ALLOWLIST.has(sourceName)) {
      continue;
    }

    const sourcePath = resolve(root, entry.sourcePath);
    if (
      existsSync(sourcePath) &&
      /from\s+['"]\.\/core\.js['"]/u.test(readFileSync(sourcePath, 'utf8'))
    ) {
      violations.push({
        message: `${entry.sourcePath} is a focused contract entry and must not import the root core module.`,
      });
    }
  }

  for (const entry of entries) {
    const exportDefinition = packageExports[entry.name === 'index' ? '.' : `./${entry.name}`];
    if (
      exportDefinition?.types !== entry.typeTarget ||
      exportDefinition?.default !== entry.defaultTarget
    ) {
      violations.push({
        message: `packages/contracts/package.json export ${entry.importKey} must target ${entry.typeTarget} and ${entry.defaultTarget}.`,
      });
    }

    if (!existsSync(resolve(root, entry.sourcePath))) {
      violations.push({
        message: `Contract export ${entry.importKey} has no source file ${entry.sourcePath}.`,
      });
    }

    const expectedTsPath = [entry.sourcePath];
    if (JSON.stringify(tsPaths[entry.importKey]) !== JSON.stringify(expectedTsPath)) {
      violations.push({
        message: `tsconfig.base.json must map ${entry.importKey} exactly to ${entry.sourcePath}.`,
      });
    }

    const mapperKey = `^${entry.importKey}$`;
    if (jestMappers[mapperKey] !== entry.jestTarget) {
      violations.push({
        message: `apps/api/jest.config.cjs must map ${entry.importKey} exactly to ${entry.jestTarget}.`,
      });
    }
  }

  for (const key of Object.keys(tsPaths)) {
    if (key.startsWith('@maxim/contracts') && !expectedKeys.has(key)) {
      violations.push({
        message: `tsconfig.base.json maps ${key}, but packages/contracts does not export it.`,
      });
    }
  }

  for (const mapperPattern of Object.keys(jestMappers)) {
    const importKey = mapperPattern.startsWith('^@maxim/contracts')
      ? mapperPattern.slice(1, -1)
      : null;
    if (importKey && !expectedKeys.has(importKey)) {
      violations.push({
        message: `apps/api/jest.config.cjs maps ${importKey}, but packages/contracts does not export it.`,
      });
    }
  }

  return violations;
}

export function assertContractBuildOutputs(root) {
  const contractsPackage = JSON.parse(
    readFileSync(resolve(root, 'packages/contracts/package.json'), 'utf8'),
  );
  const missing = [];

  for (const exportDefinition of Object.values(contractsPackage.exports ?? {})) {
    for (const target of [exportDefinition.types, exportDefinition.default]) {
      const outputPath = resolve(root, 'packages/contracts', target);
      if (!existsSync(outputPath)) {
        missing.push(toRepoPath(root, outputPath));
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Contract build outputs are missing:\n${missing.join('\n')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  if (process.argv.includes('--build-output')) {
    assertContractBuildOutputs(root);
    process.exit(0);
  }

  const violations = findContractsArchitectureViolations(root);

  for (const violation of violations) {
    console.error(violation.message);
  }

  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
