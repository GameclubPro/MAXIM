import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  createPrismaClient,
  type PrismaClient,
  type PrismaPoolConfig,
} from '../prisma/prisma-client';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  inspectLegacyRecoveryCandidate,
  installAndSealLegacyRecoveryBatch,
  legacySnapshotDigest,
  materializeLegacyHeldReceiptPage,
  readLegacyRecoveryInstallation,
  type LegacyRecoveryCandidate,
  type LegacyStopAttestation,
} from '../webhook/webhook-legacy-cold-install';
import {
  LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES,
  LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES,
  legacyRecoveryLiveDigest,
  parseLegacyRecoveryLiveRequest,
  type LegacyRecoveryLiveOutput,
  type LegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';

export const LEGACY_RECOVERY_INVENTORY_PATH = '/run/maxim-legacy-recovery/inventory.json';
export type LegacyRecoveryStoreOperation =
  | 'certificate_create'
  | 'install'
  | 'readback'
  | 'materialize';
export type LegacyRecoveryStoreRequest = Readonly<{
  version: 1;
  operation: LegacyRecoveryStoreOperation;
  certificateId: string;
  binding: LegacyRecoveryLiveRequest['binding'];
  selection: LegacyRecoveryLiveRequest['selection'];
  expected: Readonly<{
    inventorySha256: string;
    inventoryArtifactSha256: string;
    previewSha256: string;
  }>;
  page?: Readonly<{ chatId: string; pageSize: number }>;
}>;
export type LegacyRecoveryStoreOutput = Readonly<{
  version: 1;
  operation: LegacyRecoveryStoreOperation;
  certificateId: string;
  activationAuthorized: false;
  bindingSha256: string;
  inventorySha256: string;
  previewSha256: string;
  state: 'ABSENT' | 'UNSEALED' | 'INVALID' | 'SEALED' | 'MATERIALIZED';
  completeChats?: number;
  requiredChats?: number;
  page?: Readonly<{ complete: boolean; scanned: number; applied: number; blocked: boolean }>;
  cursor?: Readonly<{
    chatId: string;
    horizon: string;
    afterCreatedAt: string | null;
    afterId: string | null;
    scanned: number;
    complete: boolean;
  }>;
}>;
const hash = /^[0-9a-f]{64}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid offline store object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unknown offline store field');
}
function identity(value: unknown, max = 128): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= max &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
export function parseLegacyRecoveryStoreRequest(input: string): LegacyRecoveryStoreRequest {
  if (Buffer.byteLength(input) > LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES)
    throw new Error('Offline request budget exceeded');
  const request = object(JSON.parse(input));
  keys(request, [
    'version',
    'operation',
    'certificateId',
    'binding',
    'selection',
    'expected',
    'page',
  ]);
  if (
    request.version !== 1 ||
    !['certificate_create', 'install', 'readback', 'materialize'].includes(
      String(request.operation),
    ) ||
    typeof request.certificateId !== 'string' ||
    !uuid.test(request.certificateId)
  )
    throw new Error('Invalid offline store operation');
  const expected = object(request.expected);
  keys(expected, ['inventorySha256', 'inventoryArtifactSha256', 'previewSha256']);
  if (
    ['inventorySha256', 'inventoryArtifactSha256', 'previewSha256'].some(
      (key) => typeof expected[key] !== 'string' || !hash.test(expected[key] as string),
    )
  )
    throw new Error('Invalid reviewed store binding');
  const live = parseLegacyRecoveryLiveRequest(
    JSON.stringify({
      version: 1,
      operation: 'inventory_preview',
      binding: request.binding,
      selection: request.selection,
      expectedInventorySha256: expected.inventorySha256,
    }),
  );
  let page: LegacyRecoveryStoreRequest['page'];
  if (request.operation === 'materialize') {
    const row = object(request.page);
    keys(row, ['chatId', 'pageSize']);
    if (
      !identity(row.chatId) ||
      !Number.isInteger(row.pageSize) ||
      Number(row.pageSize) < 1 ||
      Number(row.pageSize) > 200
    )
      throw new Error('Invalid bounded materialization page');
    page = { chatId: row.chatId, pageSize: Number(row.pageSize) };
  } else if (request.page !== undefined) throw new Error('Unexpected materialization page');
  return Object.freeze({
    version: 1,
    operation: request.operation as LegacyRecoveryStoreOperation,
    certificateId: request.certificateId,
    binding: live.binding,
    selection: live.selection,
    expected: Object.freeze(expected) as LegacyRecoveryStoreRequest['expected'],
    ...(page ? { page: Object.freeze(page) } : {}),
  });
}

