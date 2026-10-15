import { execFileSync, spawn } from 'node:child_process';
import { readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { assertFixedModeratorSource } from './assert-fixed-moderator-source.mjs';
const require = createRequire(import.meta.url);

export function assertPreservationFleet(fleet, manifest, sourceSha) {
  const component = manifest?.components?.['api-shared'];
  if (
    !/^[a-f0-9]{40}$/u.test(sourceSha ?? '') ||
    component?.sourceSha !== sourceSha ||
    component.imageRef !== `maxim-api:${sourceSha}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(component.imageId ?? '')
  )
    throw new Error('Preservation requires the exact current API release');
  if (
    fleet?.available !== true ||
    [
      'expectedRoleCount',
      'observedRoleCount',
      'singletonRoleCount',
      'runningRoleCount',
      'identityRoleCount',
      'exactImageRoleCount',
    ].some((key) => fleet[key] !== 14) ||
    [
      'duplicateContainerCount',
      'unexpectedApiContainerCount',
      'unexpectedMainContainerCount',
      'unexpectedScaleContainerCount',
      'unexpectedManualContainerCount',
    ].some((key) => fleet[key] !== 0)
  )
    throw new Error('Preservation requires all fourteen exact compatible API roles');
}

export function assertPreservationReadiness(value) {
  if (
    value?.ok !== true ||
    value.checks?.database !== true ||
    value.checks?.redis !== true ||
    value.checks?.queueLag?.ok !== true ||
    !Number.isFinite(value.checks.queueLag.operationalLagSec) ||
    value.checks.queueLag.operationalLagSec > 10
  )
    throw new Error('Preservation requires healthy dependencies and bounded live lag');
}

export function preservationDeadline(value, now = Date.now(), minimumRemaining = 1) {
  const deadline = Number(value);
  if (
    !Number.isSafeInteger(deadline) ||
    deadline - now < minimumRemaining ||
    deadline - now > 80000
  )
    throw new Error('Preservation deadline expired or invalid');
  return deadline;
}

const run = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function main() {
  const deadline = preservationDeadline(process.env.MAXIM_FIXED_MODERATOR_PRESERVATION_DEADLINE);
  const [action, ...args] = process.argv.slice(2);
  if (!['preview', 'apply', 'explain'].includes(action))
    throw new Error('Expected preview, explain or apply');
  const sourceSha = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  if (
    !/^[a-f0-9]{40}$/u.test(sourceSha ?? '') ||
    run('git', ['rev-parse', 'HEAD']) !== sourceSha ||
    run('git', ['status', '--porcelain=v1', '--untracked-files=normal'])
  )
    throw new Error('Preservation requires a clean exact source checkout');
  const manifest = JSON.parse(
    run(process.execPath, [
      'infra/scripts/release-manifest.mjs',
      'validate-current',
      '--state-dir',
      '/var/lib/maxim-deploy',
    ]),
  );
  assertFixedModeratorSource(sourceSha);
  const { probeApiFleet, DEFAULT_EXPECTED_API_SERVICES } = require('./monitor-capacity-probe.cjs');
  const fleet = await probeApiFleet(DEFAULT_EXPECTED_API_SERVICES);
  assertPreservationFleet(fleet, manifest, sourceSha);
  for (const port of [3001, 3002]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Readiness HTTP failure');
    assertPreservationReadiness(await response.json());
  }
  const id = run('docker', [
    'compose',
    '--env-file',
    '.env',
    '-p',
    'infra',
    '-f',
    'infra/docker-compose.yml',
    'ps',
    '-q',
    'api-admin',
  ]);
  if (
    !/^[a-f0-9]{64}$/u.test(id) ||
    run('docker', ['inspect', '--format', '{{.Image}}', id]) !==
      manifest.components['api-shared'].imageId
  )
    throw new Error('Admin container identity changed');
  let input;
  if (action === 'apply') {
    if (args.length !== 1 || !/^[a-f0-9]{64}$/u.test(args[0]))
      throw new Error('Reviewed digest required');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(0, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size === buffer.length) throw new Error('Plan too large');
    input = buffer.subarray(0, size);
  } else if (action === 'explain') {
    if (args.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(args[0]))
      throw new Error('Exact chat required');
  } else if (
    args.length > 2 ||
    !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(args[0] ?? '25') ||
    (args[1] && !/^[A-Za-z0-9_-]{1,128}$/u.test(args[1]))
  )
    throw new Error('Invalid bounded preview');
  preservationDeadline(deadline, Date.now(), 10000);
  const command = [
    'exec',
    '-i',
    '-e',
    `MAXIM_FIXED_MODERATOR_PRESERVATION_SOURCE=${sourceSha}`,
    '-e',
    `MAXIM_FIXED_MODERATOR_PRESERVATION_DEADLINE=${deadline}`,
    id,
    'node',
    'apps/api/dist/apps/api/src/scripts/preserve-fixed-moderators.js',
    '--source-sha',
    sourceSha,
    ...(action === 'apply'
      ? ['--apply', '--reviewed-digest', args[0]]
      : action === 'explain'
        ? ['--explain-chat', args[0]]
        : ['--limit', args[0] ?? '25', ...(args[1] ? ['--after', args[1]] : [])]),
  ];
  const status = await new Promise((resolve, reject) => {
    const child = spawn('docker', command, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, deadline - Date.now()));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (status !== 0)
    throw new Error(
      'Preservation refused or interrupted; retain the plan and confirmed operation results',
    );
  assertPreservationFleet(await probeApiFleet(DEFAULT_EXPECTED_API_SERVICES), manifest, sourceSha);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    // FLAG: Child-process exceptions can contain commands or credential-bearing stderr.
    const reason =
      error instanceof Error && !('cmd' in error) && !('stderr' in error)
        ? error.message
        : 'Preservation preflight or process failed';
    console.error(reason);
    process.exitCode = 1;
  });
