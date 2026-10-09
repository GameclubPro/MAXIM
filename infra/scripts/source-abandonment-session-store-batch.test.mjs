import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import batch from './source-abandonment-session-store-batch.cjs';
import { canonicalLegacyColdDigest as digest } from './legacy-cold-store-adapter.mjs';

const {
  STORE_BATCH_LIMITS,
  parseSourceAbandonmentStoreBatch: parse,
  runSourceAbandonmentStoreBatch: run,
} = batch;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const kind = 'source_abandonment_session_store_batch';
const refusal = { message: 'source_store_batch_refused' };
const identity = (index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
const horizon = '2026-10-09T18:00:00.000Z';

test('individual Docker bind mounts accept a root-owned readonly directory and reject writable or redirected parents', () => {
  const validate = batch.assertSourceAbandonmentStoreInventoryDirectory;
  const directory = { uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false };
  validate(directory, 1000);
  validate({ ...directory, uid: 1000, mode: 0o700 }, 1000);
  for (const changed of [
    { uid: 1001 },
    { mode: 0o775 },
    { mode: 0o777 },
    { isDirectory: () => false },
    { isSymbolicLink: () => true },
  ])
    assert.throws(() => validate({ ...directory, ...changed }, 1000), refusal);
});

function fixture({ phase = 'install', count = 1, chats = ['-1', '-2'] } = {}) {
  const state = {
    time: 1000,
    calls: [],
    reads: [],
    events: [],
    clients: [],
    disconnects: 0,
    response: null,
    executeError: null,
    disconnectError: null,
    read: null,
  };
  const inventories = Array.from({ length: count }, (_, index) =>
    Buffer.from(
      JSON.stringify({
        selectedOwners: chats.map((chatId, owner) => ({
          chatId,
          ownerWebhookEventId: `owner-${index}-${owner}`,
        })),
      }),
    ),
  );
  const envelope = {
    version: 1,
    kind,
    phase,
    deadlineAtMs: state.time + STORE_BATCH_LIMITS.phaseMs[phase],
    items: inventories.map((bytes, index) => ({
      inventoryIndex: index,
      request: {
        version: 1,
        operation: 'readback',
        certificateId: identity(index),
        binding: {
          sourceSha: 'a'.repeat(40),
          imageId: 'sha256:' + 'b'.repeat(64),
          maintenanceId: identity(200),
          queueFenceNonce: identity(201),
          publisherBotId: 'publisher',
          stoppedGenerations: [{ service: 'api-ingress', containerId: 'c'.repeat(64) }],
        },
        selection: {
          abandonBefore: '2026-10-09T16:10:00.000Z',
          majorBotIds: ['major-1'],
          ownerWebhookEventIds: [`owner-${index}`],
        },
        expected: {
          inventoryArtifactSha256: sha(bytes),
          inventorySha256: 'd'.repeat(64),
          previewSha256: 'e'.repeat(64),
        },
      },
    })),
  };
  const result = (request, stateValue) => ({
    version: 1,
    operation: request.operation,
    certificateId: request.certificateId,
    activationAuthorized: false,
    bindingSha256: digest(request.binding),
    inventorySha256: request.expected.inventorySha256,
    previewSha256: request.expected.previewSha256,
    state:
      stateValue ??
      (request.operation === 'certificate_create'
        ? 'UNSEALED'
        : request.operation === 'materialize'
          ? 'SEALED'
          : 'MATERIALIZED'),
    ...(['readback', 'install'].includes(request.operation)
      ? { requiredChats: chats.length, completeChats: chats.length }
      : {}),
    ...(request.operation === 'materialize'
      ? {
          page: { complete: true, scanned: 1, applied: 1, blocked: false },
          cursor: {
            chatId: request.page.chatId,
            horizon,
            afterCreatedAt: null,
            afterId: null,
            scanned: 1,
            complete: true,
          },
        }
      : {}),
  });
  const stock = {
    parseSourceAbandonmentStoreRequest(text) {
      const request = JSON.parse(text);
      assert.equal(request.version, 1);
      assert(
        ['certificate_create', 'install', 'readback', 'materialize'].includes(request.operation),
      );
      if (request.operation === 'materialize')
        assert.deepEqual(Object.keys(request.page).sort(), ['chatId', 'pageSize']);
      else assert.equal(request.page, undefined);
      return request;
    },
    verifySourceAbandonmentInventory(request, bytes) {
      state.events.push('verify');
      assert.equal(sha(bytes), request.expected.inventoryArtifactSha256);
      return JSON.parse(bytes.toString());
    },
    assertSourceAbandonmentStoreEnvironment(request, env) {
      state.events.push('environment:' + request.operation);
      assert.equal(
        env.MAXIM_SOURCE_ABANDONMENT_STORE_MODE,
        request.operation === 'readback' ? 'readback' : 'writer',
      );
    },
    sourceAbandonmentStorePoolConfig(readonly) {
      state.events.push('pool-config');
      return { max: 1, readonly };
    },
    async executeSourceAbandonmentStore(prisma, request, bytes) {
      assert.equal(prisma, state.clients[0]);
      assert.equal(sha(bytes), request.expected.inventoryArtifactSha256);
      state.calls.push(structuredClone(request));
      state.events.push('execute:' + request.operation);
      if (state.executeError) await state.executeError(request);
      return state.response ? state.response(request, result(request)) : result(request);
    },
  };
  const dependencies = {
    stock,
    now: () => state.time,
    env: {
      DATABASE_URL: 'postgresql://fixture@127.0.0.1/test',
      MAXIM_SOURCE_ABANDONMENT_STORE_MODE: phase === 'readback' ? 'readback' : 'writer',
    },
    readInventory(index) {
      state.events.push('inventory:' + index);
      state.reads.push(index);
      return state.read ? state.read(index) : inventories[index];
    },
    createPrismaClient(url, config) {
      assert.equal(url, dependencies.env.DATABASE_URL);
      state.events.push('open');
      const prisma = {
        config,
        async $disconnect() {
          state.events.push('disconnect');
          state.disconnects++;
          if (state.disconnectError) throw state.disconnectError;
        },
      };
      state.clients.push(prisma);
      return prisma;
    },
  };
  return {
    state,
    envelope,
    dependencies,
    inventories,
    result,
    parse: (input = envelope) =>
      parse(input, {
        now: dependencies.now,
        parseStockRequest: stock.parseSourceAbandonmentStoreRequest,
      }),
    run: () => run(envelope, dependencies),
  };
}

test('install runs one create then one install with separately verified bytes on one stock writer pool', async () => {
  const h = fixture();
  const output = await h.run();
  assert.deepEqual(
    h.state.calls.map((row) => row.operation),
    ['certificate_create', 'install'],
  );
  assert.equal(h.state.clients.length, 1);
  assert.deepEqual(h.state.clients[0].config, { max: 1, readonly: false });
  assert.equal(h.state.reads.length, 3);
  assert.equal(h.state.disconnects, 1);
  assert.equal(output.results[0].result.operation, 'install');
  assert.equal(output.results[0].result.state, 'MATERIALIZED');
  assert.equal(output.kind, kind + '_result');
  assert.equal(output.results[0].pages, undefined);
});

for (const operation of ['certificate_create', 'install'])
  test(`unknown ${operation} acknowledgement never retries or falls back to readback`, async () => {
    const h = fixture();
    h.state.executeError = (request) => {
      if (request.operation === operation) throw new Error('DATABASE_CREDENTIAL_OR_PAYLOAD');
    };
    await assert.rejects(h.run(), refusal);
    assert.deepEqual(
      h.state.calls.map((row) => row.operation),
      operation === 'install' ? ['certificate_create', 'install'] : ['certificate_create'],
    );
    assert.equal(h.state.disconnects, 1);
  });

test('changed reviewed inventory between create and install refuses before a second transaction', async () => {
  const h = fixture();
  h.state.read = (index) => (h.state.calls.length ? Buffer.from('changed') : h.inventories[index]);
  await assert.rejects(h.run(), refusal);
  assert.deepEqual(
    h.state.calls.map((row) => row.operation),
    ['certificate_create'],
  );
  assert.equal(h.state.disconnects, 1);
});

test('readback prevalidates every input then uses a separate readonly pool and canonical output order', async () => {
  const h = fixture({ phase: 'readback', count: 3 });
  const output = await h.run();
  assert.deepEqual(h.state.reads, [0, 1, 2, 0, 1, 2]);
  assert(h.state.events.indexOf('inventory:2') < h.state.events.indexOf('open'));
  assert.equal(h.state.clients[0].config.readonly, true);
  assert.deepEqual(
    output.results.map((row) => row.certificateId),
    [identity(0), identity(1), identity(2)],
  );
  assert(h.state.calls.every((request) => request.operation === 'readback'));
});

test('invalid last readback inventory opens no pool and issues no earlier readback', async () => {
  const h = fixture({ phase: 'readback', count: 3 });
  h.state.read = (index) => (index === 2 ? Buffer.from('{}') : h.inventories[index]);
  await assert.rejects(h.run(), refusal);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.clients.length, 0);
});