// FLAG: The host mounts the reviewed artifact read-only at a fixed path. A small stdin
// carries only immutable bindings; child inventory never comes from an arbitrary path.
export async function readLegacyRecoveryInventoryFile(
  path = LEGACY_RECOVERY_INVENTORY_PATH,
): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES)
      throw new Error('Invalid bounded inventory artifact');
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const result = await file.read(buffer, read, buffer.length - read, null);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read !== stat.size) throw new Error('Inventory artifact changed during read');
    return buffer.subarray(0, read);
  } finally {
    await file.close();
  }
}
export function verifyLegacyRecoveryInventory(
  request: LegacyRecoveryStoreRequest,
  bytes: Buffer,
): LegacyRecoveryLiveOutput {
  if (
    bytes.length > LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== request.expected.inventoryArtifactSha256
  )
    throw new Error('Inventory artifact binding mismatch');
  const output = object(JSON.parse(bytes.toString('utf8')));
  keys(output, [
    'version',
    'operation',
    'applied',
    'activationAuthorized',
    'decision',
    'binding',
    'selectionSha256',
    'registrySha256',
    'inventorySha256',
    'selectedOwners',
    'children',
    'sqlPlans',
    'issues',
    'cost',
  ]);
  if (
    output.version !== 1 ||
    output.operation !== 'inventory_preview' ||
    output.applied !== false ||
    output.activationAuthorized !== false ||
    output.decision !== 'READY_TO_INSTALL' ||
    output.inventorySha256 !== request.expected.inventorySha256 ||
    output.selectionSha256 !== legacyRecoveryLiveDigest(request.selection) ||
    legacyRecoveryLiveDigest(output.binding) !== legacyRecoveryLiveDigest(request.binding) ||
    typeof output.registrySha256 !== 'string' ||
    !hash.test(output.registrySha256) ||
    !Array.isArray(output.issues) ||
    output.issues.length !== 0 ||
    !Array.isArray(output.selectedOwners) ||
    output.selectedOwners.length !== request.selection.ownerWebhookEventIds.length ||
    !Array.isArray(output.children) ||
    output.children.length > 10_000
  )
    throw new Error('Inventory does not authorize this finite store operation');
  const ownerIds = new Set<string>();
  for (const value of output.selectedOwners) {
    const owner = object(value);
    keys(owner, [
      'ownerWebhookEventId',
      'semanticKey',
      'claimId',
      'chatId',
      'messageId',
      'userId',
      'sourceAt',
      'rawPayloadSha256',
      'normalizedPayloadSha256',
      'ownerSnapshotSha256',
      'claimSnapshotSha256',
    ]);
    for (const field of [
      'ownerWebhookEventId',
      'semanticKey',
      'claimId',
      'chatId',
      'messageId',
      'userId',
    ])
      if (!identity(owner[field], 1024)) throw new Error('Invalid reviewed owner');
    for (const field of [
      'rawPayloadSha256',
      'normalizedPayloadSha256',
      'ownerSnapshotSha256',
      'claimSnapshotSha256',
    ])
      if (typeof owner[field] !== 'string' || !hash.test(owner[field] as string))
        throw new Error('Invalid reviewed source digest');
    if (
      typeof owner.sourceAt !== 'string' ||
      !Number.isFinite(Date.parse(owner.sourceAt)) ||
      !request.selection.ownerWebhookEventIds.includes(owner.ownerWebhookEventId as string) ||
      ownerIds.has(owner.ownerWebhookEventId as string)
    )
      throw new Error('Ambiguous reviewed owners');
    ownerIds.add(owner.ownerWebhookEventId as string);
  }
  const childIds = new Set<string>();
  for (const value of output.children) {
    const child = object(value);
    keys(child, ['jobKey', 'queueName', 'jobPayloadDigest', 'chatId', 'messageId', 'userId']);
    for (const field of ['jobKey', 'queueName', 'chatId'])
      if (!identity(child[field], 1024)) throw new Error('Invalid reviewed child');
    for (const field of ['messageId', 'userId'])
      if (child[field] !== undefined && !identity(child[field], 1024))
        throw new Error('Invalid reviewed child source');
    if (
      typeof child.jobPayloadDigest !== 'string' ||
      !hash.test(child.jobPayloadDigest) ||
      childIds.has(child.jobKey as string)
    )
      throw new Error('Ambiguous reviewed children');
    childIds.add(child.jobKey as string);
  }
  return output as unknown as LegacyRecoveryLiveOutput;
}

