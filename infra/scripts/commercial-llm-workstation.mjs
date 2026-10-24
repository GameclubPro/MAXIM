#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  renameSync,
  chmodSync,
  unlinkSync,
  copyFileSync,
  readlinkSync,
  mkdtempSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import {
  WORKSTATION_ARTIFACTS,
  WORKSTATION_IDENTITY,
  WORKSTATION_SSH_ARGS,
  workstationModelArgs,
} from './commercial-llm-workstation-profile.mjs';
import {
  attestWorkstationModel,
  workstationSession,
} from './commercial-llm-workstation-worker.mjs';
const root = join(homedir(), '.local/share/maxim-llm');
const state = join(root, 'service');
const scriptNames = [
  'commercial-llm-workstation.mjs',
  'commercial-llm-workstation-profile.mjs',
  'commercial-llm-workstation-worker.mjs',
];
const shellQuote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const hash = (path) =>
  new Promise((resolveHash, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(digest.digest('hex')));
  });
function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value) + '\n', {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('private_file_required');
}
function processStart(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  } catch {
    return null;
  }
}
function running() {
  try {
    const record = JSON.parse(readFileSync(join(state, 'status.json'), 'utf8'));
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid < 2 ||
      !record.startTicks ||
      processStart(record.pid) !== record.startTicks
    )
      return null;
    const args = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0');
    if (!args.includes(join(record.bundle, scriptNames[0])) || !args.includes('run')) return null;
    return record;
  } catch {
    return null;
  }
}
async function artifactChecks() {
  for (const artifact of WORKSTATION_ARTIFACTS) {
    const path = join(root, artifact.name),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== artifact.bytes ||
      (await hash(path)) !== artifact.sha256
    )
      throw new Error('artifact_identity_refused');
  }
}
function walkFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(path, base);
      if (entry.isSymbolicLink()) return [path.slice(base.length + 1)];
      if (!entry.isFile()) throw new Error('runtime_file_refused');
      return [path.slice(base.length + 1)];
    })
    .sort();
}
async function verifyBundle(bundle) {
  const files = JSON.parse(readFileSync(join(bundle, 'files.json'), 'utf8'));
  const actual = walkFiles(bundle).filter((name) => name !== 'files.json');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(files).sort()))
    throw new Error('installed_files_changed');
  for (const [name, expected] of Object.entries(files)) {
    const path = join(bundle, name),
      stat = lstatSync(path);
    if (expected.target !== undefined) {
      if (
        !stat.isSymbolicLink() ||
        readlinkSync(path) !== expected.target ||
        !resolve(dirname(path), expected.target).startsWith(bundle + '/')
      )
        throw new Error('installed_link_changed');
    } else if (!stat.isFile() || stat.isSymbolicLink() || (await hash(path)) !== expected.sha256)
      throw new Error('installed_file_changed');
  }
}