for (const change of [
  'version',
  'kind',
  'phase',
  'extra',
  'index',
  'duplicate',
  'writer',
  'page',
  'empty',
  'writer-count',
  'readback-count',
  'deadline-expired',
  'deadline-max',
  'deadline-fraction',
  'stock-bytes',
  'envelope-bytes',
])
  test(`batch parser refuses ${change}`, () => {
    const h = fixture({ phase: 'readback', count: 2 }),
      e = h.envelope;
    if (change === 'version') e.version = 2;
    if (change === 'kind') e.kind = 'foreign';
    if (change === 'phase') e.phase = 'certificate_create';
    if (change === 'extra') e.extra = true;
    if (change === 'index') e.items[1].inventoryIndex = 4;
    if (change === 'duplicate') e.items[1].request.certificateId = e.items[0].request.certificateId;
    if (change === 'writer') e.items[0].request.operation = 'install';
    if (change === 'page') e.items[0].request.page = { chatId: '-1', pageSize: 200 };
    if (change === 'empty') e.items = [];
    if (change === 'writer-count') {
      e.phase = 'install';
      e.deadlineAtMs = 90000;
    }
    if (change === 'readback-count')
      e.items = Array.from({ length: 33 }, (_, index) => ({
        ...e.items[0],
        inventoryIndex: index,
        request: { ...e.items[0].request, certificateId: identity(index) },
      }));
    if (change === 'deadline-expired') e.deadlineAtMs = 1000;
    if (change === 'deadline-max') e.deadlineAtMs++;
    if (change === 'deadline-fraction') e.deadlineAtMs -= 0.5;
    if (change === 'stock-bytes')
      e.items[0].request.extra = 'x'.repeat(STORE_BATCH_LIMITS.stockRequestBytes);
    if (change === 'envelope-bytes') e.extra = 'x'.repeat(STORE_BATCH_LIMITS.requestBytes);
    assert.throws(() => h.parse());
  });

