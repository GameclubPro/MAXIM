import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCommercialOcrApiContainerInventory } from './commercial-ocr-runtime-inventory.mjs';

const services = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
];
const expectedImageId = `sha256:${'1'.repeat(64)}`;
const sandboxCommand = [
  'node',
  'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js',
];

function inventoryResult(overrides = {}) {
  return {
    ownedUnreviewedIds: [],
    ambiguousIds: [],
    expectedAuxiliaryCount: 0,
    reviewedAuxiliaryCount: 0,
    ...overrides,
  };
}

function container(id, options = {}) {
  const service = options.service ?? 'api-moderation';
  const project = options.project === undefined ? 'infra' : options.project;
  return {
    Id: id.repeat(64).slice(0, 64),
    Image: options.imageId ?? `sha256:${'1'.repeat(64)}`,
    Name: options.name ?? (project === null ? `/manual-${service}` : `/${project}-${service}-1`),
    State: { Running: options.running ?? true },
    Config: {
      Labels: {
        ...(project === null ? {} : { 'com.docker.compose.project': project }),
        'com.docker.compose.service': service,
        ...(options.releaseProtected ? { 'com.maxim.release-protected': 'true' } : {}),
      },
      Env: [
        `APP_SERVICE_NAME=${options.appService ?? service}`,
        `APP_ROLE=${options.appRole ?? 'moderation'}`,
        `COMMERCIAL_OCR_VERSION=${options.ocrVersion ?? 'tesseract-rus-eng-v2'}`,
        'REDIS_URL=redis://sensitive-value',
      ],
    },
  };
}

function sandboxContainer(id, options = {}) {
  const project = options.project === undefined ? 'infra' : options.project;
  const service = options.service ?? 'ocr-native-sandbox';
  return {
    Id: id.repeat(64).slice(0, 64),
    Image: options.imageId ?? expectedImageId,
    Name: options.name ?? `/${project}-${service}-1`,
    Mounts: options.mounts ?? [
      {
        Type: 'volume',
        Name: `${project}_ocr_native_ipc`,
        Destination: '/run/maxim-ocr',
        RW: true,
        Mode: 'rw',
      },
    ],
    State: {
      Running: options.running ?? true,
      Status: options.status ?? 'running',
      Health: { Status: options.health ?? 'healthy' },
    },
    Config: {
      User: options.user ?? '1000:1000',
      Cmd: options.command ?? sandboxCommand,
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': service,
        'com.maxim.release-protected': 'true',
        'com.maxim.ocr-native-sandbox': 'true',
        'com.maxim.ocr-native-sandbox-capable': 'true',
        ...(options.labels ?? {}),
      },
      Env: options.environment ?? [
        'NODE_ENV=production',
        'COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-ocr/native-ocr.sock',
        'PHOTO_DUPLICATE_MAX_BYTES=16777216',
        'COMMERCIAL_OCR_MAX_INPUT_PIXELS=40000000',
        'COMMERCIAL_OCR_MAX_OUTPUT_PIXELS=3000000',
        'COMMERCIAL_OCR_MAX_SIDE=2000',
        'COMMERCIAL_OCR_TESSERACT_BINARY=tesseract',
        'COMMERCIAL_OCR_TESSERACT_CONCURRENCY=1',
        'COMMERCIAL_OCR_TESSERACT_MAX_QUEUE=4',
        'COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS=10000',
        'COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS=250',
        'COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES=16777216',
        'COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES=4194304',
        'OMP_THREAD_LIMIT=1',
        'HOME=/home/node',
        'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt',
        'NODE_VERSION=24.8.0',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'YARN_VERSION=1.22.22',
      ],
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
      Tmpfs: { '/tmp': 'rw,size=67108864,mode=1777,uid=1000,gid=1000' },
      ...(options.hostConfig ?? {}),
    },
  };
}

test('accepts one reviewed running container per expected service', () => {
  const inspection = services.map((service, index) =>
    container((index + 1).toString(16), {
      service,
      appRole:
        service === 'api-ingress'
          ? 'ingress'
          : service === 'api-admin'
            ? 'admin'
            : service === 'api-enqueue'
              ? 'enqueue'
              : service === 'api-action'
                ? 'action'
                : service === 'api-publisher'
                  ? 'publisher'
                  : 'moderation',
    }),
  );

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(inspection, services),
    inventoryResult(),
  );
});

test('requires the expected image after the release fence is available', () => {
  const matching = container('a', {
    service: 'api-admin',
    appRole: 'admin',
    imageId: expectedImageId,
  });
  const mismatched = container('b', {
    service: 'api-action',
    appRole: 'action',
    imageId: `sha256:${'2'.repeat(64)}`,
  });

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory([matching, mismatched], services, expectedImageId),
    inventoryResult({ ownedUnreviewedIds: [mismatched.Id] }),
  );
});

