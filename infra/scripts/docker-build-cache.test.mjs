import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function readRemotePreloadScript() {
  const connect = read('infra/scripts/vps-connect.sh');
  const startMarker = "  remote_load_script=$(cat <<'REMOTE'\n";
  const endMarker = '\nREMOTE\n  )';
  const start = connect.indexOf(startMarker);
  const end = connect.indexOf(endMarker, start);

  assert.notEqual(start, -1, 'missing remote preload script start');
  assert.notEqual(end, -1, 'missing remote preload script end');
  return connect
    .slice(start + startMarker.length, end)
    .replace(/^source infra\/scripts\/lib\/deploy-lock\.sh\n/mu, '');
}

function dockerImageId(digit) {
  return `sha256:${digit.repeat(64)}`;
}

function runRemotePreload({
  availableBytes = 500,
  archiveBytes = 100,
  reserveBytes = 400,
  previousImageId = '',
  loadedImageId = dockerImageId('b'),
  loadedLabels,
  imageRef,
  expectedSha = 'a'.repeat(40),
} = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'maxim-preload-test-'));
  const bin = join(temp, 'bin');
  const dockerPath = join(bin, 'docker');
  const dfPath = join(bin, 'df');
  const logPath = join(temp, 'docker.log');
  const statePath = join(temp, 'target-image-id');
  const targetRef = imageRef ?? `maxim-api:${expectedSha}`;
  const labels = loadedLabels ?? `${expectedSha}|true`;

  try {
    mkdirSync(bin);
    writeFileSync(statePath, previousImageId);
    writeFileSync(
      dockerPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1:$2" in
  image:load)
    printf '%s' "$MOCK_LOADED_IMAGE_ID" > "$MOCK_DOCKER_STATE"
    ;;
  image:inspect)
    current_id="$(cat "$MOCK_DOCKER_STATE")"
    [[ -n "$current_id" ]] || exit 1
    if [[ "\${3:-}" == "--format" ]]; then
      if [[ "$4" == "{{.Id}}" ]]; then
        printf '%s\\n' "$current_id"
      elif [[ "$current_id" == "$MOCK_LOADED_IMAGE_ID" ]]; then
        printf '%s\\n' "$MOCK_LOADED_LABELS"
      else
        printf '%s\\n' "$MOCK_PREVIOUS_LABELS"
      fi
    fi
    ;;
  image:rm)
    : > "$MOCK_DOCKER_STATE"
    ;;
  image:tag)
    printf '%s' "$3" > "$MOCK_DOCKER_STATE"
    ;;
  *)
    exit 2
    ;;
esac
`,
    );
    writeFileSync(
      dfPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n'
printf '/dev/fake 107374182400 1 %s 79%% /\\n' "$MOCK_AVAILABLE_BYTES"
`,
    );
    chmodSync(dockerPath, 0o755);
    chmodSync(dfPath, 0o755);

    const probe = `set -euo pipefail
acquire_deploy_lock() {
  printf 'lock acquire\\n' >> "$MOCK_DOCKER_LOG"
  trap release_deploy_lock EXIT
}
release_deploy_lock() {
  printf 'lock release\\n' >> "$MOCK_DOCKER_LOG"
}
${readRemotePreloadScript()}
`;
    const result = spawnSync('bash', ['-c', probe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MAXIM_PRELOAD_ARCHIVE_BYTES: String(archiveBytes),
        MAXIM_PRELOAD_EXPECTED_SHA: expectedSha,
        MAXIM_PRELOAD_IMAGE_REF: targetRef,
        MAXIM_PRELOAD_MIN_REMAINING_FREE_BYTES: String(reserveBytes),
        MOCK_AVAILABLE_BYTES: String(availableBytes),
        MOCK_DOCKER_LOG: logPath,
        MOCK_DOCKER_STATE: statePath,
        MOCK_LOADED_IMAGE_ID: loadedImageId,
        MOCK_LOADED_LABELS: labels,
        MOCK_PREVIOUS_LABELS: `${expectedSha}|true`,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    return {
      ...result,
      dockerLog: readFileSync(logPath, 'utf8'),
      targetImageId: readFileSync(statePath, 'utf8'),
      targetRef,
    };
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

test('keeps npm downloads out of immutable Docker dependency layers', () => {
  for (const path of ['apps/api/Dockerfile', 'apps/miniapp/Dockerfile', 'apps/admin/Dockerfile']) {
    const dockerfile = read(path);
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7$/mu);
    assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm,sharing=locked/u);
  }
});

test('builds API production dependencies before copying runtime source', () => {
  const dockerfile = read('apps/api/Dockerfile');
  const prodDependencies = dockerfile.indexOf('FROM manifests AS prod-deps');
  const buildStage = dockerfile.indexOf('FROM manifests AS build');
  const apiSource = dockerfile.indexOf('COPY apps/api apps/api');

  assert.notEqual(prodDependencies, -1);
  assert.notEqual(buildStage, -1);
  assert.notEqual(apiSource, -1);
  assert.ok(prodDependencies < buildStage);
  assert.ok(prodDependencies < apiSource);
  const prodStage = dockerfile.slice(prodDependencies, buildStage);
  const prepareRemoval = prodStage.indexOf('npm pkg delete scripts.prepare');
  const prodInstall = prodStage.indexOf('npm ci --omit=dev');

  assert.notEqual(prepareRemoval, -1);
  assert.notEqual(prodInstall, -1);
  assert.ok(prepareRemoval < prodInstall);
  assert.match(
    prodStage,
    /npm ci --omit=dev --workspace @maxim\/api --workspace @maxim\/contracts/u,
  );
  assert.doesNotMatch(prodStage, /--ignore-scripts/u);
  assert.doesNotMatch(dockerfile, /npm prune/u);
});

