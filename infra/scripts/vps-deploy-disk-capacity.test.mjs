import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const deployScript = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
const minimumFreeBytes = 20 * 1024 ** 3;

function readShellFunction(name, nextName) {
  const start = deployScript.indexOf(`${name}() {\n`);
  const end = deployScript.indexOf(`\n${nextName}() {`, start);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  assert.notEqual(end, -1, `Missing shell function after ${name}: ${nextName}`);
  return deployScript.slice(start, end);
}

function runDiskPreflight(
  availableBytes,
  { minimumOverride, usedPercent = 79, emergencyOverride, targetPercent, criticalPercent } = {},
) {
  const env = { ...process.env };
  for (const name of [
    'MAXIM_ALLOW_CRITICAL_DISK_DEPLOY',
    'MAXIM_DEPLOY_DISK_CRITICAL_PERCENT',
    'MAXIM_DEPLOY_DISK_MAX_PERCENT',
    'MAXIM_DEPLOY_DISK_MIN_FREE_BYTES',
    'MAXIM_DEPLOY_DISK_TARGET_PERCENT',
    'MAXIM_DEPLOY_DISK_WARN_PERCENT',
  ]) {
    delete env[name];
  }
  if (minimumOverride !== undefined) {
    env.MAXIM_DEPLOY_DISK_MIN_FREE_BYTES = String(minimumOverride);
  }
  if (emergencyOverride !== undefined) {
    env.MAXIM_ALLOW_CRITICAL_DISK_DEPLOY = String(emergencyOverride);
  }
  if (targetPercent !== undefined) {
    env.MAXIM_DEPLOY_DISK_TARGET_PERCENT = String(targetPercent);
  }
  if (criticalPercent !== undefined) {
    env.MAXIM_DEPLOY_DISK_CRITICAL_PERCENT = String(criticalPercent);
  }

  const probe = `set -euo pipefail
is_enabled() {
  case "\${1:-0}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}
${readShellFunction('validate_nonnegative_int', 'ensure_requested_services_running')}
${readShellFunction('check_deploy_disk_capacity', 'validate_deploy_branch')}
df() {
  [[ "$1" == "-P" && "$2" == "-B1" ]]
  printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/fake 107374182400 1 %s %s%% /\\n' "$AVAILABLE_BYTES" "$USED_PERCENT"
}
check_deploy_disk_capacity
`;

  return spawnSync('bash', ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...env,
      AVAILABLE_BYTES: String(availableBytes),
      USED_PERCENT: String(usedPercent),
    },
  });
}