test('finds orphan, foreign-project, mismatched and duplicate API containers', () => {
  const valid = container('a', { service: 'api-admin', appRole: 'admin' });
  const duplicate = container('b', { service: 'api-admin', appRole: 'admin' });
  const orphan = container('c', { service: 'api' });
  const foreign = container('d', {
    project: 'manual',
    service: 'worker',
    appService: 'api-action',
  });
  const mismatched = container('e', {
    service: 'api-moderation',
    appService: 'api-moderation-critical',
  });
  const protectedManual = container('1', {
    project: 'manual',
    service: 'worker',
    appService: '',
    ocrVersion: '',
    releaseProtected: true,
  });
  const unrelated = container('f', {
    service: 'postgres',
    appService: 'postgres',
    appRole: 'database',
    ocrVersion: '',
  });

  const result = classifyCommercialOcrApiContainerInventory(
    [valid, duplicate, orphan, foreign, mismatched, protectedManual, unrelated],
    services,
  );

  assert.deepEqual(
    result.ownedUnreviewedIds,
    [valid.Id, duplicate.Id, orphan.Id, mismatched.Id].sort(),
  );
  assert.deepEqual(result.ambiguousIds, [foreign.Id, protectedManual.Id].sort());
  assert.equal(result.expectedAuxiliaryCount, 0);
  assert.equal(result.reviewedAuxiliaryCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-value/u);
});

test('ignores release-protected static containers without API signals', () => {
  const miniapp = container('1', {
    service: 'miniapp-major-static',
    name: '/infra-miniapp-major-static-1',
    appService: '',
    appRole: '',
    ocrVersion: '',
    releaseProtected: true,
  });
  const admin = container('2', {
    service: 'admin-static',
    name: '/infra-admin-static-1',
    appService: '',
    appRole: '',
    ocrVersion: '',
    releaseProtected: true,
  });

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory([miniapp, admin], services),
    inventoryResult(),
  );
});

test('keeps release-protected API-like foreign and orphan containers fail closed', () => {
  const foreignService = container('1', {
    project: 'sibling',
    service: 'api-shadow',
    appService: '',
    appRole: '',
    ocrVersion: '',
    releaseProtected: true,
  });
  const foreignRole = container('2', {
    project: 'sibling',
    service: 'worker',
    appService: '',
    appRole: 'moderation',
    ocrVersion: '',
    releaseProtected: true,
  });
  const orphanName = container('3', {
    project: null,
    service: 'worker',
    name: '/orphan-api-worker',
    appService: '',
    appRole: '',
    ocrVersion: '',
    releaseProtected: true,
  });

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory([foreignService, foreignRole, orphanName], services),
    inventoryResult({
      ambiguousIds: [foreignService.Id, foreignRole.Id, orphanName.Id].sort(),
    }),
  );
});

test('keeps foreign legacy and all-role API containers ambiguous and never owned', () => {
  const foreignLegacy = container('a', {
    project: 'legacy',
    service: 'api',
    appRole: 'moderation',
  });
  foreignLegacy.Config.Env = ['APP_ROLE=moderation'];
  const foreignAllRole = container('b', {
    project: 'sibling',
    service: 'api',
    appRole: 'all',
    appService: '',
    ocrVersion: '',
  });
  foreignAllRole.Config.Env = ['APP_ROLE=all'];

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory([foreignLegacy, foreignAllRole], services),
    inventoryResult({ ambiguousIds: [foreignLegacy.Id, foreignAllRole.Id].sort() }),
  );
});

test('owns only exact infra project or unlabelled exact infra container names', () => {
  const ownedAllRole = container('a', {
    service: 'api',
    appRole: 'all',
    appService: '',
    ocrVersion: '',
  });
  ownedAllRole.Config.Env = ['APP_ROLE=all'];
  const ownedByName = container('b', {
    project: null,
    service: 'worker',
    name: '/infra-api-1',
    appRole: 'all',
    appService: '',
    ocrVersion: '',
  });
  ownedByName.Config.Env = ['APP_ROLE=all'];
  const foreignSibling = container('c', {
    project: 'sibling',
    service: 'api',
    appRole: 'admin',
    appService: '',
    ocrVersion: '',
  });
  foreignSibling.Config.Env = ['APP_ROLE=admin'];

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [ownedAllRole, ownedByName, foreignSibling],
      services,
      `sha256:${'f'.repeat(64)}`,
    ),
    inventoryResult({
      ownedUnreviewedIds: [ownedAllRole.Id, ownedByName.Id].sort(),
      ambiguousIds: [foreignSibling.Id],
    }),
  );
});

test('accepts exactly one source-expected, isolated OCR sandbox without changing role count', () => {
  const sandbox = sandboxContainer('e');
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [sandbox],
      services,
      expectedImageId,
      'infra',
      'ocr-native-sandbox',
    ),
    inventoryResult({ expectedAuxiliaryCount: 1, reviewedAuxiliaryCount: 1 }),
  );
});

