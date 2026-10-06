import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runtime as photoRuntime, image } from './test-fixtures/photo-native-fixtures.mjs';
import {
  LEGACY_COLD_API_SERVICES,
  parseLegacyColdSelection,
  removeLegacyColdClient,
  readLegacyColdRefusalCode,
  runLegacyColdRecovery,
  validateLegacyColdInventory,
} from './multibot-legacy-cold-recovery.mjs';

const source = 'b'.repeat(40);
const root = resolve(import.meta.dirname, '../..');

test('controller refuses every cold request without an activation bypass', () => {
  for (const mode of ['preview', 'apply', undefined])
    assert.throws(
      () => runLegacyColdRecovery({ mode, selection: 'private-owner' }),
      (error) => error.code === 'cold_activation_disabled',
    );
});

test('both deploy entrypoints refuse cold flags before external tools or credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cold-disabled-'));
  const marker = join(directory, 'external-tool-started');
  const envFile = join(directory, 'env-must-not-load');
  writeFileSync(envFile, 'exit 99\n');
  for (const tool of ['docker', 'ssh', 'gh', 'node']) {
    const path = join(directory, tool);
    writeFileSync(path, '#!/bin/sh\n: > "$COLD_TEST_MARKER"\nexit 97\n');
    chmodSync(path, 0o700);
  }
  try {
    for (const script of ['vps-connect.sh', 'vps-pull-build-up.sh']) {
      for (const flag of [
        '--legacy-order-preview',
        '--legacy-order-preview=private-owner',
        '--legacy-order-apply',
        `--legacy-order-apply=${'a'.repeat(64)}:private-owner`,
      ]) {
        const args = script === 'vps-connect.sh' ? ['deploy', 'main', flag] : ['main', flag];
        const result = spawnSync('bash', [join(root, 'infra/scripts', script), ...args], {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            MAXIM_VPS_ENV_FILE: envFile,
            MAXIM_LEGACY_RECOVERY_OFFLINE: '1',
            MAXIM_LEGACY_RECOVERY_ENABLED: '1',
            COLD_TEST_MARKER: marker,
          },
        });
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /cold_activation_disabled/u);
        assert.doesNotMatch(result.stderr, /private-owner/u);
        assert.equal(existsSync(marker), false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
function fleet(stopped = false) {
  const roles = LEGACY_COLD_API_SERVICES.map((service, index) => ({
    Id: (index + 1).toString(16).padStart(64, '0'),
    Image: image,
    Name: `/infra-${service}-1`,
    State: {
      Running: !stopped,
      Status: stopped ? 'exited' : 'running',
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    Config: {
      Image: `maxim-api:${source}`,
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': service,
        'com.maxim.release-protected': 'true',
        'org.opencontainers.image.revision': source,
      },
      Env: [
        `APP_SERVICE_NAME=${service}`,
        `APP_ROLE=${service.startsWith('api-moderation') || service === 'api-media-analysis' ? 'moderation' : service.slice(4)}`,
        'DATABASE_URL=postgresql://do-not-log',
        'REDIS_URL=redis://do-not-log',
      ],
    },
  }));
  const ocrEnv = {
    NODE_ENV: 'production',
    COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
    PHOTO_DUPLICATE_MAX_BYTES: '16777216',
    COMMERCIAL_OCR_MAX_INPUT_PIXELS: '40000000',
    COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: '3000000',
    COMMERCIAL_OCR_MAX_SIDE: '2000',
    COMMERCIAL_OCR_TESSERACT_BINARY: 'tesseract',
    COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
    COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
    COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
    COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: '250',
    COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: '16777216',
    COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: '4194304',
    OMP_THREAD_LIMIT: '1',
  };
  const ocr = {
    Id: 'e'.repeat(64),
    Image: image,
    Name: '/infra-ocr-native-sandbox-1',
    State: { Running: true, Status: 'running', Health: { Status: 'healthy' } },
    Mounts: [
      {
        Type: 'volume',
        Name: 'infra_ocr_native_ipc',
        Destination: '/run/maxim-ocr',
        RW: true,
        Mode: 'rw',
      },
    ],
    Config: {
      User: '1000:1000',
      Cmd: [
        'node',
        'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js',
      ],
      Env: Object.entries(ocrEnv).map(([key, value]) => `${key}=${value}`),
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': 'ocr-native-sandbox',
        'com.maxim.release-protected': 'true',
        'com.maxim.ocr-native-sandbox': 'true',
        'com.maxim.ocr-native-sandbox-capable': 'true',
      },
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Init: true,
      Memory: 1024 ** 3,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,size=64m,mode=1777,uid=1000,gid=1000' },
    },
  };
  return [...roles, ocr, { ...photoRuntime(), Id: 'f'.repeat(64) }];
}
test('attests all 14 exact compatible generations while preserving auxiliary isolation', () => {
  const before = validateLegacyColdInventory(fleet(), image, source);
  const after = validateLegacyColdInventory(fleet(true), image, source, true, before);
  assert.equal(after.length, 14);
  assert.deepEqual(after, before);
});
test('cold proof rejects omitted roles, replicas and foreign/manual producers', () => {
  const original = fleet();
  assert.throws(() => validateLegacyColdInventory(original.slice(1), image, source));
  assert.throws(() =>
    validateLegacyColdInventory(
      [...original, { ...original[0], Id: '9'.repeat(64) }],
      image,
      source,
    ),
  );
  const foreign = structuredClone(original[0]);
  foreign.Id = '9'.repeat(64);
  foreign.Name = '/manual-api-ingress';
  delete foreign.Config.Labels['com.docker.compose.project'];
  assert.throws(
    () => validateLegacyColdInventory([...original, foreign], image, source),
    /producer/u,
  );
});
test('mixed sources/images or incomplete stop are never certified', () => {
  for (const mutate of [
    (row) => {
      row.Image = `sha256:${'c'.repeat(64)}`;
    },
    (row) => {
      row.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40);
    },
    (row) => {
      row.Config.Env.push('APP_ROLE=all');
    },
    (row) => {
      row.State.Running = true;
      row.State.Status = 'running';
    },
  ]) {
    const rows = fleet(true);
    mutate(rows[3]);
    assert.throws(() => validateLegacyColdInventory(rows, image, source, true));
  }
});
test('replacement of a stopped role invalidates its previously observed generation', () => {
  const before = validateLegacyColdInventory(fleet(), image, source);
  const rows = fleet(true);
  rows[4].Id = '9'.repeat(64);
  assert.throws(
    () => validateLegacyColdInventory(rows, image, source, true, before),
    /generation/u,
  );
});
test('partial stop permits only original compatible running/exited generations to restart', () => {
  const before = validateLegacyColdInventory(fleet(), image, source);
  const mixed = fleet();
  mixed[3].State.Running = false;
  mixed[3].State.Status = 'exited';
  assert.equal(validateLegacyColdInventory(mixed, image, source, 'restart', before).length, 14);
  assert.throws(() => validateLegacyColdInventory(mixed, image, source, true, before));
  assert.throws(() => validateLegacyColdInventory(mixed, image, source, 'restart'));
  mixed[3].Id = '9'.repeat(64);
  assert.throws(() => validateLegacyColdInventory(mixed, image, source, 'restart', before));
});
test('preview requires a finite distinct explicit target set', () => {
  assert.deepEqual(parseLegacyColdSelection('b,a'), ['a', 'b']);
  for (const value of [
    '',
    'a,a',
    '../sql',
    'a\nb',
    Array.from({ length: 201 }, (_, i) => `id${i}`).join(','),
  ])
    assert.throws(() => parseLegacyColdSelection(value), /finite/u);
});