for (const field of [
  'sourceSha',
  'imageId',
  'maintenanceId',
  'queueFenceNonce',
  'publisherBotId',
  'stoppedGenerations',
  'abandonBefore',
  'majorBotIds',
])
  test(`batch parser refuses mismatched ${field} across certificates`, () => {
    const h = fixture({ phase: 'readback', count: 2 });
    const request = h.envelope.items[1].request;
    if (field === 'abandonBefore' || field === 'majorBotIds')
      request.selection[field] = field === 'majorBotIds' ? ['major-2'] : '2026-10-08T16:10:00.000Z';
    else request.binding[field] = field === 'stoppedGenerations' ? [] : 'foreign';
    assert.throws(() => h.parse(), refusal);
  });

test('32 canonical readbacks fit the declared envelope and preserve the actual stock requests', () => {
  const h = fixture({ phase: 'readback', count: 32 });
  assert.deepEqual(h.parse(), h.envelope);
});

test('materialization finishes all pages of each verified chat on a fresh writer pool without writer readback', async () => {
  const h = fixture({ phase: 'materialize', chats: ['-2', '-1', '-2'] });
  h.state.response = (request, value) => {
    const complete = h.state.calls.length !== 1;
    return { ...value, page: { ...value.page, complete }, cursor: { ...value.cursor, complete } };
  };
  const output = await h.run();
  assert.deepEqual(
    h.state.calls.map((row) => row.page),
    [
      { chatId: '-1', pageSize: 200 },
      { chatId: '-1', pageSize: 200 },
      { chatId: '-2', pageSize: 200 },
    ],
  );
  assert.equal(output.results[0].pages.length, 3);
  assert.deepEqual(output.results[0].result, output.results[0].pages.at(-1));
  assert.equal(h.state.clients[0].config.readonly, false);
  assert(h.state.events.indexOf('environment:materialize') < h.state.events.indexOf('open'));
  assert(h.state.calls.every((row) => row.operation === 'materialize'));
});

