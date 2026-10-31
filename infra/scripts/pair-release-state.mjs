#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, lstat, stat, readFile, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const paths = Object.freeze({
  majorManifest: '/var/lib/maxim-deploy/current.json',
  karavanManifest: '/var/www/max-delivery-platform/var/ops/karavan-release-current.json',
  majorEnvironment: '/var/www/Chat_bot/.env',
  karavanEnvironment: '/var/www/max-delivery-platform/.env.karavan',
  majorRoot: '/var/www/Chat_bot',
  karavanRoot: '/var/www/max-delivery-platform',
  admission: '/var/lib/major-karavan-release/state/admission.owner',
  admissionLock: '/var/lib/major-karavan-release/state/admission.lock',
});
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sha = (value) => (/^[a-f0-9]{40}$/u.test(value ?? '') ? value : null);
const timestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? value
    : null;
const smokeLabels = new Set([
  'inventory-only',
  'api-local-live',
  'api-local-ready',
  'api-admin-live',
  'api-admin-ready',
  'api-public-live',
  'api-commercial-ocr-version',
  'api-media-analysis-tesseract-rus-eng',
  'api-media-analysis-shadow',
  'api-media-analysis-native-raster',
  'api-media-analysis-internal-ready',
  'api-ocr-native-sandbox-isolation',
  'api-ocr-native-sandbox-uds',
  'api-ocr-native-sandbox-process-clean',
  'api-photo-native-sandbox-isolation',
  'api-photo-native-sandbox-uds',
  'miniapp-major-static',
  'miniapp-major-static-local',
  'admin-static',
  'webhook-queues-released',
  'recovery-finalizer-runtime-stable',
  'eraser-exact-source-ready',
  'eraser-inherited-source-ready',
  'api-statistics-central-epoch',
]);

async function boundedFile(file) {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw new Error('Pair state file cannot be read safely');
  });
  if (!fd) return null;
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > 1_048_576 || before.nlink !== 1)
      throw new Error('Unsafe pair state file');
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length > 1_048_576
    )
      throw new Error('Pair state changed during observation');
    const current = await lstat(file);
    if (current.ino !== after.ino || current.dev !== after.dev || current.isSymbolicLink())
      throw new Error('Pair state file identity changed');
    return { bytes, sha256: digest(bytes) };
  } finally {
    await fd.close();
  }
}

async function checkout(root) {
  try {
    const { stdout } = await execute('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      timeout: 2_000,
      maxBuffer: 1_024,
    });
    return sha(stdout.trim());
  } catch {
    return null;
  }
}

