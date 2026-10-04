'use strict';

const COMMAND = [
  'node',
  'apps/api/dist/apps/api/src/moderation/photo-duplicate/native-photo-sandbox.entrypoint.js',
];
const PROBE = ['CMD', ...COMMAND, '--probe'];
const ENVIRONMENT = Object.freeze({
  NODE_ENV: 'production',
  PHOTO_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-photo/native-photo.sock',
  PHOTO_DUPLICATE_MAX_BYTES: '16777216',
  PHOTO_DUPLICATE_MAX_PIXELS: '40000000',
  VIPS_CONCURRENCY: '1',
});
const TMPFS = '/tmp:size=64m,mode=1777,uid=1000,gid=1000';
const same = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((item, index) => item === right[index]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (left, right) =>
  object(left) &&
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(right).every(([key, value]) => left[key] === value);
const absent = (value) => value === undefined || value === null;
const empty = (value) => absent(value) || (Array.isArray(value) && value.length === 0);

function isReviewedPhotoNativeSandboxConfig(config) {
  try {
    const native = config?.services?.['photo-native-sandbox'];
    const consumer = config?.services?.['api-moderation-background'];
    const volumes = native?.volumes;
    const consumers = Object.entries(config?.services ?? {})
      .filter(([, service]) =>
        service?.volumes?.some((volume) => volume.source === 'photo_native_ipc'),
      )
      .map(([name]) => name)
      .sort();
    const consumerVolumes = consumer?.volumes?.filter(
      (volume) => volume.target === '/run/maxim-photo',
    );
    return Boolean(
      native &&
      consumer &&
      native.labels?.['com.maxim.photo-native-sandbox'] === 'true' &&
      native.network_mode === 'none' &&
      absent(native.networks) &&
      native.user === '1000:1000' &&
      native.init === true &&
      native.read_only === true &&
      native.privileged !== true &&
      native.cpus === 1 &&
      native.mem_limit === '1073741824' &&
      native.pids_limit === 64 &&
      native.deploy?.replicas === 1 &&
      native.restart === 'unless-stopped' &&
      same(native.cap_drop, ['ALL']) &&
      empty(native.cap_add) &&
      same(native.security_opt, ['no-new-privileges:true']) &&
      same(native.tmpfs, [TMPFS]) &&
      same(native.command, COMMAND) &&
      absent(native.entrypoint) &&
      same(native.healthcheck?.test, PROBE) &&
      native.healthcheck?.disable !== true &&
      native.healthcheck?.timeout === '8s' &&
      native.healthcheck?.interval === '10s' &&
      native.healthcheck?.retries === 3 &&
      native.healthcheck?.start_period === '20s' &&
      exact(native.environment, ENVIRONMENT) &&
      empty(native.env_file) &&
      empty(native.secrets) &&
      empty(native.configs) &&
      empty(native.ports) &&
      empty(native.expose) &&
      empty(native.devices) &&
      empty(native.device_cgroup_rules) &&
      absent(native.pid) &&
      absent(native.ipc) &&
      Array.isArray(volumes) &&
      volumes.length === 1 &&
      volumes[0].type === 'volume' &&
      volumes[0].source === 'photo_native_ipc' &&
      volumes[0].target === '/run/maxim-photo' &&
      volumes[0].read_only !== true &&
      same(consumers, ['api-moderation-background', 'photo-native-sandbox']) &&
      consumerVolumes?.length === 1 &&
      consumerVolumes[0].type === 'volume' &&
      consumerVolumes[0].source === 'photo_native_ipc' &&
      consumerVolumes[0].read_only === true &&
      consumer.environment?.PHOTO_NATIVE_SANDBOX_SOCKET_PATH ===
        ENVIRONMENT.PHOTO_NATIVE_SANDBOX_SOCKET_PATH &&
      consumer.depends_on?.['photo-native-sandbox']?.condition === 'service_healthy',
    );
  } catch {
    return false;
  }
}

function validEnvironment(entries) {
  if (!Array.isArray(entries)) return false;
  const values = new Map();
  const optional = new Set([
    'PATH',
    'HOME',
    'LANG',
    'HOSTNAME',
    'NODE_EXTRA_CA_CERTS',
    'NODE_VERSION',
    'YARN_VERSION',
  ]);
  for (const entry of entries) {
    if (typeof entry !== 'string') return false;
    const separator = entry.indexOf('=');
    if (separator < 1) return false;
    const key = entry.slice(0, separator);
    if (values.has(key) || (!Object.hasOwn(ENVIRONMENT, key) && !optional.has(key))) return false;
    values.set(key, entry.slice(separator + 1));
  }
  if (!Object.entries(ENVIRONMENT).every(([key, value]) => values.get(key) === value)) return false;
  for (const [key, expected] of Object.entries({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt',
  })) {
    if (values.has(key) && values.get(key) !== expected) return false;
  }
  if (values.has('NODE_VERSION') && !/^24\.\d+\.\d+$/u.test(values.get('NODE_VERSION')))
    return false;
  if (values.has('YARN_VERSION') && !/^\d+\.\d+\.\d+$/u.test(values.get('YARN_VERSION')))
    return false;
  if (values.has('HOSTNAME') && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/u.test(values.get('HOSTNAME')))
    return false;
  return true;
}

function isReviewedPhotoNativeSandboxRuntime(container, project = 'infra', expectedImageId = null) {
  try {
    if (!['infra', 'infra-scale'].includes(project)) return false;
    const labels = container?.Config?.Labels;
    const host = container?.HostConfig;
    const health = container?.Config?.Healthcheck;
    const mount = container?.Mounts?.[0];
    const tmpfs = host?.Tmpfs;
    const tmpfsOptions = typeof tmpfs?.['/tmp'] === 'string' ? tmpfs['/tmp'].split(',').sort() : [];
    return Boolean(
      container?.State?.Running === true &&
      container.State.Status === 'running' &&
      container.State.Health?.Status === 'healthy' &&
      container.Name === `/${project}-photo-native-sandbox-1` &&
      typeof container.Image === 'string' &&
      /^sha256:[a-f0-9]{64}$/u.test(container.Image) &&
      (!expectedImageId || container.Image === expectedImageId) &&
      labels?.['com.docker.compose.project'] === project &&
      labels['com.docker.compose.service'] === 'photo-native-sandbox' &&
      labels['com.maxim.photo-native-sandbox'] === 'true' &&
      labels['com.maxim.photo-native-sandbox-capable'] === 'true' &&
      (project !== 'infra' || labels['com.maxim.release-protected'] === 'true') &&
      container.Config.User === '1000:1000' &&
      same(container.Config.Cmd, COMMAND) &&
      same(container.Config.Entrypoint, ['docker-entrypoint.sh']) &&
      validEnvironment(container.Config.Env) &&
      same(health?.Test, PROBE) &&
      health.Interval === 10_000_000_000 &&
      health.Timeout === 8_000_000_000 &&
      health.StartPeriod === 20_000_000_000 &&
      health.Retries === 3 &&
      host?.NetworkMode === 'none' &&
      host.ReadonlyRootfs === true &&
      host.Privileged === false &&
      host.Init === true &&
      host.RestartPolicy?.Name === 'unless-stopped' &&
      host.PidsLimit === 64 &&
      host.Memory === 1_073_741_824 &&
      host.NanoCpus === 1_000_000_000 &&
      same(host.CapDrop, ['ALL']) &&
      empty(host.CapAdd) &&
      same(host.SecurityOpt, ['no-new-privileges:true']) &&
      empty(host.Devices) &&
      empty(host.DeviceRequests) &&
      empty(host.DeviceCgroupRules) &&
      !host.PidMode &&
      (!host.IpcMode || host.IpcMode === 'private') &&
      object(tmpfs) &&
      Object.keys(tmpfs).length === 1 &&
      same(tmpfsOptions, ['gid=1000', 'mode=1777', 'size=64m', 'uid=1000']) &&
      Array.isArray(container.Mounts) &&
      container.Mounts.length === 1 &&
      mount.Type === 'volume' &&
      mount.Name === `${project}_photo_native_ipc` &&
      mount.Destination === '/run/maxim-photo' &&
      mount.RW === true &&
      object(container.NetworkSettings?.Networks) &&
      Object.keys(container.NetworkSettings.Networks).every((name) => name === 'none') &&
      (absent(host.PortBindings) ||
        (object(host.PortBindings) && Object.keys(host.PortBindings).length === 0)),
    );
  } catch {
    return false;
  }
}

module.exports = { isReviewedPhotoNativeSandboxConfig, isReviewedPhotoNativeSandboxRuntime };

if (require.main === module) {
  // FLAG: This attestation consumes bounded metadata and emits only an exit status;
  // never print Docker environment, mount sources, image identities or raw JSON errors.
  try {
    const { readSync } = require('node:fs');
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(16_384);
      const size = readSync(0, chunk, 0, chunk.length, null);
      if (!size) break;
      total += size;
      if (total > 4 * 1024 * 1024) throw new Error('Input limit');
      chunks.push(chunk.subarray(0, size));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const args = process.argv.slice(2);
    const valid =
      args.length === 1 && args[0] === 'config'
        ? isReviewedPhotoNativeSandboxConfig(value)
        : args.length === 3 && args[0] === 'runtime'
          ? isReviewedPhotoNativeSandboxRuntime(value, args[1], args[2])
          : false;
    process.exitCode = valid ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
