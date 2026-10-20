import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertInheritedDeployLock } from './legacy-cold-journal.mjs';
import { RETIREMENT_CUTOFF, retirementSnapshotDigest } from './publisher-obsolete-retirement.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = '/var/lib/maxim-deploy/publisher-obsolete-retirement';
const hash = /^[a-f0-9]{64}$/u;
export const executeRetirementCommand = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    stdio: [Object.hasOwn(options, 'input') ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();

export function parseRetirementArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === 'preview'))
    return { action: 'preview' };
  if (
    args.length === 3 &&
    args[0] === 'preview' &&
    args[1] === '--after-digest' &&
    hash.test(args[2])
  )
    return { action: 'preview', afterDigest: args[2] };
  if (
    args.length === 3 &&
    args[0] === 'apply' &&
    args[1] === '--reviewed-digest' &&
    hash.test(args[2])
  )
    return { action: 'apply', reviewedDigest: args[2] };
  throw new Error(
    'usage: publisher-obsolete-retirement [preview [--after-digest sha256] | apply --reviewed-digest sha256]',
  );
}

export async function probeRetirementAdminHealth(fetchImpl = fetch) {
  const proof = {};
  for (const endpoint of ['live', 'ready']) {
    const response = await fetchImpl(`http://127.0.0.1:3001/api/health/${endpoint}`, {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    const maxBytes = 256 * 1024;
    const declaredBytes = Number(response.headers.get('content-length'));
    if (
      !response.ok ||
      !response.body ||
      (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
    )
      throw new Error('runtime_health_unproved');
    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          await reader.cancel();
          throw new Error('runtime_health_unproved');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (JSON.parse(Buffer.concat(chunks, receivedBytes).toString('utf8'))?.ok !== true)
      throw new Error('runtime_health_unproved');
    proof[endpoint] = true;
  }
  return proof;
}

function captureRetirementRuntimeIdentity(run) {
  const sourceSha = run('git', ['rev-parse', 'HEAD']);
  if (
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    sourceSha !== process.env.MAXIM_EXPECTED_DEPLOY_SHA ||
    run('git', ['status', '--porcelain', '--untracked-files=no'])
  )
    throw new Error('clean_exact_tooling_source_required');
  const generations = [];
  const environments = {};
  for (const service of ['api-admin', 'api-publisher']) {
    const id = run('docker', [
      'compose',
      '--env-file',
      '.env',
      '-p',
      'infra',
      '-f',
      'infra/docker-compose.yml',
      'ps',
      '--status',
      'running',
      '-q',
      service,
    ]);
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('exact_running_roles_required');
    const rows = JSON.parse(run('docker', ['inspect', id]));
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.Id !== id ||
      row.State?.Running !== true ||
      row.State?.Status !== 'running' ||
      (Object.hasOwn(row.State, 'Health') && row.State.Health?.Status !== 'healthy') ||
      row.Config?.Labels?.['com.docker.compose.project'] !== 'infra' ||
      row.Config?.Labels?.['com.docker.compose.service'] !== service ||
      !/^sha256:[a-f0-9]{64}$/u.test(row.Image ?? '') ||
      !Number.isSafeInteger(row.RestartCount) ||
      row.RestartCount < 0 ||
      !Number.isFinite(Date.parse(row.State.StartedAt))
    )
      throw new Error('runtime_generation_unproved');
    const environment = (key) => {
      const values = row.Config.Env?.filter((entry) => entry.startsWith(`${key}=`));
      if (values?.length !== 1) throw new Error('publisher_identity_unproved');
      return values[0].slice(key.length + 1);
    };
    environments[service] = {
      publisher: environment('MAX_PUBLISHER_BOT_ID'),
      bot: environment('MAX_BOT_ID'),
      role: environment('APP_ROLE'),
    };
    generations.push({
      service,
      id,
      imageId: row.Image,
      startedAt: row.State.StartedAt,
      restartCount: row.RestartCount,
    });
  }
  const publisher = environments['api-publisher'];
  if (
    !/^[A-Za-z0-9_-]{3,128}$/u.test(publisher.publisher) ||
    publisher.publisher !== publisher.bot ||
    publisher.role !== 'publisher' ||
    environments['api-admin'].role !== 'admin' ||
    environments['api-admin'].publisher !== publisher.publisher ||
    environments['api-admin'].bot === publisher.publisher ||
    generations[0].imageId !== generations[1].imageId
  )
    throw new Error('publisher_identity_unproved');
  const images = JSON.parse(run('docker', ['image', 'inspect', generations[0].imageId]));
  const runtimeSha = images[0]?.Config?.Labels?.['org.opencontainers.image.revision'];
  if (
    images.length !== 1 ||
    images[0].Id !== generations[0].imageId ||
    !/^[a-f0-9]{40}$/u.test(runtimeSha ?? '')
  )
    throw new Error('immutable_runtime_image_required');
  return { sourceSha, runtimeSha, botId: publisher.publisher, generations };
}

export function captureRetirementRuntime(run = executeRetirementCommand) {
  const before = captureRetirementRuntimeIdentity(run);
  const admin = before.generations.find((row) => row.service === 'api-admin');
  // FLAG: Publisher is headless; strict HTTP health belongs to this exact admin
  // generation. Both roles must retain their complete image/restart identity.
  const source = `(${probeRetirementAdminHealth.toString()})().then((proof) => process.stdout.write(JSON.stringify(proof))).catch(() => { process.stderr.write('Publisher administrative health unavailable.\\n'); process.exitCode=1; });`;
  try {
    const proof = JSON.parse(
      run('docker', ['exec', admin.id, 'node', '--input-type=module', '-e', source], {
        timeout: 10_000,
        maxBuffer: 1024,
      }),
    );
    if (proof?.live !== true || proof?.ready !== true) throw new Error('missing_health_proof');
  } catch {
    throw new Error('runtime_health_unproved');
  }
  const after = captureRetirementRuntimeIdentity(run);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('runtime_changed_during_health_probe');
  return before;
}

function privateDirectory() {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('private_retirement_directory_required');
}

function readPlan(id) {
  if (!hash.test(id)) throw new Error('invalid_plan_digest');
  const fd = openSync(join(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 256 * 1024
    )
      throw new Error('private_plan_required');
    const plan = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      retirementSnapshotDigest(plan) !== id ||
      plan.version !== 1 ||
      plan.cutoff !== RETIREMENT_CUTOFF ||
      !Array.isArray(plan.candidates) ||
      plan.candidates.length > 96
    )
      throw new Error('retirement_plan_mismatch');
    return plan;
  } finally {
    closeSync(fd);
  }
}

function writePrivate(name, value) {
  const fd = openSync(
    join(directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directoryFd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export async function runRetirementHost(args) {
  assertInheritedDeployLock();
  privateDirectory();
  const before = captureRetirementRuntime();
  const selectedDigest = args.action === 'apply' ? args.reviewedDigest : args.afterDigest;
  const previous = selectedDigest ? readPlan(selectedDigest) : null;
  if (previous && JSON.stringify(previous.binding) !== JSON.stringify(before))
    throw new Error('retirement_runtime_or_source_changed');
  if (
    args.action === 'apply' &&
    (!previous ||
      Date.now() > Date.parse(previous.expiresAt) ||
      Date.now() < Date.parse(previous.createdAt))
  )
    throw new Error('fresh_reviewed_preview_required');
  const request = {
    action: args.action,
    cutoff: RETIREMENT_CUTOFF,
    botId: before.botId,
    deadlineMs: Date.now() + 80_000,
    ...(args.action === 'apply'
      ? { plan: previous }
      : previous
        ? { cursors: previous.nextCursors }
        : {}),
  };
  const helper = readFileSync(
    join(root, 'infra/scripts/publisher-obsolete-retirement.mjs'),
    'utf8',
  );
  const source = `${helper}\ntry { process.stdout.write(JSON.stringify(await runContainerRetirement(${JSON.stringify(request)}))+'\\n'); } catch { process.stderr.write('Publisher obsolete retirement refused; inspect private evidence and make a fresh preview.\\n'); process.exitCode=1; }\n`;
  let output;
  let failed = false;
  try {
    output = JSON.parse(
      executeRetirementCommand(
        'docker',
        [
          'exec',
          '-i',
          before.generations.find((row) => row.service === 'api-publisher').id,
          'node',
          '--input-type=module',
          '-',
        ],
        { input: source, timeout: 90_000, maxBuffer: 256 * 1024 },
      ),
    );
  } catch {
    failed = true;
  }
  const after = captureRetirementRuntime();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('runtime_changed_result_unaccepted');
  if (failed)
    throw new Error('retirement_failed_or_acknowledgement_unknown_fresh_preview_required');
  if (args.action === 'apply') {
    writePrivate(`${args.reviewedDigest}.applied-${Date.now()}.json`, {
      completedAt: new Date().toISOString(),
      previewDigest: args.reviewedDigest,
      binding: before,
      outcome: output,
    });
    return {
      action: 'apply',
      previewDigest: args.reviewedDigest,
      ...output,
      nextPreview: previous.report.sourceComplete ? null : { afterDigest: args.reviewedDigest },
      sourceComplete: previous.report.sourceComplete,
    };
  }
  const createdAt = new Date().toISOString();
  const plan = {
    version: 1,
    cutoff: RETIREMENT_CUTOFF,
    createdAt,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    binding: before,
    previousDigest: args.afterDigest ?? null,
    ...output,
  };
  const id = retirementSnapshotDigest(plan);
  writePrivate(`${id}.json`, plan);
  return {
    action: 'preview',
    cutoff: RETIREMENT_CUTOFF,
    previewDigest: id,
    expiresAt: plan.expiresAt,
    ...output.report,
    readPlans: output.readPlans,
    nextPreview: output.report.sourceComplete ? null : { afterDigest: id },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runRetirementHost(parseRetirementArgs(process.argv.slice(2))))}\n`,
    );
  } catch (error) {
    const safe = /^[a-z_]+$/u.test(error.message) ? error.message : 'retirement_request_refused';
    process.stderr.write(`Publisher obsolete retirement: ${safe}.\n`);
    process.exitCode = 1;
  }
}
