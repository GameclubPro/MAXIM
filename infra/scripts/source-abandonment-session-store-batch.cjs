'use strict';

const { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');

const KIND = 'source_abandonment_session_store_batch';
const RESULT_KIND = `${KIND}_result`;
const STORE_BATCH_LIMITS = Object.freeze({
  requestBytes: 256 * 1024,
  stockRequestBytes: 64 * 1024,
  inventoryBytes: 8 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  readbackItems: 32,
  materializationPages: 200,
  phaseMs: Object.freeze({ install: 90000, materialize: 120000, readback: 300000 }),
});
const PINNED_ROOT = '/app/apps/api/dist/apps/api/src';
const INVENTORY_ROOT = '/run/maxim-source-session';
const requireFact = (condition) => {
  if (!condition) throw new Error('source_store_batch_refused');
};
const exact = (value, names) => {
  requireFact(value && typeof value === 'object' && !Array.isArray(value));
  requireFact([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireFact(keys.length === names.length && keys.every((key) => names.includes(key)));
  requireFact(
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    }),
  );
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const digest = (value) => sha256(JSON.stringify(canonical(value)));
const clock = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function loadPinnedRuntime() {
  const stock = require(`${PINNED_ROOT}/scripts/source-abandonment-store.js`);
  const prisma = require(`${PINNED_ROOT}/prisma/prisma-client.js`);
  return { stock, createPrismaClient: prisma.createPrismaClient };
}

// FLAG: Docker creates this fixed directory root-owned when mounting individual
// reviewed files. Its read-only root filesystem and non-writable parent prevent
// replacement; each actual file still requires caller ownership and mode 0600.
function assertSourceAbandonmentStoreInventoryDirectory(parent, uid) {
  requireFact(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      [0, uid].includes(parent.uid) &&
      (parent.mode & 0o022) === 0,
  );
}
// FLAG: The envelope supplies a canonical ordinal, never a path or module.
function readInventory(inventoryIndex) {
  requireFact(
    Number.isSafeInteger(inventoryIndex) &&
      inventoryIndex >= 0 &&
      inventoryIndex < STORE_BATCH_LIMITS.readbackItems,
  );
  const parent = lstatSync(INVENTORY_ROOT);
  assertSourceAbandonmentStoreInventoryDirectory(parent, process.getuid());
  const fd = openSync(
    join(INVENTORY_ROOT, `inventory-${inventoryIndex}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    requireFact(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size > 0 &&
        stat.size <= STORE_BATCH_LIMITS.inventoryBytes,
    );
    const bytes = readFileSync(fd);
    requireFact(bytes.length === stat.size);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function parseSourceAbandonmentStoreBatch(input, { now = Date.now, parseStockRequest } = {}) {
  requireFact(typeof parseStockRequest === 'function');
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  requireFact(
    typeof text === 'string' && Buffer.byteLength(text) <= STORE_BATCH_LIMITS.requestBytes,
  );
  const value = JSON.parse(text);
  exact(value, ['version', 'kind', 'phase', 'deadlineAtMs', 'items']);
  requireFact(
    value.version === 1 &&
      value.kind === KIND &&
      Object.hasOwn(STORE_BATCH_LIMITS.phaseMs, value.phase),
  );
  const timestamp = now();
  requireFact(
    Number.isSafeInteger(timestamp) &&
      Number.isSafeInteger(value.deadlineAtMs) &&
      value.deadlineAtMs > timestamp &&
      value.deadlineAtMs <= timestamp + STORE_BATCH_LIMITS.phaseMs[value.phase],
  );
  requireFact(
    Array.isArray(value.items) &&
      value.items.length >= 1 &&
      value.items.length <= (value.phase === 'readback' ? STORE_BATCH_LIMITS.readbackItems : 1),
  );
  const certificates = new Set();
  let bindingDigest;
  const items = value.items.map((item, index) => {
    exact(item, ['inventoryIndex', 'request']);
    requireFact(item.inventoryIndex === index);
    const requestText = JSON.stringify(item.request);
    requireFact(Buffer.byteLength(requestText) <= STORE_BATCH_LIMITS.stockRequestBytes);
    const request = parseStockRequest(requestText);
    requireFact(
      request.operation === 'readback' &&
        !Object.hasOwn(request, 'page') &&
        !Object.hasOwn(item.request, 'page') &&
        !certificates.has(request.certificateId),
    );
    const currentBindingDigest = digest({
      sourceSha: request.binding.sourceSha,
      imageId: request.binding.imageId,
      maintenanceId: request.binding.maintenanceId,
      queueFenceNonce: request.binding.queueFenceNonce,
      publisherBotId: request.binding.publisherBotId,
      stoppedGenerations: request.binding.stoppedGenerations,
      abandonBefore: request.selection.abandonBefore,
      majorBotIds: request.selection.majorBotIds,
    });
    requireFact(bindingDigest === undefined || bindingDigest === currentBindingDigest);
    bindingDigest = currentBindingDigest;
    certificates.add(request.certificateId);
    return { inventoryIndex: index, request };
  });
  return { version: 1, kind: KIND, phase: value.phase, deadlineAtMs: value.deadlineAtMs, items };
}

function assertResult(result, request, inventory) {
  requireFact(
    result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      result.version === 1 &&
      result.operation === request.operation &&
      result.certificateId === request.certificateId &&
      result.activationAuthorized === false &&
      result.bindingSha256 === digest(request.binding) &&
      result.inventorySha256 === request.expected.inventorySha256 &&
      result.previewSha256 === request.expected.previewSha256,
  );
  const keys = [
    'version',
    'operation',
    'certificateId',
    'activationAuthorized',
    'bindingSha256',
    'inventorySha256',
    'previewSha256',
    'state',
  ];
  exact(result, [
    ...keys,
    ...(request.operation === 'materialize'
      ? ['page', 'cursor']
      : request.operation === 'certificate_create'
        ? []
        : ['completeChats', 'requiredChats']),
  ]);
  if (request.operation === 'readback' || request.operation === 'install') {
    const chats = new Set(inventory.selectedOwners.map((row) => row.chatId)).size;
    requireFact(
      chats > 0 &&
        Number.isSafeInteger(result.completeChats) &&
        Number.isSafeInteger(result.requiredChats),
    );
    if (result.state === 'ABSENT')
      requireFact(
        request.operation === 'readback' &&
          result.completeChats === 0 &&
          result.requiredChats === 0,
      );
    else {
      requireFact(
        result.requiredChats === chats &&
          result.completeChats >= 0 &&
          result.completeChats <= chats,
      );
      if (result.state === 'UNSEALED')
        requireFact(request.operation === 'readback' && result.completeChats === 0);
      else if (result.state === 'MATERIALIZED') requireFact(result.completeChats === chats);
      else requireFact(result.state === 'SEALED' && result.completeChats < chats);
    }
  }
  requireFact(Buffer.byteLength(JSON.stringify(result)) <= STORE_BATCH_LIMITS.outputBytes);
  return result;
}

// FLAG: This harness only combines process startup. Every store operation still
// executes the immutable image's parser, environment guard, inventory verifier,
// pool settings and its own stock transaction. No retry or fallback exists here.
async function runSourceAbandonmentStoreBatch(input, dependencies = {}) {
  let prisma, output, failure;
  let deadlineAtMs;
  const now = dependencies.now ?? Date.now;
  try {
    const runtime =
      dependencies.stock && dependencies.createPrismaClient ? dependencies : loadPinnedRuntime();
    const stock = runtime.stock;
    for (const name of [
      'parseSourceAbandonmentStoreRequest',
      'verifySourceAbandonmentInventory',
      'executeSourceAbandonmentStore',
      'assertSourceAbandonmentStoreEnvironment',
      'sourceAbandonmentStorePoolConfig',
    ])
      requireFact(typeof stock[name] === 'function');
    const envelope = parseSourceAbandonmentStoreBatch(input, {
      now,
      parseStockRequest: stock.parseSourceAbandonmentStoreRequest,
    });
    deadlineAtMs = envelope.deadlineAtMs;
    const env = dependencies.env ?? process.env;
    requireFact(typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.length > 0);
    requireFact(
      ['MAX_BOT_TOKEN', 'MAX_BOTS_JSON', 'MAX_PUBLISHER_BOT_TOKEN'].every(
        (name) => env[name] === undefined || env[name] === '',
      ),
    );
    const checkDeadline = () => requireFact(now() < envelope.deadlineAtMs);
    const loadInventory = dependencies.readInventory ?? readInventory;
    const actualRequest = (base, operation, page) =>
      stock.parseSourceAbandonmentStoreRequest(
        JSON.stringify({ ...base, operation, ...(page ? { page } : {}) }),
      );
    const validate = (item, operation, page) => {
      checkDeadline();
      const request = actualRequest(item.request, operation, page);
      stock.assertSourceAbandonmentStoreEnvironment(request, env);
      const bytes = loadInventory(item.inventoryIndex);
      requireFact(
        Buffer.isBuffer(bytes) &&
          bytes.length <= STORE_BATCH_LIMITS.inventoryBytes &&
          sha256(bytes) === request.expected.inventoryArtifactSha256,
      );
      const inventory = stock.verifySourceAbandonmentInventory(request, bytes);
      checkDeadline();
      return { request, bytes, inventory };
    };
    const firstOperation =
      envelope.phase === 'install'
        ? 'certificate_create'
        : envelope.phase === 'materialize'
          ? 'materialize'
          : 'readback';
    // FLAG: Prevalidate every input and its actual operation environment before
    // opening a pool. Materialization derives its first chat from verified bytes.
    const inspected = envelope.items.map((item) => {
      if (envelope.phase !== 'materialize') {
        validate(item, firstOperation);
        return null;
      }
      checkDeadline();
      const bytes = loadInventory(item.inventoryIndex);
      requireFact(
        Buffer.isBuffer(bytes) &&
          bytes.length <= STORE_BATCH_LIMITS.inventoryBytes &&
          sha256(bytes) === item.request.expected.inventoryArtifactSha256,
      );
      const inventory = stock.verifySourceAbandonmentInventory(item.request, bytes);
      requireFact(
        Array.isArray(inventory.selectedOwners) &&
          inventory.selectedOwners.length >= 1 &&
          inventory.selectedOwners.length <= 8,
      );
      const chats = [...new Set(inventory.selectedOwners.map((row) => row.chatId))].sort();
      requireFact(chats.every((chatId) => typeof chatId === 'string' && chatId.length > 0));
      stock.assertSourceAbandonmentStoreEnvironment(
        actualRequest(item.request, 'materialize', { chatId: chats[0], pageSize: 200 }),
        env,
      );
      return { chats };
    });
    checkDeadline();
    prisma = runtime.createPrismaClient(
      env.DATABASE_URL,
      stock.sourceAbandonmentStorePoolConfig(envelope.phase === 'readback'),
    );
    requireFact(prisma && typeof prisma.$disconnect === 'function');
    const execute = async (item, operation, page) => {
      const validated = validate(item, operation, page);
      const result = assertResult(
        await stock.executeSourceAbandonmentStore(prisma, validated.request, validated.bytes),
        validated.request,
        validated.inventory,
      );
      checkDeadline();
      return result;
    };
    const results = [];
    for (const [index, item] of envelope.items.entries()) {
      let result;
      const entry = {
        inventoryIndex: item.inventoryIndex,
        certificateId: item.request.certificateId,
      };
      if (envelope.phase === 'install') {
        const created = await execute(item, 'certificate_create');
        requireFact(created.state === 'UNSEALED');
        result = await execute(item, 'install');
        requireFact(['SEALED', 'MATERIALIZED'].includes(result.state));
      } else if (envelope.phase === 'readback') {
        result = await execute(item, 'readback');
        requireFact(['ABSENT', 'UNSEALED', 'SEALED', 'MATERIALIZED'].includes(result.state));
      } else {
        const chats = inspected[index].chats;
        const pages = [];
        let horizon = null;
        for (const chatId of chats) {
          let complete = false;
          while (!complete) {
            requireFact(pages.length < STORE_BATCH_LIMITS.materializationPages);
            result = await execute(item, 'materialize', { chatId, pageSize: 200 });
            const page = result.page,
              cursor = result.cursor;
            exact(page, ['complete', 'scanned', 'applied', 'blocked']);
            exact(cursor, [
              'chatId',
              'horizon',
              'afterCreatedAt',
              'afterId',
              'scanned',
              'complete',
            ]);
            requireFact(
              result.state === 'SEALED' &&
                page &&
                cursor &&
                page.blocked === false &&
                typeof page.complete === 'boolean' &&
                Number.isSafeInteger(page.scanned) &&
                page.scanned >= 0 &&
                page.scanned <= 200 &&
                Number.isSafeInteger(page.applied) &&
                page.applied >= 0 &&
                page.applied <= page.scanned &&
                cursor.chatId === chatId &&
                cursor.complete === page.complete &&
                cursor.scanned === page.scanned &&
                cursor.afterCreatedAt === null &&
                cursor.afterId === null &&
                clock(cursor.horizon),
            );
            requireFact(horizon === null || horizon === cursor.horizon);
            horizon = cursor.horizon;
            requireFact(page.complete || page.scanned > 0);
            pages.push(result);
            requireFact(
              Buffer.byteLength(JSON.stringify(pages)) <= STORE_BATCH_LIMITS.outputBytes - 1024,
            );
            complete = page.complete;
          }
        }
        requireFact(pages.length > 0);
        entry.pages = pages;
      }
      results.push({ ...entry, result });
      requireFact(
        Buffer.byteLength(JSON.stringify(results)) <= STORE_BATCH_LIMITS.outputBytes - 512,
      );
    }
    checkDeadline();
    output = { version: 1, kind: RESULT_KIND, phase: envelope.phase, results };
    requireFact(Buffer.byteLength(JSON.stringify(output)) + 1 <= STORE_BATCH_LIMITS.outputBytes);
  } catch {
    failure = new Error('source_store_batch_refused');
  }
  try {
    await prisma?.$disconnect();
    if (!failure) requireFact(now() < deadlineAtMs);
  } catch {
    failure ??= new Error('source_store_batch_refused');
  }
  if (failure) throw failure;
  return output;
}

async function main() {
  let text = '',
    watchdog;
  const inputTimer = setTimeout(
    () => process.stdin.destroy(new Error('source_store_batch_refused')),
    5000,
  );
  const refusal = () =>
    `${JSON.stringify({ version: 1, kind: RESULT_KIND, refused: true, code: 'source_store_batch_refused' })}\n`;
  try {
    requireFact(process.argv.length === 2);
    for await (const part of process.stdin) {
      text += part;
      requireFact(Buffer.byteLength(text) <= STORE_BATCH_LIMITS.requestBytes);
    }
    clearTimeout(inputTimer);
    const header = JSON.parse(text);
    requireFact(
      Number.isSafeInteger(header.deadlineAtMs) &&
        header.deadlineAtMs > Date.now() &&
        Object.hasOwn(STORE_BATCH_LIMITS.phaseMs, header.phase) &&
        header.deadlineAtMs <= Date.now() + STORE_BATCH_LIMITS.phaseMs[header.phase],
    );
    watchdog = setTimeout(() => {
      process.stdout.write(refusal());
      process.exit(1);
    }, header.deadlineAtMs - Date.now());
    const result = await runSourceAbandonmentStoreBatch(text);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(refusal());
    process.exitCode = 1;
  } finally {
    clearTimeout(inputTimer);
    clearTimeout(watchdog);
  }
}

module.exports = {
  STORE_BATCH_LIMITS,
  assertSourceAbandonmentStoreInventoryDirectory,
  parseSourceAbandonmentStoreBatch,
  runSourceAbandonmentStoreBatch,
};
if (require.main === module) void main();
