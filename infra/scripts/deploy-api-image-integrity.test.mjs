import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const topologyPath = resolve(root, 'infra/scripts/lib/deploy-topology.sh');
const fullSha = 'a'.repeat(40);

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function runTopologyProbe(probe, env = {}, cwd = root) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$TOPOLOGY_PATH"\n${probe}`], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, TOPOLOGY_PATH: topologyPath },
  });
}

function runImmutableImageBuild({ imageExists, labels = `${fullSha}|true`, revision = fullSha }) {
  return runTopologyProbe(
    `
docker() {
  printf '%s\\n' "$*" >&2
  if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    [[ "$IMAGE_EXISTS" == "1" ]] || return 1
    printf '%s\\n' "$IMAGE_LABELS"
    return 0
  fi
  if [[ "$1" == "buildx" && "$2" == "build" ]]; then
    return 0
  fi
  return 97
}
maxim_topology_refuse_dirty_api_build_inputs() { :; }
maxim_topology_build_shared_api_image "maxim-api:$EXPECTED_REVISION" "$EXPECTED_REVISION"
`,
    {
      EXPECTED_REVISION: revision,
      IMAGE_EXISTS: imageExists ? '1' : '0',
      IMAGE_LABELS: labels,
    },
  );
}

test('reuses only an immutable API image with the exact protected revision labels', () => {
  const result = runImmutableImageBuild({ imageExists: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing existing immutable API image/u);
  assert.doesNotMatch(result.stderr, /buildx build/u);
});

test('refuses immutable API images with missing or mismatched release labels', () => {
  for (const labels of [`${'b'.repeat(40)}|true`, `${fullSha}|`, `${fullSha}|false`]) {
    const result = runImmutableImageBuild({ imageExists: true, labels });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unverified release labels/u);
    assert.doesNotMatch(result.stderr, /buildx build/u);
  }
});

test('labels a newly built immutable API image with its exact protected revision', () => {
  const result = runImmutableImageBuild({ imageExists: false });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`--label org\\.opencontainers\\.image\\.revision=${fullSha}`, 'u'));
  assert.match(result.stderr, /--label com\.maxim\.release-protected=true/u);
});

test('requires a full lowercase SHA only for immutable API image refs', () => {
  const immutable = runImmutableImageBuild({ imageExists: false, revision: 'abc123' });
  const compatibility = runTopologyProbe(`
docker() { printf '%s\\n' "$*"; }
maxim_topology_refuse_dirty_api_build_inputs() { :; }
maxim_topology_build_shared_api_image infra-scale
`);

  assert.equal(immutable.status, 1);
  assert.match(immutable.stderr, /expected full lowercase Git SHA/u);
  assert.doesNotMatch(immutable.stderr, /image inspect|buildx build/u);
  assert.equal(compatibility.status, 0, compatibility.stderr);
  assert.match(compatibility.stdout, /infra-scale-api-ingress:latest/u);
});