function runSelectedImageCapacityPreflight({
  availableBytes,
  expectedSha,
  targetSha = expectedSha,
  services = ['api-ingress'],
  localImages = [],
  apiImage = `maxim-api:${targetSha}`,
  miniappImage = `maxim-miniapp-major:${targetSha}`,
  adminImage = `maxim-admin:${targetSha}`,
  legacyImage = `maxim-miniapp-legacy:${targetSha}`,
  buildApi = services.some((service) => service.startsWith('api-')) ? 1 : 0,
}) {
  const probe = `set -euo pipefail
is_enabled() {
  case "\${1:-0}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}
${readShellFunction('contains_service', 'validate_requested_services')}
${readShellFunction('validate_nonnegative_int', 'ensure_requested_services_running')}
${readShellFunction('is_exact_deploy_target_image_ref', 'selected_target_images_are_preloaded')}
${readShellFunction('selected_target_images_are_preloaded', 'prepare_deploy_disk_capacity')}
${readShellFunction('prepare_deploy_disk_capacity', 'require_preloaded_target_image')}
${readShellFunction('check_deploy_disk_capacity', 'validate_deploy_branch')}
mapfile -t SERVICES <<< "$SELECTED_SERVICES"
API_SERVICES=("api-ingress")
EXPECTED_DEPLOY_SHA="$EXPECTED_SHA"
TARGET_SHA="$TARGET_SHA_VALUE"
BUILD_API_IMAGE="$BUILD_API"
MAXIM_API_IMAGE="$API_IMAGE"
MAXIM_MINIAPP_MAJOR_IMAGE="$MINIAPP_IMAGE"
MAXIM_ADMIN_IMAGE="$ADMIN_IMAGE"
MAXIM_MINIAPP_LEGACY_IMAGE="$LEGACY_IMAGE"
docker() {
  [[ "$1" == "image" && "$2" == "inspect" ]]
  grep -Fxq -- "$3" <<< "$LOCAL_IMAGES"
}
df() {
  [[ "$1" == "-P" && "$2" == "-B1" ]]
  printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/fake 107374182400 1 %s 79%% /\\n' "$AVAILABLE_BYTES"
}
prepare_deploy_disk_capacity
printf 'reuse-only=%s\\n' "$REUSE_PRELOADED_TARGET_IMAGES_ONLY"
`;

  return spawnSync('bash', ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADMIN_IMAGE: adminImage,
      API_IMAGE: apiImage,
      AVAILABLE_BYTES: String(availableBytes),
      BUILD_API: String(buildApi),
      EXPECTED_SHA: expectedSha,
      LEGACY_IMAGE: legacyImage,
      LOCAL_IMAGES: localImages.join('\n'),
      MINIAPP_IMAGE: miniappImage,
      SELECTED_SERVICES: services.join('\n'),
      TARGET_SHA_VALUE: targetSha,
    },
  });
}

test('rejects free space one byte below the 20 GiB default', () => {
  const result = runDiskPreflight(minimumFreeBytes - 1);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 21474836480 bytes are required/u);
  assert.match(result.stderr, /not bypassed by MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
});

test('accepts free space exactly at and above the 20 GiB default', () => {
  for (const availableBytes of [minimumFreeBytes, minimumFreeBytes + 1]) {
    const result = runDiskPreflight(availableBytes);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /minimum-free=21474836480B/u);
  }
});

test('rejects malformed absolute free-space configuration', () => {
  for (const invalidValue of ['-1', '20GiB', '1.5']) {
    const result = runDiskPreflight(minimumFreeBytes, { minimumOverride: invalidValue });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /MAXIM_DEPLOY_DISK_MIN_FREE_BYTES must be a non-negative integer\./u,
    );
  }
});

test('compares configured byte thresholds exactly without shell integer overflow', () => {
  const leadingZeroResult = runDiskPreflight('00021474836480', {
    minimumOverride: '00021474836480',
  });
  const hugeThresholdResult = runDiskPreflight('999999999999999999999999999998', {
    minimumOverride: '999999999999999999999999999999',
  });

  assert.equal(leadingZeroResult.status, 0, leadingZeroResult.stderr);
  assert.match(leadingZeroResult.stdout, /available=21474836480B minimum-free=21474836480B/u);
  assert.equal(hugeThresholdResult.status, 1);
  assert.match(hugeThresholdResult.stderr, /at least 999999999999999999999999999999 bytes/u);
});

test('rejects configuration that weakens the hard 20 GiB floor', () => {
  for (const invalidValue of [0, minimumFreeBytes - 1]) {
    const result = runDiskPreflight(minimumFreeBytes, { minimumOverride: invalidValue });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /MAXIM_DEPLOY_DISK_MIN_FREE_BYTES must be at least 21474836480\./u);
  }
});

test('allows configuration to raise the absolute free-space floor', () => {
  const strongerMinimum = minimumFreeBytes + 1024;
  const belowResult = runDiskPreflight(strongerMinimum - 1, {
    minimumOverride: strongerMinimum,
  });
  const equalResult = runDiskPreflight(strongerMinimum, {
    minimumOverride: strongerMinimum,
  });

  assert.equal(belowResult.status, 1);
  assert.match(belowResult.stderr, /at least 21474837504 bytes are required/u);
  assert.equal(equalResult.status, 0, equalResult.stderr);
  assert.match(equalResult.stdout, /minimum-free=21474837504B/u);
});