for (const change of [
  'foreign-chat',
  'cursor-complete',
  'cursor-scanned',
  'cursor-after',
  'bad-horizon',
  'horizon-drift',
  'blocked',
  'scanned-cap',
  'negative-scanned',
  'applied-cap',
  'empty-progress',
  'wrong-state',
  'extra-page-field',
  'extra-cursor-field',
])
  test(`materialization refuses ${change} and issues no next page`, async () => {
    const h = fixture({ phase: 'materialize' });
    h.state.response = (request, value) => {
      if (change === 'foreign-chat') value.cursor.chatId = 'foreign';
      if (change === 'cursor-complete') value.cursor.complete = false;
      if (change === 'cursor-scanned') value.cursor.scanned = 2;
      if (change === 'cursor-after') value.cursor.afterId = 'receipt';
      if (change === 'bad-horizon') value.cursor.horizon = 'yesterday';
      if (change === 'horizon-drift' && h.state.calls.length === 2)
        value.cursor.horizon = '2026-10-09T18:01:00.000Z';
      if (change === 'blocked') value.page.blocked = true;
      if (change === 'scanned-cap') value.page.scanned = value.cursor.scanned = 201;
      if (change === 'negative-scanned') value.page.scanned = value.cursor.scanned = -1;
      if (change === 'applied-cap') value.page.applied = 2;
      if (change === 'empty-progress') {
        value.page.complete = value.cursor.complete = false;
        value.page.scanned = value.cursor.scanned = value.page.applied = 0;
      }
      if (change === 'wrong-state') value.state = 'MATERIALIZED';
      if (change === 'extra-page-field') value.page.extra = true;
      if (change === 'extra-cursor-field') value.cursor.extra = true;
      return value;
    };
    await assert.rejects(h.run(), refusal);
    assert.equal(h.state.calls.length, change === 'horizon-drift' ? 2 : 1);
    assert.equal(h.state.disconnects, 1);
  });

test('materialization refuses page 201 without issuing it', async () => {
  const h = fixture({ phase: 'materialize', chats: ['-1'] });
  h.state.response = (request, value) => ({
    ...value,
    page: { ...value.page, complete: false },
    cursor: { ...value.cursor, complete: false },
  });
  await assert.rejects(h.run(), refusal);
  assert.equal(h.state.calls.length, 200);
  assert.equal(h.state.disconnects, 1);
});

