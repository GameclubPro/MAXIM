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

  assert.deepEqual(classifyCommercialOcrApiContainerInventory(inspection, services), {
    ownedUnreviewedIds: [],
    ambiguousIds: [],
  });
});

test('requires the expected image after the release fence is available', () => {
  const expectedImageId = `sha256:${'1'.repeat(64)}`;
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
    {
      ownedUnreviewedIds: [mismatched.Id],
      ambiguousIds: [],
    },
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
  assert.doesNotMatch(JSON.stringify(result), /sensitive-value/u);
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
    {
      ownedUnreviewedIds: [],
      ambiguousIds: [foreignLegacy.Id, foreignAllRole.Id].sort(),
    },
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
    {
      ownedUnreviewedIds: [ownedAllRole.Id, ownedByName.Id].sort(),
      ambiguousIds: [foreignSibling.Id],
    },
  );
});

test('ignores stopped orphan containers and rejects malformed topology or inspection', () => {
  assert.deepEqual(
    classifyCommercialOcrApiContainerInventory(
      [container('a', { service: 'api-old', running: false })],
      services,
    ),
    { ownedUnreviewedIds: [], ambiguousIds: [] },
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
});