test('keeps the percentage gate when absolute free space is sufficient', () => {
  const result = runDiskPreflight(minimumFreeBytes + 1, { usedPercent: 80 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /above the deploy target disk utilization \(80%\)/u);
});

test('emergency override bypasses only percentage thresholds', () => {
  const percentOverride = runDiskPreflight(minimumFreeBytes + 1, {
    usedPercent: 95,
    emergencyOverride: 1,
  });
  const absoluteShortfall = runDiskPreflight(minimumFreeBytes - 1, {
    usedPercent: 95,
    emergencyOverride: 1,
  });

  assert.equal(percentOverride.status, 0, percentOverride.stderr);
  assert.match(percentOverride.stderr, /CRITICAL: deploy host disk utilization is 95%/u);
  assert.equal(absoluteShortfall.status, 1);
  assert.match(absoluteShortfall.stderr, /not bypassed by MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
});

test('normalizes percentage thresholds before comparing them', () => {
  const result = runDiskPreflight(minimumFreeBytes, {
    usedPercent: '080',
    targetPercent: '080',
    criticalPercent: '090',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /above the deploy target disk utilization \(80%\)/u);
});

test('skips the build capacity floor only when every selected exact-SHA image is local', () => {
  const targetSha = 'a'.repeat(40);
  const localImages = [
    `maxim-api:${targetSha}`,
    `maxim-miniapp-major:${targetSha}`,
    `maxim-admin:${targetSha}`,
  ];
  const result = runSelectedImageCapacityPreflight({
    availableBytes: 7 * 1024 ** 3,
    expectedSha: targetSha,
    services: ['api-ingress', 'miniapp-major-static', 'admin-static'],
    localImages,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every selected exact immutable target image is already local/u);
  assert.match(result.stdout, /reuse-only=1/u);
  assert.doesNotMatch(result.stdout, /Deploy disk preflight:/u);
});

test('a missing selected exact-SHA image cannot bypass the hard capacity floor', () => {
  const targetSha = 'b'.repeat(40);
  const result = runSelectedImageCapacityPreflight({
    availableBytes: 7 * 1024 ** 3,
    expectedSha: targetSha,
    services: ['api-ingress', 'miniapp-major-static'],
    localImages: [`maxim-api:${targetSha}`],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a build: maxim-miniapp-major:/u);
  assert.match(result.stderr, /at least 21474836480 bytes are required/u);
});

test('a local image tagged for the wrong SHA cannot bypass the hard capacity floor', () => {
  const targetSha = 'c'.repeat(40);
  const wrongSha = 'd'.repeat(40);
  const wrongImage = `maxim-api:${wrongSha}`;
  const result = runSelectedImageCapacityPreflight({
    availableBytes: 7 * 1024 ** 3,
    expectedSha: targetSha,
    services: ['api-ingress'],
    localImages: [wrongImage],
    apiImage: wrongImage,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-target image ref/u);
  assert.match(result.stderr, /at least 21474836480 bytes are required/u);
});

test('unknown deploy targets cannot bypass the hard capacity floor', () => {
  const targetSha = 'e'.repeat(40);
  const result = runSelectedImageCapacityPreflight({
    availableBytes: 7 * 1024 ** 3,
    expectedSha: targetSha,
    services: ['manual-unknown-static'],
    localImages: [`maxim-api:${targetSha}`],
    buildApi: 0,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown target: manual-unknown-static/u);
  assert.match(result.stderr, /at least 21474836480 bytes are required/u);
});

test('runtime recreation is explicitly forbidden from triggering an implicit image build', () => {
  const upCommands = deployScript
    .split('\n')
    .filter((line) => line.includes('docker compose') && line.includes(' up -d '));

  assert.ok(upCommands.length > 0, 'expected runtime docker compose up commands');
  for (const command of upCommands) {
    assert.match(command, / --no-build /u);
  }
});
