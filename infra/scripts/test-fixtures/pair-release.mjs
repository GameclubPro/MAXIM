import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// FLAG: Tests relocate fixed production paths in source; production exposes no path/UID override.
export function pairReleaseFixture(
  directory,
  helper,
  {
    sourceHelper = new URL('../lib/pair-release-admission.sh', import.meta.url),
    sourceReporter = new URL('../pair-release-state.mjs', import.meta.url),
  } = {},
) {
  const protectedDirectory = join(directory, 'pair-admission');
  const state = join(protectedDirectory, 'state');
  const majorRoot = join(directory, 'major');
  const karavanRoot = join(directory, 'karavan');
  for (const target of [
    protectedDirectory,
    state,
    majorRoot,
    join(karavanRoot, 'var/ops'),
    dirname(helper),
  ])
    mkdirSync(target, { recursive: true, mode: 0o700 });
  const relocate = (source) =>
    source
      .replaceAll('/var/lib/major-karavan-release', protectedDirectory)
      .replaceAll('/var/lib/maxim-deploy', majorRoot)
      .replaceAll('/var/www/Chat_bot', majorRoot)
      .replaceAll('/var/www/max-delivery-platform', karavanRoot)
      .replace(
        "pair_release_admission_root_uid() { printf '%s\\n' 0; }",
        `pair_release_admission_root_uid() { printf '%s\\n' ${process.getuid()}; }`,
      );
  const helperSource = relocate(readFileSync(sourceHelper, 'utf8'));
  writeFileSync(helper, helperSource);
  if (!existsSync(join(protectedDirectory, 'admission.sh')))
    writeFileSync(join(protectedDirectory, 'admission.sh'), helperSource, { mode: 0o444 });
  if (!existsSync(join(protectedDirectory, 'protocol-v1')))
    writeFileSync(join(protectedDirectory, 'protocol-v1'), 'major-karavan-release-v1\n', {
      mode: 0o444,
    });
  const file = join(state, 'admission.lock');
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  for (const lock of [
    join(majorRoot, 'deploy.lock'),
    join(karavanRoot, 'var/ops/karavan-production-operation.lock'),
  ]) {
    if (!existsSync(lock)) writeFileSync(lock, '', { mode: 0o600 });
  }
  const reporter = join(protectedDirectory, 'state.mjs');
  if (!existsSync(reporter))
    writeFileSync(reporter, relocate(readFileSync(sourceReporter, 'utf8')), { mode: 0o444 });
  chmodSync(join(protectedDirectory, 'protocol-v1'), 0o444);
  chmodSync(reporter, 0o444);
  return { helper, protectedDirectory, file, state, majorRoot, karavanRoot, reporter, relocate };
}