async function install() {
  if (running()) throw new Error('stop_before_install');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  await artifactChecks();
  const source = dirname(process.argv[1]);
  const bundleId = createHash('sha256');
  for (const name of scriptNames) bundleId.update(readFileSync(join(source, name)));
  const bundle = join(state, 'bundles', bundleId.digest('hex'));
  if (!existsSync(bundle)) {
    mkdirSync(dirname(bundle), { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(dirname(bundle), '.preparing-'));
    for (const name of scriptNames) copyFileSync(join(source, name), join(staging, name));
    const runtime = join(staging, 'runtime');
    mkdirSync(runtime, { mode: 0o700 });
    for (const artifact of WORKSTATION_ARTIFACTS.slice(1))
      execFileSync(
        'tar',
        [
          '--extract',
          '--gzip',
          '--no-same-owner',
          '--file',
          join(root, artifact.name),
          '--directory',
          runtime,
        ],
        { timeout: 60_000, stdio: 'ignore' },
      );
    const files = {};
    for (const name of walkFiles(staging))
      files[name] = lstatSync(join(staging, name)).isSymbolicLink()
        ? { target: readlinkSync(join(staging, name)) }
        : { sha256: await hash(join(staging, name)) };
    atomic(join(staging, 'files.json'), files);
    renameSync(staging, bundle);
  }
  await verifyBundle(bundle);
  const key = join(state, 'api-key');
  if (!existsSync(key))
    writeFileSync(key, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  privateFile(key);
  atomic(join(state, 'installation.json'), {
    bundle,
    node: process.execPath,
    identity: WORKSTATION_IDENTITY,
  });
  const bin = join(homedir(), '.local/bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, 'maxim-llm');
  if (
    existsSync(launcher) &&
    !readFileSync(launcher, 'utf8').includes('# MAXIM commercial workstation launcher')
  )
    throw new Error('foreign_launcher_refused');
  atomic(
    launcher,
    `#!/bin/sh\n# MAXIM commercial workstation launcher\nexec ${shellQuote(process.execPath)} ${shellQuote(join(bundle, scriptNames[0]))} "$@"\n`,
  );
  chmodSync(launcher, 0o700);
  console.log(
    JSON.stringify({ installed: true, launcher, bundle, model: WORKSTATION_IDENTITY.modelAlias }),
  );
}
function installation() {
  privateFile(join(state, 'installation.json'));
  return JSON.parse(readFileSync(join(state, 'installation.json'), 'utf8'));
}
// FLAG: Parent-death containment prevents an orphan GPU process after an unexpected supervisor exit.
const childGuard = `import ctypes,os,signal,sys
parent=os.getppid()
if ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)!=0: sys.exit(70)
if os.getppid()!=parent or parent==1: sys.exit(71)
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)`;
function guarded(file, args, options) {
  return spawn('/usr/bin/python3', ['-c', childGuard, file, ...args], options);
}
async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let done = false;
  const closed = new Promise((resolveClosed) =>
    child.once('close', () => {
      done = true;
      resolveClosed();
    }),
  );
  child.kill('SIGTERM');
  await Promise.race([closed, pause(3000)]);
  if (!done) {
    child.kill('SIGKILL');
    await Promise.race([closed, pause(2000)]);
  }
  if (!done) throw new Error('child_teardown_failed');
}
async function run() {
  const { bundle } = installation();
  if (resolve(process.argv[1]) !== join(bundle, scriptNames[0]))
    throw new Error('installed_source_required');
  const enabled = join(state, 'enabled');
  if (!existsSync(enabled)) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const startTicks = processStart(process.pid);
  let phase = 'verifying',
    lastSuccessAt = null,
    classifications = 0,
    model,
    ssh;
  const status = (value = phase) => {
    phase = value;
    if (value === 'classified') {
      lastSuccessAt = new Date().toISOString();
      classifications++;
      phase = 'connected';
    }
    atomic(join(state, 'status.json'), {
      pid: process.pid,
      startTicks,
      bundle,
      phase,
      heartbeatAt: new Date().toISOString(),
      lastSuccessAt,
      classifications,
      modelPid: model?.pid ?? null,
      model: WORKSTATION_IDENTITY.modelAlias,
      mode: 'SHADOW',
    });
  };
  status();
  const heartbeat = setInterval(() => {
    if (!existsSync(enabled)) stop();
    status();
  }, 2000);
  try {
    await artifactChecks();
    await verifyBundle(bundle);
    const keyPath = join(state, 'api-key');
    privateFile(keyPath);
    const key = readFileSync(keyPath, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('api_key_refused');
    const runtime = join(bundle, 'runtime'),
      binary = join(runtime, 'llama-b11804/llama-server');
    const modelEnv = {
      PATH: '/usr/bin:/bin',
      HOME: root,
      LANG: 'C.UTF-8',
      LD_LIBRARY_PATH: [
        join(runtime, 'llama-b11804'),
        join(runtime, 'cudart-llama-b11804-bin-ubuntu-cuda-12.8-x64'),
        '/usr/lib/wsl/lib',
      ].join(':'),
      CUDA_CACHE_PATH: join(root, 'cuda-cache'),
    };
    let retryMs = 2000;
    while (!controller.signal.aborted) {
      try {
        if (!model) {
          status('loading');
          model = guarded(binary, workstationModelArgs(root, keyPath), {
            env: modelEnv,
            stdio: 'ignore',
          });
          let spawnFailed = false;
          model.once('error', () => {
            spawnFailed = true;
          });
          const deadline = Date.now() + 90_000;
          let ready = false;
          while (!ready && Date.now() < deadline && !controller.signal.aborted) {
            if (spawnFailed || model.exitCode !== null || model.signalCode !== null)
              throw new Error('model_exit');
            try {
              await attestWorkstationModel(
                key,
                AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
              );
              ready = true;
            } catch {
              await pause(500, undefined, { signal: controller.signal });
            }
          }
          if (!ready) throw new Error('model_start_deadline');
        }
        status('connecting');
        ssh = guarded('/usr/bin/ssh', WORKSTATION_SSH_ARGS, {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8' },
        });
        const modelExit = () => ssh?.kill('SIGTERM');
        model.once('exit', modelExit);
        try {
          await workstationSession(ssh, key, {
            signal: controller.signal,
            onStatus: (value) => {
              status(value);
              if (value === 'connected') retryMs = 2000;
            },
          });
        } finally {
          model.removeListener('exit', modelExit);
        }
        if (model.exitCode !== null || model.signalCode !== null) throw new Error('model_exit');
      } catch {
        status('recovering');
        await stopChild(model);
        model = undefined;
      } finally {
        await stopChild(ssh);
        ssh = undefined;
      }
      if (!controller.signal.aborted) {
        status('reconnecting');
        await pause(retryMs, undefined, { signal: controller.signal }).catch(() => undefined);
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  } finally {
    controller.abort();
    clearInterval(heartbeat);
    await stopChild(ssh);
    await stopChild(model);
    model = undefined;
    status('stopped');
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
async function cli() {
  const [operation = 'status', ...extra] = process.argv.slice(2);
  if (extra.length || !['install', 'start', 'resume', 'run', 'stop', 'status'].includes(operation))
    throw new Error('usage_install_start_stop_status');
  if (operation === 'install') return install();
  if (operation === 'run') return run();
  if (operation === 'status') {
    const current = running();
    console.log(
      JSON.stringify(
        current
          ? {
              running: true,
              ...current,
              heartbeatFresh: Date.now() - Date.parse(current.heartbeatAt) < 6000,
            }
          : { running: false },
      ),
    );
    return;
  }
  if (operation === 'stop') {
    if (existsSync(join(state, 'enabled'))) unlinkSync(join(state, 'enabled'));
    const current = running();
    if (current) process.kill(current.pid, 'SIGTERM');
    const deadline = Date.now() + 12_000;
    while (running() && Date.now() < deadline) await pause(100);
    if (running()) throw new Error('supervisor_stop_deadline');
    console.log(JSON.stringify({ stopped: true }));
    return;
  }
  const installed = installation();
  if (operation === 'resume' && !existsSync(join(state, 'enabled'))) return;
  atomic(join(state, 'enabled'), '1\n');
  if (!running()) {
    const child = spawn(
      '/usr/bin/flock',
      [
        '--nonblock',
        '--close',
        join(state, 'supervisor.lock'),
        installed.node,
        join(installed.bundle, scriptNames[0]),
        'run',
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8' },
      },
    );
    child.unref();
    await pause(1000);
  }
  console.log(JSON.stringify({ started: Boolean(running()) }));
  if (!running()) throw new Error('supervisor_start_failed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  cli().catch(() => {
    process.stderr.write('workstation_operation_failed\n');
    process.exitCode = 1;
  });
