import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INVENTORY_STATUS_LANES,
  createInventoryAccumulator,
  parseInventoryRequest,
  validateInventoryPage,
} from './webhook-order-blocker-inventory.mjs';
import {
  buildOrderBlockerPageSql,
  validateOrderBlockerPagePlan,
  buildOrderBlockerDiagnosticSql,
  validateOrderBlockerDiagnosticPlan,
} from './webhook-order-blocker-inventory-sql.mjs';
import { ownerProofIndexesSql, emitOwnerProofPrivilegesSql } from './webhook-owner-proof-audit.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const requireFact = (fact, code) => {
  if (!fact) throw new Error(code);
};
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 512 * 1024 * 1024;
const DOCKER_RESERVE = 20n * 1024n ** 3n;
const PAGE_SIZE = 200;

function privateDirectory(path) {
  const stat = lstatSync(path);
  requireFact(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700,
    'inventory_directory_refused',
  );
}

export function readPrivateInventoryFile(path, cap = MAX_FILE_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireFact(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= cap,
      'inventory_file_refused',
    );
    const bytes = readFileSync(fd);
    requireFact(bytes.length === stat.size, 'inventory_file_changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function saveExclusive(path, bytes) {
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

function replaceCheckpoint(directory, value, expectedDigest) {
  const path = join(directory, 'checkpoint.json');
  const current = existsSync(path) ? digest(readPrivateInventoryFile(path)) : null;
  requireFact(current === expectedDigest, 'inventory_checkpoint_changed');
  const bytes = encode(value);
  const temporary = join(directory, `checkpoint-${randomUUID()}.tmp`);
  saveExclusive(temporary, bytes);
  renameSync(temporary, path);
  syncDirectory(directory);
  return digest(bytes);
}

// FLAG: Preserve the stock audit role, server/wall deadlines, shared audit lock and
// exact-backend cleanup. Only the fixed queue report body is replaced by reviewed SQL.
export function renderInventoryAuditWrapper(stock, sql) {
  const start = 'emit_queue_audit() {\n';
  const end = 'emit_legacy_order_index_guard() {\n';
  requireFact(
    stock.split(start).length === 2 &&
      stock.split(end).length === 2 &&
      !sql.includes('MAXIM_ORDER_INVENTORY_SQL') &&
      sql.length <= 128 * 1024,
    'inventory_audit_template_refused',
  );
  const from = stock.indexOf(start),
    to = stock.indexOf(end);
  requireFact(from < to, 'inventory_audit_template_refused');
  const guard = `${ownerProofIndexesSql.replace(/;$/u, '')}\n\\gset\n\\if :owner_proof_indexes_ready\n\\else\n\\echo WEBHOOK_OWNER_PROOF_INDEXES_INVALID\nSELECT 1 / 0;\n\\endif\n`;
  return `${stock.slice(0, from)}${start}  cat <<'MAXIM_ORDER_INVENTORY_SQL'\nSET LOCAL timezone = 'UTC';\n${emitOwnerProofPrivilegesSql(true)}\\echo inventory_privileges_complete\n${guard}\\echo inventory_indexes_complete\n${sql}\nMAXIM_ORDER_INVENTORY_SQL\n}\n\n${stock.slice(to)}`;
}

export function inventoryAuditResult(result, phase) {
  const lines = String(result.stdout ?? '').split(/\r?\n/u);
  const index = lines.indexOf('inventory_indexes_complete');
  const stage =
    index >= 0 ? phase : lines.includes('inventory_privileges_complete') ? 'indexes' : 'privileges';
  if (result.error || result.status !== 0) throw new Error(`${auditFailure(result)}_${stage}`);
  requireFact(
    index === 1 && lines[0] === 'inventory_privileges_complete',
    'inventory_audit_markers_refused',
  );
  try {
    return JSON.parse(lines.slice(2).join('\n'));
  } catch {
    throw new Error('inventory_audit_json_refused');
  }
}

function auditFailure(result) {
  if (result.status === 75) return 'inventory_audit_busy';
  if (result.status === 124 || result.error?.code === 'ETIMEDOUT') return 'inventory_audit_timeout';
  if (result.error?.code === 'ENOBUFS') return 'inventory_audit_output_limit';
  if (
    String(result.stderr)
      .split(/\r?\n/u)
      .includes('ERROR:  canceling statement due to statement timeout')
  )
    return 'inventory_statement_timeout';
  return 'inventory_audit_refused';
}

export function createInventoryAuditExecutor({
  repositoryRoot,
  temporaryDirectory,
  run = spawnSync,
}) {
  const stock = readFileSync(join(repositoryRoot, 'infra/scripts/vps-postgres-audit.sh'), 'utf8');
  const execute = (sql, phase) => {
    // Both infra/scripts and a reviewed infra/.inventory.* transport bundle are two
    // levels below the repository, as required by the unchanged stock wrapper.
    const file = join(temporaryDirectory, `inventory-audit-${randomUUID()}.sh`);
    saveExclusive(file, Buffer.from(renderInventoryAuditWrapper(stock, sql)));
    try {
      const result = run('bash', [file, 'queue'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 14_000,
        maxBuffer: MAX_FILE_BYTES,
      });
      return inventoryAuditResult(result, phase);
    } finally {
      rmSync(file, { force: true });
    }
  };
  return execute;
}

export function createInventoryPageReader({ request, diagnosticPhase = null, ...options }) {
  const execute = createInventoryAuditExecutor(options);
  return (parameters) => {
    if (diagnosticPhase !== null) {
      const sql = buildOrderBlockerDiagnosticSql(parameters, diagnosticPhase);
      const plan = validateOrderBlockerDiagnosticPlan(
        execute(`EXPLAIN (FORMAT JSON) ${sql}`, 'explain'),
        parameters,
        diagnosticPhase,
      );
      const started = Date.now();
      const result = execute(sql, diagnosticPhase);
      requireFact(
        result?.version === 1 &&
          result.kind === 'order_blocker_phase_diagnostic' &&
          result.readOnly === true &&
          result.phase === diagnosticPhase &&
          result.status === parameters.status &&
          result.cutoff === parameters.cutoff &&
          result.coverage === 'DIAGNOSTIC_ONLY' &&
          result.mutationAuthorized === false &&
          result.inventoryAdvanceAuthorized === false &&
          Number.isSafeInteger(result.rawCount) &&
          result.rawCount >= 0 &&
          result.rawCount <= 201 &&
          result.hasMore === (result.rawCount === 201) &&
          Array.isArray(result.rows) &&
          result.rowCount === result.rows.length &&
          result.rowCount <= (diagnosticPhase === 'raw_index' ? 201 : 200),
        'inventory_diagnostic_refused',
      );
      return {
        version: 1,
        kind: result.kind,
        readOnly: true,
        phase: diagnosticPhase,
        status: result.status,
        cutoff: result.cutoff,
        rawCount: result.rawCount,
        rowCount: result.rowCount,
        hasMore: result.hasMore,
        elapsedMs: Date.now() - started,
        plan,
        mutationAuthorized: false,
        inventoryAdvanceAuthorized: false,
      };
    }
    const sql = buildOrderBlockerPageSql(parameters);
    const plan = validateOrderBlockerPagePlan(
      execute(`EXPLAIN (FORMAT JSON) ${sql}`, 'explain'),
      parameters,
    );
    const page = validateInventoryPage(execute(sql, 'page'), request);
    requireFact(
      page.status === parameters.status &&
        JSON.stringify(page.after) === JSON.stringify(parameters.after),
      'inventory_page_changed',
    );
    return { page, plan };
  };
}

function command(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: MAX_FILE_BYTES,
  });
  requireFact(!result.error && result.status === 0, 'inventory_runtime_probe_refused');
  return result.stdout.trim();
}