test('deadline reached by a completed transaction forbids the next operation', async () => {
  const h = fixture();
  h.state.response = (request, value) => {
    h.state.time = h.envelope.deadlineAtMs;
    return value;
  };
  await assert.rejects(h.run(), refusal);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.disconnects, 1);
});

for (const phase of ['install', 'readback', 'materialize'])
  test(`${phase} wrong mode is rejected before opening a pool`, async () => {
    const h = fixture({ phase });
    h.dependencies.env.MAXIM_SOURCE_ABANDONMENT_STORE_MODE = 'foreign';
    await assert.rejects(h.run(), refusal);
    assert.equal(h.state.clients.length, 0);
  });

for (const key of ['DATABASE_URL', 'MAX_BOT_TOKEN', 'MAX_BOTS_JSON', 'MAX_PUBLISHER_BOT_TOKEN'])
  test(`credential boundary rejects invalid ${key} before SQL`, async () => {
    const h = fixture();
    h.dependencies.env[key] = key === 'DATABASE_URL' ? '' : 'secret';
    await assert.rejects(h.run(), refusal);
    assert.equal(h.state.clients.length, 0);
  });

for (const change of [
  'missing',
  'operation',
  'certificate',
  'activation',
  'binding',
  'inventory',
  'preview',
  'extra',
  'oversized',
  'chat-count',
  'incomplete-materialized',
  'complete-sealed',
  'unsealed-count',
  'absent-count',
])
  test(`readback refuses ${change} output with a fixed error`, async () => {
    const h = fixture({ phase: 'readback' });
    h.state.response = (request, value) => {
      if (change === 'missing') return undefined;
      if (change === 'operation') value.operation = 'install';
      if (change === 'certificate') value.certificateId = identity(100);
      if (change === 'activation') value.activationAuthorized = true;
      if (change === 'binding') value.bindingSha256 = '0'.repeat(64);
      if (change === 'inventory') value.inventorySha256 = '0'.repeat(64);
      if (change === 'preview') value.previewSha256 = '0'.repeat(64);
      if (change === 'extra') value.extra = 'private-payload';
      if (change === 'oversized') value.extra = 'x'.repeat(STORE_BATCH_LIMITS.outputBytes);
      if (change === 'chat-count') value.requiredChats++;
      if (change === 'incomplete-materialized') value.completeChats--;
      if (change === 'complete-sealed') value.state = 'SEALED';
      if (change === 'unsealed-count') value.state = 'UNSEALED';
      if (change === 'absent-count') value.state = 'ABSENT';
      return value;
    };
    await assert.rejects(h.run(), refusal);
    assert.equal(h.state.disconnects, 1);
  });

test('stock absent, unsealed and incomplete sealed readbacks preserve their actual evidence', async () => {
  for (const state of ['ABSENT', 'UNSEALED', 'SEALED']) {
    const h = fixture({ phase: 'readback' });
    h.state.response = (request, value) => ({
      ...value,
      state,
      completeChats: 0,
      requiredChats: state === 'ABSENT' ? 0 : 2,
    });
    assert.equal((await h.run()).results[0].result.state, state);
  }
});

test('disconnect failure cannot return success or leak database details', async () => {
  const h = fixture();
  h.state.disconnectError = new Error('postgresql://private-secret');
  await assert.rejects(h.run(), refusal);
  assert.equal(h.state.disconnects, 1);
});

test('pool cleanup that crosses the absolute deadline cannot return success', async () => {
  const h = fixture();
  const open = h.dependencies.createPrismaClient;
  h.dependencies.createPrismaClient = (...args) => {
    const prisma = open(...args),
      disconnect = prisma.$disconnect;
    prisma.$disconnect = async () => {
      await disconnect();
      h.state.time = h.envelope.deadlineAtMs;
    };
    return prisma;
  };
  await assert.rejects(h.run(), refusal);
  assert.equal(h.state.disconnects, 1);
});

