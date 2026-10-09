import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readPrivateInventoryFile,
  attestInventoryRuntime,
  createInventoryAuditExecutor,
} from './webhook-order-blocker-inventory-cli.mjs';
import {
  parseOrderedAnchorRequest,
  validateOrderedAnchorPage,
  createOrderedAnchorAccumulator,
} from './webhook-ordered-anchor-inventory.mjs';
import {
  buildOrderedAnchorPageSql,
  validateOrderedAnchorPagePlan,
} from './webhook-ordered-anchor-inventory-sql.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const check = (value, code = 'ordered_inventory_refused') => {
  if (!value) throw new Error(code);
};
function directoryGuard(directory) {
  const stat = lstatSync(directory);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700,
    'ordered_inventory_directory_refused',
  );
}
function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function immutable(path, bytes) {
  if (existsSync(path)) {
    check(readPrivateInventoryFile(path).equals(bytes), 'ordered_inventory_artifact_changed');
    return;
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}
function checkpoint(directory, value, expected) {
  const path = join(directory, 'checkpoint.json');
  check(
    (existsSync(path) ? hash(readPrivateInventoryFile(path)) : null) === expected,
    'ordered_inventory_checkpoint_changed',
  );
  const temporary = join(directory, `checkpoint-${randomUUID()}.tmp`),
    bytes = encode(value);
  immutable(temporary, bytes);
  renameSync(temporary, path);
  syncDirectory(directory);
  return hash(bytes);
}

// FLAG: Checkpoint continuity and exact generations fence this read-only walk.
// Immutable orphan pages never advance its cursor or establish complete coverage.
export function runOrderedAnchorInventory({
  request: rawRequest,
  directory,
  expectedCheckpoint = null,
  pageLimit = 10,
  durationMs = 30000,
  readPage,
  attest,
  statusOnly = false,
  now = Date.now,
  checkCapacity = () => {},
}) {
  const request = parseOrderedAnchorRequest(rawRequest);
  check(
    Number.isSafeInteger(pageLimit) &&
      pageLimit >= 1 &&
      pageLimit <= 50 &&
      Number.isSafeInteger(durationMs) &&
      durationMs > 0 &&
      durationMs <= 30000,
    'ordered_inventory_budget_refused',
  );
  directoryGuard(directory);
  const requestBytes = encode(request),
    requestHash = hash(requestBytes);
  immutable(join(directory, 'request.json'), requestBytes);
  const path = join(directory, 'checkpoint.json');
  const bytes = existsSync(path) ? readPrivateInventoryFile(path) : null;
  let checkpointHash = bytes ? hash(bytes) : null;
  check(
    statusOnly || checkpointHash === expectedCheckpoint,
    'ordered_inventory_checkpoint_changed',
  );
  let state = bytes
    ? JSON.parse(bytes)
    : {
        version: 2,
        requestHash,
        runtime: null,
        pages: [],
        after: null,
        complete: false,
        journalBytes: 0,
      };
  check(
    state.version === 2 &&
      state.requestHash === requestHash &&
      Array.isArray(state.pages) &&
      state.pages.length <= 10000,
  );
  const accumulator = createOrderedAnchorAccumulator(request);
  let totalBytes = 0,
    reconstructedAfter = null;
  for (const [index, entry] of state.pages.entries()) {
    check(
      entry.index === index &&
        /^[a-f0-9]{64}$/u.test(entry.digest) &&
        entry.file === `page-${String(index).padStart(6, '0')}-${entry.digest}.json`,
    );
    const savedBytes = readPrivateInventoryFile(join(directory, entry.file));
    check(hash(savedBytes) === entry.digest, 'ordered_inventory_artifact_changed');
    const saved = JSON.parse(savedBytes);
    check(saved.version === 2 && saved.requestHash === requestHash);
    accumulator.addPage(saved.page);
    reconstructedAfter = saved.page.nextCursor;
    totalBytes += savedBytes.length;
  }
  const initial = accumulator.report(),
    next = accumulator.nextRequest();
  check(
    initial.complete === state.complete &&
      totalBytes === state.journalBytes &&
      JSON.stringify(reconstructedAfter) === JSON.stringify(state.after) &&
      (next === null || JSON.stringify(next.after) === JSON.stringify(state.after)),
  );
  const result = (stopReason) => ({
    version: 2,
    operation: 'ordered_anchor_inventory',
    readOnly: true,
    inventoryId: request.inventoryId,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    cutoff: request.cutoff,
    checkpointSha256: checkpointHash,
    pagesCommitted: state.pages.length,
    journalBytes: state.journalBytes,
    observedAt: new Date(now()).toISOString(),
    stopReason,
    report: accumulator.report(),
    mutationAuthorized: false,
  });
  if (statusOnly) return result('status');
  const runtime = attest(request);
  if (state.runtime === null) state.runtime = runtime;
  check(
    JSON.stringify(runtime) === JSON.stringify(state.runtime),
    'ordered_inventory_runtime_changed',
  );
  const deadline = now() + durationMs;
  for (let count = 0; !state.complete && count < pageLimit && now() < deadline; count++) {
    checkCapacity();
    const parameters = accumulator.nextRequest();
    const { page: rawPage, plan } = readPage(parameters);
    const page = validateOrderedAnchorPage(rawPage, request);
    check(
      JSON.stringify(attest(request)) === JSON.stringify(runtime),
      'ordered_inventory_runtime_changed',
    );
    const savedBytes = encode({ version: 2, requestHash, page, plan });
    check(
      savedBytes.length <= 2 * 1024 * 1024 &&
        state.journalBytes + savedBytes.length <= 512 * 1024 * 1024,
      'ordered_inventory_storage_budget',
    );
    accumulator.addPage(page);
    const index = state.pages.length,
      digest = hash(savedBytes),
      file = `page-${String(index).padStart(6, '0')}-${digest}.json`;
    immutable(join(directory, file), savedBytes);
    state = {
      ...state,
      pages: [...state.pages, { index, file, digest }],
      after: page.nextCursor,
      complete: !page.hasMore,
      journalBytes: state.journalBytes + savedBytes.length,
    };
    checkpointHash = checkpoint(directory, state, checkpointHash);
  }
  return result(state.complete ? 'complete' : 'run_budget');
}

export function createOrderedAnchorPageReader({ request, ...options }) {
  const execute = createInventoryAuditExecutor(options);
  return (parameters) => {
    const sql = buildOrderedAnchorPageSql(parameters);
    const plan = validateOrderedAnchorPagePlan(
      execute(`EXPLAIN (FORMAT JSON) ${sql}`, 'explain'),
      parameters,
    );
    const page = validateOrderedAnchorPage(execute(sql, 'page'), request);
    check(
      JSON.stringify(page.after) === JSON.stringify(parameters.after),
      'ordered_inventory_cursor_changed',
    );
    return { page, plan };
  };
}

async function main() {
  const [mode, requestPath, expected, pageCount] = process.argv.slice(2);
  check(
    ['run', 'status'].includes(mode) &&
      resolve(requestPath ?? '') === requestPath &&
      (mode === 'status'
        ? process.argv.length === 4
        : process.argv.length === 6 &&
          /^(new|[a-f0-9]{64})$/u.test(expected) &&
          /^(?:[1-9]|[1-4][0-9]|50)$/u.test(pageCount)),
  );
  const request = parseOrderedAnchorRequest(
    JSON.parse(readPrivateInventoryFile(requestPath, 65536)),
  );
  const directory = `/var/lib/maxim-deploy/webhook-ordered-anchor-inventory-${request.inventoryId}`;
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  directoryGuard(directory);
  if (process.env.MAXIM_ORDERED_ANCHOR_INVENTORY_LOCKED !== request.inventoryId) {
    const lock = spawnSync(
      'flock',
      [
        '-n',
        join(directory, 'run.lock'),
        process.execPath,
        process.argv[1],
        ...process.argv.slice(2),
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, MAXIM_ORDERED_ANCHOR_INVENTORY_LOCKED: request.inventoryId },
      },
    );
    process.exitCode = lock.error ? 1 : (lock.status ?? 1);
    return;
  }
  const repositoryRoot = process.cwd();
  const result = runOrderedAnchorInventory({
    request,
    directory,
    expectedCheckpoint: expected === 'new' ? null : expected,
    pageLimit: mode === 'status' ? 1 : Number(pageCount),
    statusOnly: mode === 'status',
    attest: (value) => attestInventoryRuntime(value, repositoryRoot),
    readPage: createOrderedAnchorPageReader({
      request,
      repositoryRoot,
      temporaryDirectory: import.meta.dirname,
    }),
    checkCapacity: () => {
      const s = statfsSync(directory, { bigint: true });
      check(
        s.bavail * s.bsize >= 20n * 1024n ** 3n + 2n * 1024n ** 2n,
        'ordered_inventory_disk_reserve',
      );
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = /^(ordered_inventory|inventory)_[a-z_]{1,80}$/u.test(error?.message)
      ? error.message
      : 'ordered_inventory_refused';
    process.stdout.write(
      `${JSON.stringify({ version: 2, readOnly: true, complete: false, code, inspectCheckpoint: true, mutationAuthorized: false })}\n`,
    );
    process.exitCode = 1;
  });
}