export function attestInventoryRuntime(request, repositoryRoot, execute = command) {
  requireFact(
    execute('git', ['rev-parse', 'HEAD'], repositoryRoot) === request.sourceSha &&
      execute('git', ['status', '--porcelain', '--untracked-files=no'], repositoryRoot) === '',
    'inventory_source_changed',
  );
  const id = execute(
    'docker',
    [
      '--context',
      'default',
      'ps',
      '--no-trunc',
      '--filter',
      'label=com.docker.compose.project=infra',
      '--filter',
      'label=com.docker.compose.service=api-admin',
      '--filter',
      'status=running',
      '--format',
      '{{.ID}}',
    ],
    repositoryRoot,
  );
  requireFact(/^[a-f0-9]{64}$/u.test(id), 'inventory_runtime_probe_refused');
  const format =
    '{"id":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"sourceSha":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}';
  const value = JSON.parse(
    execute('docker', ['--context', 'default', 'inspect', '--format', format, id], repositoryRoot),
  );
  requireFact(
    value.id === id &&
      value.imageId === request.imageId &&
      value.running === true &&
      value.sourceSha === request.sourceSha &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      Number.isSafeInteger(value.restarts) &&
      value.restarts >= 0,
    'inventory_runtime_probe_refused',
  );
  return value;
}