async function snapshot() {
  const [majorFile, karavanFile, majorEnv, karavanEnv, majorCheckout, karavanCheckout] =
    await Promise.all([
      boundedFile(paths.majorManifest),
      boundedFile(paths.karavanManifest),
      boundedFile(paths.majorEnvironment),
      boundedFile(paths.karavanEnvironment),
      checkout(paths.majorRoot),
      checkout(paths.karavanRoot),
    ]);
  let major;
  let karavan;
  try {
    major = majorFile ? JSON.parse(majorFile.bytes.toString('utf8')) : null;
    karavan = karavanFile ? JSON.parse(karavanFile.bytes.toString('utf8')) : null;
  } catch {
    throw new Error('Pair release manifest is invalid');
  }
  const components = Object.entries(major?.components ?? {})
    .map(([id, value]) => {
      if (!['api-shared', 'miniapp-major-static', 'admin-static', 'eraser'].includes(id))
        throw new Error('Unknown Major release component');
      return {
        id,
        sourceSha: sha(value.sourceSha),
        imageId: /^sha256:[a-f0-9]{64}$/u.test(value.imageId ?? '') ? value.imageId : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (major?.smokes !== undefined && (!Array.isArray(major.smokes) || major.smokes.length > 256))
    throw new Error('Invalid Major smoke inventory');
  const smokes = [
    ...new Set((major?.smokes ?? []).filter((value) => smokeLabels.has(value))),
  ].sort();
  return {
    schemaVersion: 1,
    protocol: 'major-karavan-release-v1',
    major: {
      manifestSha256: majorFile?.sha256 ?? null,
      createdAt: timestamp(major?.createdAt),
      targetSha: sha(major?.targetSha),
      checkoutSha: majorCheckout,
      components,
      smokes,
      unreportedSmokeCount: (major?.smokes?.length ?? 0) - smokes.length,
    },
    karavan: {
      manifestSha256: karavanFile?.sha256 ?? null,
      checkoutSha: karavanCheckout,
      commit: sha(karavan?.git?.commit),
      originCommit: sha(karavan?.origin?.commit),
      deliveryMode: ['origin', 'cdn'].includes(karavan?.deliveryMode) ? karavan.deliveryMode : null,
      smoke: {
        status: ['passed', 'failed', 'warn', 'skipped'].includes(karavan?.smoke?.status)
          ? karavan.smoke.status
          : null,
        completedAt: timestamp(karavan?.smoke?.completedAt),
      },
    },
    configuration: {
      majorSha256: majorEnv?.sha256 ?? null,
      karavanSha256: karavanEnv?.sha256 ?? null,
    },
  };
}

function ownerFields(file) {
  if (!file) return null;
  const entries = file.bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=');
      if (index < 1) throw new Error('Invalid admission owner metadata');
      return [line.slice(0, index), line.slice(index + 1)];
    });
  if (entries.length > 32 || new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error('Invalid admission owner metadata');
  return Object.fromEntries(entries);
}

async function holderIsAlive(owner) {
  if (
    !/^[1-9][0-9]*$/u.test(owner?.pid ?? '') ||
    !/^[0-9]+$/u.test(owner?.start ?? '') ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(owner?.boot ?? '')
  )
    throw new Error('Admission holder process identity is invalid');
  try {
    const [raw, boot] = await Promise.all([
      readFile(`/proc/${owner.pid}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (!/^[0-9]+$/u.test(fields[19] ?? '')) throw new Error('Invalid process observation');
    return fields[0] !== 'Z' && fields[19] === owner.start && boot.trim() === owner.boot;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
    throw new Error('Admission holder identity cannot be inspected', { cause: error });
  }
}

async function holderIdentityMatches(owner) {
  if (!(await holderIsAlive(owner))) return false;
  try {
    return digest(await readlink(`/proc/${owner.pid}/cwd`)) === owner.cwd;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
    throw new Error('Admission holder working directory cannot be inspected', { cause: error });
  }
}

async function admissionState() {
  const file = await boundedFile(paths.admission);
  if (!file) {
    try {
      await execute('flock', ['-n', '--shared', paths.admissionLock, 'true'], {
        timeout: 1_000,
        maxBuffer: 1_024,
      });
      return { status: 'free', ownerSha256: null };
    } catch {
      return { status: 'unknown', ownerSha256: null };
    }
  }
  const owner = ownerFields(file);
  let held = false;
  if ((await holderIdentityMatches(owner)) && /^[1-9][0-9]{1,5}$/u.test(owner.fd ?? '')) {
    try {
      const [lock, descriptor, info] = await Promise.all([
        stat(paths.admissionLock, { bigint: true }),
        stat(`/proc/${owner.pid}/fd/${owner.fd}`, { bigint: true }),
        readFile(`/proc/${owner.pid}/fdinfo/${owner.fd}`, 'utf8'),
      ]);
      held =
        `${lock.dev}:${lock.ino}` === owner.inode &&
        lock.dev === descriptor.dev &&
        lock.ino === descriptor.ino &&
        /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info);
    } catch {
      held = false;
    }
  }
  return {
    status: held ? 'held' : 'unknown',
    ownerSha256: file.sha256,
    product: ['major', 'karavan'].includes(owner.product) ? owner.product : null,
    mode: ['runtime', 'tooling'].includes(owner.mode) ? owner.mode : null,
    targetSha: sha(owner.target),
    startedAt: timestamp(owner.started_at),
    initialStateSha256: /^[a-f0-9]{64}$/u.test(owner.initial_state ?? '')
      ? owner.initial_state
      : null,
  };
}

async function stableState() {
  const first = await snapshot();
  const second = await snapshot();
  const fingerprint = digest(JSON.stringify(first));
  if (fingerprint !== digest(JSON.stringify(second)))
    throw new Error('Pair state changed during observation');
  return { ...second, fingerprint };
}

async function assertNoReleaseActors() {
  const pattern =
    '[v]ps-pull-build-up[.]sh|[v]ps-runtime-rollback[.]sh|[v]ps-release-rollback[.]sh|[v]ps-finalize-release-recovery[.]sh|[r]elease-karavan[.]sh|[v]ps-deploy-karavan[.]sh|[v]ps-rollback-karavan[.]sh|[d]ocker (compose|buildx).* (infra|karavan|maxim)[^ ]*';
  let output;
  try {
    output = (await execute('pgrep', ['-f', pattern], { timeout: 2_000, maxBuffer: 8_192 })).stdout;
  } catch (error) {
    if (error.code === 1) return;
    throw new Error('Release actor observation is unavailable', { cause: error });
  }
  const pids = output.trim().split('\n');
  if (pids.length > 256) throw new Error('Release actor observation exceeds its bound');
  for (const pid of pids) {
    if (!/^[1-9][0-9]*$/u.test(pid)) throw new Error('Release actor observation is invalid');
    try {
      const [cwd, command] = await Promise.all([
        readlink(`/proc/${pid}/cwd`),
        readFile(`/proc/${pid}/cmdline`),
      ]);
      if (command.length > 65_536) throw new Error('Release actor observation exceeds its bound');
      if (
        [paths.majorRoot, paths.karavanRoot].some(
          (root) =>
            cwd === root ||
            cwd.startsWith(`${root}/`) ||
            command
              .toString('utf8')
              .split('\0')
              .some((arg) => arg.startsWith(`${root}/`)),
        )
      )
        throw new Error('A release or build actor remains active');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code))
        throw error.message === 'A release or build actor remains active'
          ? error
          : new Error('Release actor observation is unavailable');
    }
  }
}

async function reconciliationProof(args) {
  if (args.length !== 5 && args.length !== 6) throw new Error('Invalid reconciliation arguments');
  const [ownerSha256, expectedState, product, target, mode, selected = ''] = args;
  if (
    !/^[a-f0-9]{64}$/u.test(ownerSha256) ||
    !/^[a-f0-9]{64}$/u.test(expectedState) ||
    !sha(target) ||
    !['major', 'karavan'].includes(product) ||
    !['runtime', 'tooling'].includes(mode)
  )
    throw new Error('Invalid reconciliation identity');
  const file = await boundedFile(paths.admission);
  const owner = ownerFields(file);
  if (
    !file ||
    file.sha256 !== ownerSha256 ||
    owner.protocol !== 'major-karavan-release-v1' ||
    owner.product !== product ||
    owner.mode !== mode ||
    owner.target !== target ||
    !timestamp(owner.started_at)
  )
    throw new Error('Admission owner or selected target changed');
  // FLAG: A live holder changing cwd loses authority, but never proves that its action ended.
  if (await holderIsAlive(owner)) throw new Error('Admission owner is still alive');
  const current = await stableState();
  if (current.fingerprint !== expectedState)
    throw new Error('Pair state changed before reconciliation');
  await assertNoReleaseActors();
  const components = selected ? selected.split(',') : [];
  if (
    new Set(components).size !== components.length ||
    components.some(
      (id) => !['api-shared', 'miniapp-major-static', 'admin-static', 'eraser'].includes(id),
    )
  )
    throw new Error('Invalid selected components');
  if (mode === 'tooling') {
    if (components.length || current[product].checkoutSha !== target)
      throw new Error('Tooling source outcome is unproved');
  } else if (product === 'major') {
    if (
      !components.length ||
      current.major.targetSha !== target ||
      !current.major.createdAt ||
      Date.parse(current.major.createdAt) < Date.parse(owner.started_at)
    )
      throw new Error('Fresh Major release manifest is unproved');
    const required = {
      'api-shared': [
        'api-local-live',
        'api-local-ready',
        'api-admin-live',
        'api-admin-ready',
        'api-public-live',
      ],
      'miniapp-major-static': ['miniapp-major-static'],
      'admin-static': ['admin-static'],
      eraser: ['eraser-exact-source-ready'],
    };
    for (const id of components) {
      const component = current.major.components.find((value) => value.id === id);
      if (
        !component?.imageId ||
        component.sourceSha !== target ||
        required[id].some((label) => !current.major.smokes.includes(label))
      )
        throw new Error('Selected Major component outcome is unproved');
    }
  } else if (
    components.length ||
    current.karavan.commit !== target ||
    current.karavan.originCommit !== target ||
    current.karavan.smoke.status !== 'passed' ||
    !current.karavan.smoke.completedAt ||
    Date.parse(current.karavan.smoke.completedAt) < Date.parse(owner.started_at)
  )
    throw new Error('Fresh Karavan release manifest is unproved');
  if (
    (await boundedFile(paths.admission))?.sha256 !== ownerSha256 ||
    (await stableState()).fingerprint !== expectedState
  )
    throw new Error('Reconciliation inputs changed');
  return {
    schemaVersion: 1,
    protocol: 'major-karavan-release-v1',
    kind: 'interrupted-owner-reconciled',
    ownerSha256,
    fingerprint: expectedState,
    product,
    targetSha: target,
    mode,
    components,
    observedAt: new Date().toISOString(),
  };
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--reconcile-proof')
    process.stdout.write(`${JSON.stringify(await reconciliationProof(args.slice(1)))}\n`);
  else {
    if (args.some((arg) => arg !== '--fingerprint') || args.length > 1)
      throw new Error('Unsupported state reporter argument');
    const current = await stableState();
    process.stdout.write(
      args[0] === '--fingerprint'
        ? `${current.fingerprint}\n`
        : `${JSON.stringify({ ...current, admission: await admissionState(), observedAt: new Date().toISOString() })}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`[pair-release-state] ${error.message}\n`);
  process.exitCode = 1;
}