function attestationFor(request: LegacyRecoveryStoreRequest): LegacyStopAttestation {
  const roles = new Set<string>(RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'));
  return {
    version: 1,
    sourceSha: request.binding.sourceSha,
    imageId: request.binding.imageId,
    transitionJournalSha256: request.binding.transitionJournalSha256,
    previewSha256: request.expected.previewSha256,
    queueFenceNonce: request.binding.queueFenceNonce,
    roleSnapshots: request.binding.stoppedGenerations
      .filter((row) => roles.has(row.serviceName))
      .map((row) => ({ ...row })),
    ...{
      maintenanceId: request.binding.maintenanceId,
      offlineBindingSha256: legacyRecoveryLiveDigest(request.binding),
      inventorySha256: request.expected.inventorySha256,
      inventoryArtifactSha256: request.expected.inventoryArtifactSha256,
      selectionSha256: legacyRecoveryLiveDigest(request.selection),
    },
  };
}
async function freshCandidates(
  prisma: PrismaClient,
  request: LegacyRecoveryStoreRequest,
  inventory: LegacyRecoveryLiveOutput,
): Promise<LegacyRecoveryCandidate[]> {
  const candidates: LegacyRecoveryCandidate[] = [];
  for (const id of request.selection.ownerWebhookEventIds) {
    const candidate = await inspectLegacyRecoveryCandidate(
      prisma,
      id,
      request.selection.majorBotIds,
    );
    if (!candidate) throw new Error('Reviewed owner source is no longer eligible');
    const proof = inventory.selectedOwners.find((owner) => owner.ownerWebhookEventId === id);
    const current = {
      ownerWebhookEventId: candidate.owner.id,
      semanticKey: candidate.owner.semanticKey,
      claimId: candidate.claim.id,
      ...candidate.source,
      sourceAt: candidate.source.sourceAt.toISOString(),
      rawPayloadSha256: candidate.rawPayloadDigest,
      normalizedPayloadSha256: candidate.normalizedPayloadDigest,
      ownerSnapshotSha256: legacySnapshotDigest(candidate.owner),
      claimSnapshotSha256: legacySnapshotDigest(candidate.claim),
    };
    if (legacyRecoveryLiveDigest(proof) !== legacyRecoveryLiveDigest(current))
      throw new Error('Reviewed owner evidence changed');
    candidates.push(candidate);
  }
  if (
    buildLegacyRecoveryPreviewDigest(candidates, inventory.children) !==
    request.expected.previewSha256
  )
    throw new Error('Reviewed installation preview changed');
  return candidates;
}

// FLAG: One caller-owned stopped generation and one operation only. This function
// neither retries unknown writes nor admits/restarts any runtime or MAX worker.
export async function executeLegacyRecoveryStore(
  prisma: PrismaClient,
  request: LegacyRecoveryStoreRequest,
  inventoryBytes: Buffer,
): Promise<LegacyRecoveryStoreOutput> {
  const inventory = verifyLegacyRecoveryInventory(request, inventoryBytes);
  const attestation = attestationFor(request);
  const base = {
    version: 1 as const,
    operation: request.operation,
    certificateId: request.certificateId,
    activationAuthorized: false as const,
    bindingSha256: legacyRecoveryLiveDigest(request.binding),
    inventorySha256: request.expected.inventorySha256,
    previewSha256: request.expected.previewSha256,
  };
  if (request.operation === 'certificate_create') {
    await freshCandidates(prisma, request, inventory);
    await createLegacyColdCertificate(prisma, attestation, request.certificateId);
    return { ...base, state: 'UNSEALED' };
  }
  const certificate = await prisma.webhookLegacyQuiescenceCertificate.findUnique({
    where: { id: request.certificateId },
  });
  if (!certificate) {
    if (request.operation === 'readback')
      return { ...base, state: 'ABSENT', completeChats: 0, requiredChats: 0 };
    throw new Error('Exact certificate is absent');
  }
  if (
    certificate.attestationDigest !== legacySnapshotDigest(attestation) ||
    legacySnapshotDigest(certificate.attestation) !== legacySnapshotDigest(attestation)
  )
    throw new Error('Certificate does not match the reviewed host binding');
  const expected = {
    sourceSha: request.binding.sourceSha,
    imageId: request.binding.imageId,
    previewSha256: request.expected.previewSha256,
    recoveries: inventory.selectedOwners.length,
    children: inventory.children.length,
  };
  if (request.operation === 'install') {
    if (certificate.sealedAt) throw new Error('Install cannot retry a sealed certificate');
    const candidates = await freshCandidates(prisma, request, inventory);
    await installAndSealLegacyRecoveryBatch(
      prisma,
      request.certificateId,
      candidates,
      inventory.children,
    );
    return {
      ...base,
      ...(await readLegacyRecoveryInstallation(prisma, request.certificateId, expected)),
    };
  }
  const readback = await readLegacyRecoveryInstallation(prisma, request.certificateId, expected);
  if (request.operation === 'readback') return { ...base, ...readback };
  if (
    !['SEALED', 'MATERIALIZED'].includes(readback.state) ||
    !request.page ||
    !inventory.selectedOwners.some((owner) => owner.chatId === request.page!.chatId)
  )
    throw new Error('Materialization lacks exact sealed reviewed scope');
  const page = await materializeLegacyHeldReceiptPage(
    prisma,
    request.certificateId,
    request.page.chatId,
    request.page.pageSize,
  );
  const cursor = await prisma.webhookLegacyMaterializationCursor.findUniqueOrThrow({
    where: {
      certificateId_chatId: { certificateId: request.certificateId, chatId: request.page.chatId },
    },
  });
  return {
    ...base,
    state: 'SEALED',
    page,
    cursor: {
      chatId: cursor.chatId,
      horizon: cursor.horizon.toISOString(),
      afterCreatedAt: cursor.afterCreatedAt?.toISOString() ?? null,
      afterId: cursor.afterId,
      scanned: cursor.scanned,
      complete: cursor.complete,
    },
  };
}

export function legacyRecoveryStorePoolConfig(readonly: boolean): PrismaPoolConfig {
  return {
    application_name: 'maxim-legacy-recovery-store-v1',
    max: 1,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 1000,
    statement_timeout: 5000,
    options: `-c timezone=UTC -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000 -c default_transaction_read_only=${readonly ? 'on' : 'off'}`,
  };
}
export function assertLegacyRecoveryStoreEnvironment(
  request: LegacyRecoveryStoreRequest,
  env: NodeJS.ProcessEnv,
): void {
  if (
    env.MAXIM_LEGACY_RECOVERY_OFFLINE !== '1' ||
    env.MAXIM_LEGACY_RECOVERY_STORE_PROTOCOL !== 'host-offline-v1' ||
    env.MAXIM_LEGACY_RECOVERY_STORE_MODE !==
      (request.operation === 'readback' ? 'readback' : 'writer') ||
    env.APP_SERVICE_NAME !== 'legacy-recovery-store' ||
    env.APP_SOURCE_SHA !== request.binding.sourceSha ||
    env.MAXIM_LEGACY_RECOVERY_IMAGE_ID !== request.binding.imageId ||
    env.TZ !== 'UTC'
  )
    throw new Error('Offline host store protocol is required');
}
export async function readLegacyRecoveryStoreStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES)
      throw new Error('Offline request budget exceeded');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function writeOutput(value: unknown): void {
  const output = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(output) > LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES)
    throw new Error('Offline output budget exceeded');
  process.stdout.write(output);
}
async function main(): Promise<void> {
  let prisma: PrismaClient | undefined;
  // FLAG: Any timeout or failed response is unknown to the host; it must remove this
  // exact client and run a separate read-only reconciliation before considering restart.
  const watchdog = setTimeout(() => {
    process.stderr.write('Offline store operation timed out; exact readback required.\n');
    process.exit(1);
  }, 45_000);
  try {
    if (process.argv.length !== 2) throw new Error('Only bounded stdin is accepted');
    const request = parseLegacyRecoveryStoreRequest(
      await readLegacyRecoveryStoreStdin(process.stdin),
    );
    assertLegacyRecoveryStoreEnvironment(request, process.env);
    const inventory = await readLegacyRecoveryInventoryFile();
    verifyLegacyRecoveryInventory(request, inventory);
    prisma = createPrismaClient(
      process.env.DATABASE_URL,
      legacyRecoveryStorePoolConfig(request.operation === 'readback'),
    );
    const [identity] = await prisma.$queryRaw<
      Array<{ timezone: string; readonly: string }>
    >`SELECT current_setting('TimeZone') AS timezone, current_setting('transaction_read_only') AS readonly`;
    if (
      identity?.timezone !== 'UTC' ||
      identity.readonly !== (request.operation === 'readback' ? 'on' : 'off')
    )
      throw new Error('Store session identity mismatch');
    writeOutput(await executeLegacyRecoveryStore(prisma, request, inventory));
  } catch {
    writeOutput({
      version: 1,
      outcome: 'DENY_OR_UNKNOWN',
      activationAuthorized: false,
      code: 'store_operation_unproved',
    });
    process.exitCode = 1;
  } finally {
    try {
      await prisma?.$disconnect();
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(watchdog);
    }
  }
}
if (require.main === module) void main();