function assertCheckpoint(checkpoint, requestHash) {
  requireFact(
    checkpoint?.version === 1 &&
      checkpoint.requestHash === requestHash &&
      Array.isArray(checkpoint.pages) &&
      checkpoint.pages.length <= 10_000 &&
      Number.isSafeInteger(checkpoint.nextLane) &&
      checkpoint.nextLane >= 0 &&
      checkpoint.nextLane <= INVENTORY_STATUS_LANES.length &&
      Number.isSafeInteger(checkpoint.journalBytes) &&
      checkpoint.journalBytes >= 0,
    'inventory_checkpoint_refused',
  );
  for (const [index, page] of checkpoint.pages.entries()) {
    requireFact(
      page.index === index &&
        /^[a-f0-9]{64}$/u.test(page.digest) &&
        page.file === `page-${String(index).padStart(6, '0')}-${page.digest}.json`,
      'inventory_checkpoint_refused',
    );
  }
}

// FLAG: This is a read-only online preview. A complete cursor walk does not freeze
// status changes and never authorizes cancellation; the stopped pass remains required.
export function runInventoryBatch({
  request: rawRequest,
  directory,
  expectedCheckpoint = null,
  pageLimit = 10,
  durationMs = 30_000,
  readPage,
  attest,
  now = Date.now,
  checkCapacity = () => {},
  statusOnly = false,
  onProgress = () => {},
}) {
  const request = parseInventoryRequest(rawRequest);
  requireFact(
    Number.isSafeInteger(pageLimit) &&
      pageLimit >= 1 &&
      pageLimit <= 50 &&
      Number.isSafeInteger(durationMs) &&
      durationMs >= 1 &&
      durationMs <= 30_000,
    'inventory_run_budget_refused',
  );
  privateDirectory(directory);
  const requestBytes = encode(request),
    requestHash = digest(requestBytes);
  const requestPath = join(directory, 'request.json');
  if (!existsSync(requestPath)) saveExclusive(requestPath, requestBytes);
  requireFact(
    readPrivateInventoryFile(requestPath).equals(requestBytes),
    'inventory_request_changed',
  );
  const checkpointPath = join(directory, 'checkpoint.json');
  const checkpointBytes = existsSync(checkpointPath)
    ? readPrivateInventoryFile(checkpointPath)
    : null;
  let checkpointHash = checkpointBytes ? digest(checkpointBytes) : null;
  requireFact(statusOnly || checkpointHash === expectedCheckpoint, 'inventory_checkpoint_changed');
  let checkpoint = checkpointBytes
    ? JSON.parse(checkpointBytes)
    : {
        version: 1,
        requestHash,
        runtime: null,
        pages: [],
        nextLane: 0,
        after: null,
        journalBytes: 0,
      };
  assertCheckpoint(checkpoint, requestHash);
  const accumulator = createInventoryAccumulator(request);
  let reconstructedLane = 0,
    reconstructedAfter = null,
    reconstructedBytes = 0;
  for (const entry of checkpoint.pages) {
    const bytes = readPrivateInventoryFile(join(directory, entry.file));
    requireFact(digest(bytes) === entry.digest, 'inventory_page_changed');
    const saved = JSON.parse(bytes);
    requireFact(saved.version === 1 && saved.requestHash === requestHash, 'inventory_page_changed');
    const parameters = {
      status: INVENTORY_STATUS_LANES[reconstructedLane],
      cutoff: request.cutoff,
      pageSize: PAGE_SIZE,
      after: reconstructedAfter,
    };
    const page = validateInventoryPage(saved.page, request);
    requireFact(
      page.status === parameters.status &&
        JSON.stringify(page.after) === JSON.stringify(parameters.after),
      'inventory_page_changed',
    );
    accumulator.addPage(page);
    reconstructedBytes += bytes.length;
    reconstructedAfter = page.hasMore ? page.nextCursor : null;
    if (!page.hasMore) reconstructedLane++;
  }
  requireFact(
    reconstructedLane === checkpoint.nextLane &&
      JSON.stringify(reconstructedAfter) === JSON.stringify(checkpoint.after) &&
      reconstructedBytes === checkpoint.journalBytes,
    'inventory_checkpoint_refused',
  );
  const publicResult = (reason) => ({
    version: 1,
    operation: 'webhook_order_blocker_inventory',
    readOnly: true,
    inventoryId: request.inventoryId,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    cutoff: request.cutoff,
    observedAt: new Date(now()).toISOString(),
    checkpointSha256: checkpointHash,
    pagesCommitted: checkpoint.pages.length,
    scannedThrough: checkpoint.after?.createdAt ?? null,
    nextStatus: INVENTORY_STATUS_LANES[checkpoint.nextLane] ?? null,
    journalBytes: checkpoint.journalBytes,
    stopReason: reason,
    report: accumulator.report(),
    mutationAuthorized: false,
  });
  if (statusOnly) return publicResult('status');
  const runtime = attest(request);
  if (checkpoint.runtime === null) checkpoint.runtime = runtime;
  requireFact(
    JSON.stringify(runtime) === JSON.stringify(checkpoint.runtime),
    'inventory_runtime_changed',
  );
  const deadline = now() + durationMs;
  let completed = 0;
  while (
    checkpoint.nextLane < INVENTORY_STATUS_LANES.length &&
    completed < pageLimit &&
    now() < deadline
  ) {
    checkCapacity();
    requireFact(checkpoint.journalBytes < MAX_JOURNAL_BYTES, 'inventory_storage_budget');
    const parameters = {
      status: INVENTORY_STATUS_LANES[checkpoint.nextLane],
      cutoff: request.cutoff,
      pageSize: PAGE_SIZE,
      after: checkpoint.after,
    };
    const { page: rawPage, plan } = readPage(parameters);
    const page = validateInventoryPage(rawPage, request);
    requireFact(
      page.status === parameters.status &&
        JSON.stringify(page.after) === JSON.stringify(parameters.after),
      'inventory_page_changed',
    );
    requireFact(
      JSON.stringify(attest(request)) === JSON.stringify(runtime),
      'inventory_runtime_changed',
    );
    const bytes = encode({ version: 1, requestHash, page, plan });
    requireFact(
      bytes.length <= MAX_FILE_BYTES && checkpoint.journalBytes + bytes.length <= MAX_JOURNAL_BYTES,
      'inventory_storage_budget',
    );
    accumulator.addPage(page);
    const index = checkpoint.pages.length,
      pageDigest = digest(bytes);
    const file = `page-${String(index).padStart(6, '0')}-${pageDigest}.json`;
    // An unreferenced immutable page after interruption is harmless. Its bytes may
    // be reused only when equal; the durable checkpoint alone advances the cursor.
    const pagePath = join(directory, file);
    if (existsSync(pagePath))
      requireFact(readPrivateInventoryFile(pagePath).equals(bytes), 'inventory_page_changed');
    else saveExclusive(pagePath, bytes);
    checkpoint = {
      ...checkpoint,
      pages: [...checkpoint.pages, { index, file, digest: pageDigest }],
      after: page.hasMore ? page.nextCursor : null,
      nextLane: checkpoint.nextLane + (page.hasMore ? 0 : 1),
      journalBytes: checkpoint.journalBytes + bytes.length,
    };
    checkpointHash = replaceCheckpoint(directory, checkpoint, checkpointHash);
    completed++;
    onProgress({
      pagesCommitted: checkpoint.pages.length,
      nextStatus: INVENTORY_STATUS_LANES[checkpoint.nextLane] ?? null,
    });
  }
  return publicResult(
    checkpoint.nextLane === INVENTORY_STATUS_LANES.length ? 'complete' : 'run_budget',
  );
}