test('fails closed for missing, duplicate, historical, foreign, or stale-image OCR sandboxes', () => {
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [],
      services,
      expectedImageId,
      'infra',
      'ocr-native-sandbox',
    ),
    inventoryResult({ expectedAuxiliaryCount: 1 }),
  );

  const first = sandboxContainer('a');
  const duplicate = sandboxContainer('b', { name: '/infra-ocr-native-sandbox-2' });
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [first, duplicate],
      services,
      expectedImageId,
      'infra',
      'ocr-native-sandbox',
    ),
    inventoryResult({
      ownedUnreviewedIds: [first.Id, duplicate.Id].sort(),
      expectedAuxiliaryCount: 1,
      reviewedAuxiliaryCount: 1,
    }),
  );

  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory([first], services, expectedImageId),
    inventoryResult({ ownedUnreviewedIds: [first.Id] }),
  );

  const mislabeledRole = container('e', { service: 'api-admin', appRole: 'admin' });
  mislabeledRole.Config.Labels['com.maxim.ocr-native-sandbox'] = 'true';
  mislabeledRole.Config.Labels['com.maxim.ocr-native-sandbox-capable'] = 'true';
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [first, mislabeledRole],
      services,
      expectedImageId,
      'infra',
      'ocr-native-sandbox',
    ),
    inventoryResult({
      ownedUnreviewedIds: [first.Id, mislabeledRole.Id].sort(),
      expectedAuxiliaryCount: 1,
      reviewedAuxiliaryCount: 1,
    }),
  );

  const foreign = sandboxContainer('c', { project: 'infra-scale' });
  const stale = sandboxContainer('d', { imageId: `sha256:${'2'.repeat(64)}` });
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [foreign, stale],
      services,
      expectedImageId,
      'infra',
      'ocr-native-sandbox',
    ),
    inventoryResult({
      ownedUnreviewedIds: [stale.Id],
      ambiguousIds: [foreign.Id],
      expectedAuxiliaryCount: 1,
    }),
  );
});

test('rejects every security-relevant OCR sandbox drift without retaining secret values', () => {
  const baselineEnvironment = sandboxContainer('0').Config.Env;
  const defects = [
    { status: 'paused' },
    { health: 'unhealthy' },
    { user: '0:0' },
    { command: ['node', 'unexpected.js'] },
    { environment: [...baselineEnvironment, 'REDIS_URL=redis://private'] },
    { environment: [...baselineEnvironment, 'COMMERCIAL_OCR_TESSDATA_PREFIX=/models'] },
    {
      environment: baselineEnvironment.map((entry) =>
        entry.startsWith('COMMERCIAL_OCR_MAX_SIDE=') ? 'COMMERCIAL_OCR_MAX_SIDE=1600' : entry,
      ),
    },
    {
      environment: baselineEnvironment.filter(
        (entry) => !entry.startsWith('COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS='),
      ),
    },
    { labels: { 'com.maxim.release-protected': 'false' } },
    { labels: { 'com.maxim.ocr-native-sandbox': 'false' } },
    { labels: { 'com.maxim.ocr-native-sandbox-capable': 'false' } },
    { hostConfig: { NetworkMode: 'default' } },
    { hostConfig: { ReadonlyRootfs: false } },
    { hostConfig: { Init: false } },
    { hostConfig: { Memory: 512 * 1024 ** 2 } },
    { hostConfig: { NanoCpus: 2_000_000_000 } },
    { hostConfig: { PidsLimit: 0 } },
    { hostConfig: { CapDrop: [] } },
    { hostConfig: { SecurityOpt: [] } },
    { hostConfig: { Tmpfs: { '/tmp': 'size=128m,mode=1777,uid=1000,gid=1000' } } },
    { mounts: [] },
    {
      mounts: [
        {
          Type: 'volume',
          Name: 'infra_ocr_native_ipc',
          Destination: '/run/maxim-ocr',
          RW: false,
          Mode: 'ro',
        },
      ],
    },
  ];

  defects.forEach((defect, index) => {
    const sandbox = sandboxContainer((index + 1).toString(16), defect);
    const result = classifyCommercialOcrApiContainerInventory(
      [sandbox],
      services,
      expectedImageId,
      'infra',
      'ocr-native-sandbox',
    );
    assert.deepEqual(
      result,
      inventoryResult({
        ownedUnreviewedIds: [sandbox.Id],
        expectedAuxiliaryCount: 1,
      }),
      JSON.stringify(defect),
    );
    assert.doesNotMatch(JSON.stringify(result), /redis|private/u);
  });
});

test('ignores stopped orphan containers and rejects malformed topology or inspection', () => {
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [container('a', { service: 'api-old', running: false })],
      services,
    ),
    inventoryResult(),
  );
  assert.throws(
    () => classifyCommercialOcrApiContainerInventory([], services.slice(1)),
    /13 unique expected services/u,
  );
  assert.throws(
    () => classifyCommercialOcrApiContainerInventory({}, services),
    /inspection must be an array/u,
  );
  assert.throws(
    () => classifyCommercialOcrApiContainerInventory([], services, 'latest'),
    /expected image id is invalid/u,
  );
  assert.throws(
    () => classifyCommercialOcrApiContainerInventory([], services, null, 'infra', 'sandbox'),
    /expected auxiliary service is invalid/u,
  );
});