test('CLI rejects malformed and oversized input using bounded sanitized output', () => {
  for (const input of [
    'not-json private-secret',
    'x'.repeat(STORE_BATCH_LIMITS.requestBytes + 1),
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL('./source-abandonment-session-store-batch.cjs', import.meta.url).pathname],
      { input, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1,
      kind: kind + '_result',
      refused: true,
      code: 'source_store_batch_refused',
    });
  }
});

test(
  'native PG16 executes actual stock readbacks in separate readonly Serializable transactions and refuses an ineligible writer once',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async () => {
    const databaseUrl = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) &&
        databaseUrl.pathname.includes('race_test'),
    );
    process.env.TSX_TSCONFIG_PATH = new URL(
      '../../apps/api/tsconfig.json',
      import.meta.url,
    ).pathname;
    const { require: requireTs } = await import('tsx/cjs/api');
    const runtime = requireTs(
      '../../apps/api/src/scripts/source-abandonment-store.ts',
      import.meta.url,
    );
    const prismaRuntime = requireTs('../../apps/api/src/prisma/prisma-client.ts', import.meta.url);
    const { RUNTIME_SERVICE_NAMES } = requireTs(
      '../../apps/api/src/runtime/runtime-topology.ts',
      import.meta.url,
    );
    const { sourceAbandonmentSourceClosureDigest } = requireTs(
      '../../apps/api/src/scripts/source-abandonment-source-closure.ts',
      import.meta.url,
    );
    const sourceSha = 'a'.repeat(40),
      imageId = 'sha256:' + 'b'.repeat(64);
    const catalog = {
      version: 2,
      complete: true,
      namespaceKeyCounts: {},
      issue: null,
      cost: {
        pages: 1,
        scanCountHints: 4096,
        matchedKeys: 0,
        keyBytes: 0,
        bytes: 1,
        measurementBytes: 1,
        databaseKeysMax: 0,
        serverDurationUs: 0,
        maxCallDurationUs: 0,
        durationMs: 0,
      },
    };
    const inventories = [];
    const items = Array.from({ length: 3 }, (_, index) => {
      const selection = {
        protocol: 'source-abandonment-v1',
        abandonBefore: '2026-10-09T16:10:00.000Z',
        majorBotIds: ['major-1'],
        ownerWebhookEventIds: [`native-batch-owner-${index}`],
      };
      const parsed = runtime.parseSourceAbandonmentStoreRequest(
        JSON.stringify({
          version: 1,
          operation: 'readback',
          certificateId: identity(index),
          selection,
          expected: {
            inventorySha256: 'c'.repeat(64),
            inventoryArtifactSha256: 'd'.repeat(64),
            previewSha256: 'e'.repeat(64),
          },
          binding: {
            maintenanceId: identity(100),
            queueFenceNonce: identity(101),
            transitionJournalSha256: sha(`child-${index}`),
            sourceSha,
            imageId,
            stoppedGenerations: [
              ...RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'),
              'ocr-native-sandbox',
              'photo-native-sandbox',
            ].map((serviceName) => ({
              serviceName,
              containerId: sha(serviceName),
              sourceSha,
              imageId,
              stopped: true,
            })),
          },
        }),
      );
      // FLAG: This synthetic inventory is confined to an absent-certificate readback
      // in a disposable database. The actual stock writer must reject its missing source.
      const inventory = {
        version: 1,
        operation: 'inventory_preview',
        applied: false,
        activationAuthorized: false,
        decision: 'READY_TO_INSTALL',
        binding: parsed.binding,
        selectionSha256: digest(parsed.selection),
        registrySha256: sourceAbandonmentSourceClosureDigest(sourceSha, imageId),
        previewSha256: parsed.expected.previewSha256,
        sqlEvidenceSha256: '1'.repeat(64),
        redisEvidenceSha256: '2'.repeat(64),
        selectedOwners: [
          {
            ownerWebhookEventId: selection.ownerWebhookEventIds[0],
            semanticKey: `semantic-${index}`,
            claimId: `claim-${index}`,
            chatId: '-native-batch',
            messageId: `message-${index}`,
            userId: 'native-user',
            sourceAt: '2026-10-09T15:00:00.000Z',
            rawPayloadSha256: '3'.repeat(64),
            normalizedPayloadSha256: '4'.repeat(64),
            ownerSnapshotSha256: '5'.repeat(64),
            claimSnapshotSha256: '6'.repeat(64),
          },
        ],
        children: [],
        sqlPlans: [],
        issues: [],
        cost: { pages: 1, rows: 1, probes: 1, bytes: 1 },
        redisCatalogs: [catalog, catalog],
      };
      inventory.inventorySha256 = runtime.buildSourceAbandonmentInventoryDigest(inventory);
      const bytes = Buffer.from(JSON.stringify(inventory));
      inventories.push(bytes);
      return {
        inventoryIndex: index,
        request: {
          ...parsed,
          expected: {
            ...parsed.expected,
            inventorySha256: inventory.inventorySha256,
            inventoryArtifactSha256: sha(bytes),
          },
        },
      };
    });
    const events = [],
      poolConfigs = [],
      transactions = [];
    const env = {
      DATABASE_URL: databaseUrl.href,
      MAXIM_SOURCE_ABANDONMENT_OFFLINE: '1',
      MAXIM_SOURCE_ABANDONMENT_PROTOCOL: 'source-abandonment-v1',
      MAXIM_SOURCE_ABANDONMENT_STORE_MODE: 'readback',
      APP_SERVICE_NAME: 'source-abandonment-store',
      APP_SOURCE_SHA: sourceSha,
      MAXIM_SOURCE_ABANDONMENT_IMAGE_ID: imageId,
      TZ: 'UTC',
    };
    const dependencies = {
      stock: runtime,
      env,
      readInventory: (index) => inventories[index],
      createPrismaClient(url, config) {
        poolConfigs.push(config);
        const prisma = prismaRuntime.createPrismaClient(url, config);
        return {
          $transaction: (callback, options) =>
            prisma.$transaction(async (tx) => {
              assert.deepEqual(options, {
                isolationLevel: 'Serializable',
                maxWait: 3000,
                timeout: 35000,
              });
              const [settings] =
                await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation, current_setting('TimeZone') AS timezone, current_setting('server_version') AS version`;
              transactions.push(settings);
              return callback(tx);
            }, options),
          async $disconnect() {
            events.push('disconnect');
            await prisma.$disconnect();
          },
        };
      },
    };
    const output = await run(
      { version: 1, kind, phase: 'readback', deadlineAtMs: Date.now() + 300000, items },
      dependencies,
    );
    assert.deepEqual(
      output.results.map(({ result }) => [
        result.state,
        result.requiredChats,
        result.completeChats,
      ]),
      Array.from({ length: 3 }, () => ['ABSENT', 0, 0]),
    );
    assert.equal(poolConfigs.length, 1);
    assert.equal(poolConfigs[0].max, 1);
    assert.equal(transactions.length, 3);
    assert(
      transactions.every(
        (row) =>
          row.readonly === 'on' &&
          row.isolation === 'serializable' &&
          row.timezone === 'UTC' &&
          /^16\./u.test(row.version),
      ),
    );
    env.MAXIM_SOURCE_ABANDONMENT_STORE_MODE = 'writer';
    await assert.rejects(
      run(
        { version: 1, kind, phase: 'install', deadlineAtMs: Date.now() + 90000, items: [items[0]] },
        dependencies,
      ),
      refusal,
    );
    assert.equal(poolConfigs.length, 2);
    assert.equal(transactions.length, 4);
    assert.equal(transactions.at(-1).readonly, 'off');
    assert.equal(events.length, 2);
  },
);