async function main() {
  const [mode, requestPath, expected, pageCount] = process.argv.slice(2);
  requireFact(
    ['run', 'status', 'diagnose'].includes(mode) &&
      requestPath &&
      resolve(requestPath) === requestPath &&
      (mode === 'status'
        ? process.argv.length === 4
        : process.argv.length === 6 &&
          /^(new|[a-f0-9]{64})$/u.test(expected) &&
          (mode === 'diagnose'
            ? ['raw_index', 'metadata'].includes(pageCount)
            : /^(?:[1-9]|[1-4][0-9]|50)$/u.test(pageCount))),
    'inventory_arguments_refused',
  );
  const request = parseInventoryRequest(JSON.parse(readPrivateInventoryFile(requestPath, 65536)));
  const directory = `/var/lib/maxim-deploy/webhook-blocker-inventory-${request.inventoryId}`;
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  privateDirectory(directory);
  // The persistent flock serializes each complete preview run, including its page
  // journal. It is separate from the per-query stock PostgreSQL audit lock.
  if (process.env.MAXIM_ORDER_INVENTORY_LOCKED !== request.inventoryId) {
    const result = spawnSync(
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
        env: { ...process.env, MAXIM_ORDER_INVENTORY_LOCKED: request.inventoryId },
      },
    );
    process.exitCode = result.error ? 1 : (result.status ?? 1);
    return;
  }
  const repositoryRoot = process.cwd();
  const result = runInventoryBatch({
    request,
    directory,
    expectedCheckpoint: expected === 'new' ? null : expected,
    pageLimit: mode !== 'run' ? 1 : Number(pageCount),
    statusOnly: mode !== 'run',
    readPage: createInventoryPageReader({
      request,
      repositoryRoot,
      temporaryDirectory: import.meta.dirname,
    }),
    attest: (value) => attestInventoryRuntime(value, repositoryRoot),
    checkCapacity: () => {
      const stat = statfsSync(directory, { bigint: true });
      requireFact(
        stat.bavail * stat.bsize >= DOCKER_RESERVE + BigInt(MAX_FILE_BYTES),
        'inventory_disk_reserve',
      );
    },
  });
  if (mode === 'diagnose') {
    requireFact(
      result.checkpointSha256 === expected && result.nextStatus !== null,
      'inventory_checkpoint_changed',
    );
    const checkpoint = JSON.parse(readPrivateInventoryFile(join(directory, 'checkpoint.json')));
    const runtime = attestInventoryRuntime(request, repositoryRoot);
    requireFact(
      JSON.stringify(runtime) === JSON.stringify(checkpoint.runtime),
      'inventory_runtime_changed',
    );
    const diagnostic = createInventoryPageReader({
      request,
      repositoryRoot,
      temporaryDirectory: import.meta.dirname,
      diagnosticPhase: pageCount,
    })({
      status: result.nextStatus,
      cutoff: request.cutoff,
      pageSize: 200,
      after: checkpoint.after,
    });
    requireFact(
      JSON.stringify(attestInventoryRuntime(request, repositoryRoot)) === JSON.stringify(runtime),
      'inventory_runtime_changed',
    );
    process.stdout.write(
      `${JSON.stringify({ ...diagnostic, checkpointSha256: result.checkpointSha256 })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code =
      typeof error?.message === 'string' && /^inventory_[a-z_]{1,80}$/u.test(error.message)
        ? error.message
        : 'inventory_refused';
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        readOnly: true,
        complete: false,
        code,
        inspectCheckpoint: true,
        mutationAuthorized: false,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