test('client auto-removal is accepted only with an independent absence proof', () => {
  const id = 'c'.repeat(64);
  const calls = [];
  removeLegacyColdClient(id, (args) => {
    calls.push(args);
    if (args[0] === 'rm') throw new Error('already auto-removed');
    return '';
  });
  assert.deepEqual(calls, [
    ['rm', '-f', id],
    ['ps', '-aq', '--no-trunc', '--filter', `id=${id}`],
  ]);
});

test('a surviving or unobservable cold writer prevents role restart', () => {
  const id = 'c'.repeat(64);
  assert.throws(
    () =>
      removeLegacyColdClient(id, (args) => {
        if (args[0] === 'rm') throw new Error('daemon failure');
        return id;
      }),
    /unproved/u,
  );
  assert.throws(() =>
    removeLegacyColdClient(id, () => {
      throw new Error('daemon unavailable');
    }),
  );
});

test('cold refusal exposes only an allowlisted structured code', () => {
  const refusal = { version: 1, applied: false, refused: true, code: 'non_max_work_pending' };
  assert.equal(readLegacyColdRefusalCode(JSON.stringify(refusal)), 'non_max_work_pending');
  for (const output of [
    'database credentials or source text',
    JSON.stringify({ ...refusal, code: 'postgresql://secret' }),
    JSON.stringify({ ...refusal, version: 2 }),
    JSON.stringify({ ...refusal, applied: true }),
    JSON.stringify({ ...refusal, refused: false }),
    'x'.repeat(128 * 1024 + 1),
    null,
  ])
    assert.equal(readLegacyColdRefusalCode(output), null);
});