test('packages exact-SHA main images for reuse-only production deploys', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /org\.opencontainers\.image\.revision="\$\{\{ github\.sha \}\}"/u);
  assert.match(workflow, /docker image save "\$IMAGE_REF" \| gzip -1/u);
  assert.match(workflow, /sha256sum maxim-image\.tar\.gz/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /github\.event_name == 'push'/u);
});

test('runs the compiled native OCR raster smoke before packaging the API image', () => {
  const workflow = read('.github/workflows/ci.yml');
  const smoke = workflow.indexOf('Smoke native OCR in API image');
  const packaging = workflow.indexOf('Package immutable production image');

  assert.notEqual(smoke, -1);
  assert.notEqual(packaging, -1);
  assert.ok(smoke < packaging);
  const smokeStep = workflow.slice(smoke, packaging);
  assert.match(smokeStep, /if: matrix\.component == 'api'/u);
  assert.match(smokeStep, /docker run --rm --init --read-only/u);
  assert.match(smokeStep, /--cap-drop=ALL/u);
  assert.match(smokeStep, /--memory=1g/u);
  assert.match(smokeStep, /--cpus=0\.75/u);
  assert.match(smokeStep, /--tmpfs \/tmp:rw,nosuid,size=64m,uid=1000,gid=1000/u);
  assert.match(smokeStep, /--env APP_SERVICE_NAME=api-media-analysis/u);
  assert.match(smokeStep, /--env APP_ROLE=moderation/u);
  assert.match(smokeStep, /--env COMMERCIAL_OCR_TESSERACT_CONCURRENCY=1/u);
  assert.match(smokeStep, /--env COMMERCIAL_OCR_TESSERACT_MAX_QUEUE=4/u);
  assert.match(smokeStep, /--env COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS=10000/u);
  assert.match(smokeStep, /--env OMP_THREAD_LIMIT=1/u);
  assert.match(
    smokeStep,
    /apps\/api\/dist\/apps\/api\/src\/scripts\/smoke-commercial-ocr-worker\.js/u,
  );
});

test('preloads only checksummed exact-SHA MAXIM images from green CI', () => {
  const connect = read('infra/scripts/vps-connect.sh');

  assert.match(connect, /node scripts\/ci\/assert-green\.mjs "\$exact_sha"/u);
  assert.match(connect, /CI\|\$\{exact_sha\}\|main\|success\|push/u);
  assert.match(connect, /sha256sum --check/u);
  assert.match(connect, /gzip -dc "\$archive_path" \| wc -c/u);
  assert.match(connect, /source infra\/scripts\/lib\/deploy-lock\.sh/u);
  assert.match(connect, /acquire_deploy_lock/u);
  assert.match(connect, /MAXIM_PRELOAD_MIN_REMAINING_FREE_BYTES/u);
  assert.match(connect, /available_bytes < required_bytes/u);
  assert.match(connect, /docker image load/u);
  assert.ok(connect.indexOf('docker image load') < connect.indexOf('Loaded image metadata'));
  assert.match(connect, /org\.opencontainers\.image\.revision/u);
  assert.match(connect, /com\.maxim\.release-protected/u);
  assert.match(connect, /Removing newly loaded invalid MAXIM tag/u);
  assert.doesNotMatch(connect, /docker (?:system|image|builder|buildx) prune/u);
});

test('preload holds the deploy lock and preserves its disk reserve before loading', () => {
  const refused = runRemotePreload({ availableBytes: 499 });
  const accepted = runRemotePreload();

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /500B required/u);
  assert.equal(refused.dockerLog, 'lock acquire\nlock release\n');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.ok(accepted.dockerLog.indexOf('lock acquire') < accepted.dockerLog.indexOf('image load'));
  assert.match(accepted.dockerLog, /image inspect --format \{\{\.Id\}\}/u);
  assert.doesNotMatch(accepted.dockerLog, /image rm/u);
  assert.match(accepted.dockerLog, /lock release/u);
});

test('preload removes only a newly loaded tag when release labels are invalid', () => {
  const loadedImageId = dockerImageId('c');
  const result = runRemotePreload({
    loadedImageId,
    loadedLabels: 'wrong-revision|false',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /metadata does not match/u);
  assert.match(result.stderr, /Removing newly loaded invalid MAXIM tag/u);
  assert.match(result.dockerLog, new RegExp(`image rm ${result.targetRef}`, 'u'));
  assert.doesNotMatch(result.dockerLog, /image tag/u);
  assert.equal(result.targetImageId, '');
});

test('preload restores a previous tag after rejecting a different newly loaded image', () => {
  const previousImageId = dockerImageId('d');
  const result = runRemotePreload({
    previousImageId,
    loadedImageId: dockerImageId('e'),
    loadedLabels: 'wrong-revision|false',
  });

  assert.equal(result.status, 1);
  assert.match(result.dockerLog, new RegExp(`image rm ${result.targetRef}`, 'u'));
  assert.match(
    result.dockerLog,
    new RegExp(`image tag ${previousImageId} ${result.targetRef}`, 'u'),
  );
  assert.equal(result.targetImageId, previousImageId);
});

test('preload never removes an invalid tag that already pointed to the loaded image', () => {
  const existingImageId = dockerImageId('f');
  const result = runRemotePreload({
    previousImageId: existingImageId,
    loadedImageId: existingImageId,
    loadedLabels: 'wrong-revision|false',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a newly loaded invalid tag/u);
  assert.doesNotMatch(result.dockerLog, /image rm|image tag/u);
  assert.equal(result.targetImageId, existingImageId);
});