function withGitFixture(callback) {
  const fixture = mkdtempSync(join(tmpdir(), 'maxim-api-build-inputs-'));
  try {
    const init = spawnSync('git', ['init', '--quiet'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    mkdirSync(join(fixture, 'apps/api/src'), { recursive: true });
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    callback(fixture);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

test('rejects nonignored untracked API Docker build inputs', () => {
  withGitFixture((fixture) => {
    writeFileSync(join(fixture, 'apps/api/src/injected.ts'), 'export {};\n');
    const result = runTopologyProbe('maxim_topology_refuse_dirty_api_build_inputs\n', {}, fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing shared API image build/u);
    assert.match(result.stderr, /apps\/api\/src\/injected\.ts/u);
  });
});

test('rejects Git-ignored inputs that Docker would still include', () => {
  withGitFixture((fixture) => {
    writeFileSync(join(fixture, '.gitignore'), 'build/\n');
    mkdirSync(join(fixture, 'apps/api/src/build'), { recursive: true });
    writeFileSync(join(fixture, 'apps/api/src/build/injected.ts'), 'export {};\n');
    const result = runTopologyProbe('maxim_topology_refuse_dirty_api_build_inputs\n', {}, fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Git-ignored inputs included by Docker/u);
    assert.match(result.stderr, /apps\/api\/src\/build\/injected\.ts/u);
  });
});

test('rejects modified or staged tracked API Docker build inputs', () => {
  withGitFixture((fixture) => {
    const trackedPath = join(fixture, 'apps/api/src/tracked.ts');
    writeFileSync(trackedPath, 'export const value = 1;\n');
    let result = spawnSync('git', ['add', 'apps/api/src/tracked.ts'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(
      'git',
      ['-c', 'user.name=MAXIM Test', '-c', 'user.email=maxim-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'],
      { cwd: fixture, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);

    writeFileSync(trackedPath, 'export const value = 2;\n');
    const modified = runTopologyProbe('maxim_topology_refuse_dirty_api_build_inputs\n', {}, fixture);
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, / M apps\/api\/src\/tracked\.ts/u);

    result = spawnSync('git', ['add', 'apps/api/src/tracked.ts'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const staged = runTopologyProbe('maxim_topology_refuse_dirty_api_build_inputs\n', {}, fixture);
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /M {2}apps\/api\/src\/tracked\.ts/u);
  });
});

test('allows ignored env files and unrelated untracked files outside API build inputs', () => {
  withGitFixture((fixture) => {
    writeFileSync(join(fixture, '.gitignore'), '.env\n.env.*\ndist/\n*.codex-backup-*\n');
    writeFileSync(join(fixture, 'apps/api/.env.local'), 'IGNORED=true\n');
    mkdirSync(join(fixture, 'apps/api/dist'), { recursive: true });
    writeFileSync(join(fixture, 'apps/api/dist/index.js'), 'ignored Docker output\n');
    writeFileSync(join(fixture, 'apps/api/src/local.codex-backup-1'), 'ignored backup\n');
    writeFileSync(join(fixture, 'docs/operator-note.md'), 'not a Docker build input\n');
    const result = runTopologyProbe('maxim_topology_refuse_dirty_api_build_inputs\n', {}, fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('every local API build gates inputs and production builds pass the target SHA', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const scale = read('infra/scripts/vps-pull-build-up-scale.sh');
  const rollback = read('infra/scripts/vps-runtime-rollback.sh');
  const topology = read('infra/scripts/lib/deploy-topology.sh');

  assert.match(topology, /maxim_topology_refuse_dirty_api_build_inputs\n {4}echo "Building compatibility/u);
  assert.match(topology, /echo "Building one shared API image[^\n]+\n {2}maxim_topology_refuse_dirty_api_build_inputs\n {2}docker buildx build/u);
  const deployPreflight = deploy.lastIndexOf('maxim_topology_refuse_dirty_api_build_inputs');
  assert.ok(deployPreflight < deploy.lastIndexOf('prepare_deploy_disk_capacity'));
  assert.ok(deployPreflight < deploy.lastIndexOf('stop_conflicting_stacks'));
  const scalePreflight = scale.indexOf('maxim_topology_refuse_dirty_api_build_inputs');
  assert.ok(scalePreflight < scale.lastIndexOf('prepare_scale_redis_named_volume'));
  assert.ok(scalePreflight < scale.lastIndexOf('stop_conflicting_stacks'));
  const rollbackPreflight = rollback.lastIndexOf('maxim_topology_refuse_dirty_api_build_inputs');
  const rollbackSwitch = rollback.lastIndexOf('git switch --detach');
  const rollbackBuild = rollback.lastIndexOf('maxim_topology_build_shared_api_image');
  assert.match(
    rollback,
    /git switch --detach "\$TARGET_FULL_SHA"\nmaxim_topology_refuse_dirty_api_build_inputs/u,
  );
  assert.ok(rollback.lastIndexOf('maxim_check_deploy_disk_capacity') < rollbackSwitch);
  assert.ok(rollbackSwitch < rollbackPreflight);
  assert.ok(rollbackPreflight < rollbackBuild);
  assert.ok(rollbackPreflight < rollback.lastIndexOf('ROLLBACK_RUNTIME_STARTED=1'));
  assert.ok(rollbackPreflight < rollback.lastIndexOf('prisma migrate deploy'));
  assert.match(
    deploy,
    /maxim_topology_build_shared_api_image "\$MAXIM_API_IMAGE" "\$TARGET_SHA"/u,
  );
  assert.match(
    rollback,
    /maxim_topology_build_shared_api_image "\$ROLLBACK_API_IMAGE" "\$TARGET_FULL_SHA"/u,
  );
});
