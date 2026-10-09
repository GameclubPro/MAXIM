import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  createPrismaClient,
  type PrismaClient,
  type PrismaPoolConfig,
} from '../prisma/prisma-client';
import {
  materializeSourceAbandonmentReceipt,
  sourceAbandonmentOwnerSnapshot,
  sourceAbandonmentReceiptSourceDigest,
} from '../webhook/webhook-source-abandonment';
import {
  SOURCE_ABANDONMENT_OPERATION,
  SOURCE_ABANDONMENT_CHANNEL_PROFILE,
  SOURCE_ABANDONMENT_HUMAN_PROFILE,
} from '../webhook/webhook-source-abandonment.contract';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  readLegacyRecoveryInventoryFile,
  type LegacyRecoveryStoreOutput,
} from './legacy-recovery-store';
import { readSourceAbandonmentStdin } from './source-abandonment-collect';
import {
  SOURCE_ABANDONMENT_OUTPUT_MAX_BYTES,
  SOURCE_ABANDONMENT_REQUEST_MAX_BYTES,
  SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
  SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
  sourceAbandonmentRecord,
  assertSourceAbandonmentKeys,
  isSourceAbandonmentIdentity,
  parseSourceAbandonmentLiveRequest,
  sourceAbandonmentDigest,
  sourceAbandonmentChildInputs,
  buildSourceAbandonmentPreviewDigest,
  buildSourceAbandonmentInventoryDigest,
  type SourceAbandonmentLiveOutput,
  type SourceAbandonmentLiveRequest,
} from './source-abandonment-live-protocol';
import { sourceAbandonmentSourceClosureDigest } from './source-abandonment-source-closure';
import { assertSourceAbandonmentCatalogProofs } from './source-abandonment-redis-catalog';
import {
  inventorySourceAbandonmentSql,
  SourceInventorySqlMeter,
  readSourceAbandonmentFamily,
  inventorySourceAbandonmentChildSql,
} from './source-abandonment-live-sql';

export type SourceAbandonmentStoreRequest = Readonly<{
  version: 1;
  operation: 'certificate_create' | 'install' | 'readback' | 'materialize';
  certificateId: string;
  binding: SourceAbandonmentLiveRequest['binding'];
  selection: SourceAbandonmentLiveRequest['selection'];
  expected: Readonly<{
    inventorySha256: string;
    inventoryArtifactSha256: string;
    previewSha256: string;
  }>;
  page?: Readonly<{ chatId: string; pageSize: number }>;
}>;
const sha = /^[0-9a-f]{64}$/u;
export function parseSourceAbandonmentStoreRequest(text: string): SourceAbandonmentStoreRequest {
  if (Buffer.byteLength(text) > SOURCE_ABANDONMENT_REQUEST_MAX_BYTES)
    throw new Error('Source store request budget');
  const row = sourceAbandonmentRecord(JSON.parse(text));
  assertSourceAbandonmentKeys(row, [
    'version',
    'operation',
    'certificateId',
    'binding',
    'selection',
    'expected',
    'page',
  ]);
  if (
    row.version !== 1 ||
    !['certificate_create', 'install', 'readback', 'materialize'].includes(String(row.operation)) ||
    typeof row.certificateId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      row.certificateId,
    )
  )
    throw new Error('Invalid source store operation');
  const expected = sourceAbandonmentRecord(row.expected);
  assertSourceAbandonmentKeys(expected, [
    'inventorySha256',
    'inventoryArtifactSha256',
    'previewSha256',
  ]);
  if (
    ['inventorySha256', 'inventoryArtifactSha256', 'previewSha256'].some(
      (key) => typeof expected[key] !== 'string' || !sha.test(expected[key] as string),
    )
  )
    throw new Error('Invalid source artifact binding');
  const live = parseSourceAbandonmentLiveRequest(
    JSON.stringify({
      version: 1,
      operation: 'inventory_preview',
      binding: row.binding,
      selection: row.selection,
      expectedInventorySha256: expected.inventorySha256,
    }),
  );
  let page: SourceAbandonmentStoreRequest['page'];
  if (row.operation === 'materialize') {
    const value = sourceAbandonmentRecord(row.page);
    assertSourceAbandonmentKeys(value, ['chatId', 'pageSize']);
    if (
      !isSourceAbandonmentIdentity(value.chatId) ||
      !Number.isInteger(value.pageSize) ||
      Number(value.pageSize) < 1 ||
      Number(value.pageSize) > 200
    )
      throw new Error('Invalid exact source page');
    page = { chatId: value.chatId, pageSize: Number(value.pageSize) };
  } else if (row.page !== undefined) throw new Error('Unexpected exact source page');
  return {
    version: 1,
    operation: row.operation as SourceAbandonmentStoreRequest['operation'],
    certificateId: row.certificateId,
    binding: live.binding,
    selection: live.selection,
    expected: expected as SourceAbandonmentStoreRequest['expected'],
    ...(page ? { page } : {}),
  };
}

export { buildSourceAbandonmentInventoryDigest } from './source-abandonment-live-protocol';

export function verifySourceAbandonmentInventory(
  request: SourceAbandonmentStoreRequest,
  bytes: Buffer,
): SourceAbandonmentLiveOutput {
  if (
    bytes.length > SOURCE_ABANDONMENT_OUTPUT_MAX_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== request.expected.inventoryArtifactSha256
  )
    throw new Error('Source inventory artifact mismatch');
  const output = sourceAbandonmentRecord(JSON.parse(bytes.toString('utf8')));
  assertSourceAbandonmentKeys(output, [
    'version',
    'operation',
    'applied',
    'activationAuthorized',
    'decision',
    'binding',
    'selectionSha256',
    'registrySha256',
    'inventorySha256',
    'previewSha256',
    'selectedOwners',
    'children',
    'sqlPlans',
    'issues',
    'cost',
    'sqlEvidenceSha256',
    'redisEvidenceSha256',
    'redisCatalogs',
  ]);
  if (
    output.version !== 1 ||
    output.operation !== 'inventory_preview' ||
    output.applied !== false ||
    output.activationAuthorized !== false ||
    output.decision !== 'READY_TO_INSTALL' ||
    output.inventorySha256 !== request.expected.inventorySha256 ||
    output.previewSha256 !== request.expected.previewSha256 ||
    output.selectionSha256 !== sourceAbandonmentDigest(request.selection) ||
    sourceAbandonmentDigest(output.binding) !== sourceAbandonmentDigest(request.binding) ||
    output.registrySha256 !==
      sourceAbandonmentSourceClosureDigest(request.binding.sourceSha, request.binding.imageId) ||
    ![output.sqlEvidenceSha256, output.redisEvidenceSha256].every(
      (value) => typeof value === 'string' && sha.test(value),
    ) ||
    !Array.isArray(output.issues) ||
    output.issues.length ||
    !Array.isArray(output.selectedOwners) ||
    output.selectedOwners.length !== request.selection.ownerWebhookEventIds.length ||
    !Array.isArray(output.children) ||
    output.children.length > 10_000
  )
    throw new Error('Source inventory is not an exact reviewed permission');
  assertSourceAbandonmentCatalogProofs(output.redisCatalogs);
  const owners = new Set<string>();
  for (const item of output.selectedOwners) {
    const row = sourceAbandonmentRecord(item);
    assertSourceAbandonmentKeys(row, [
      'ownerWebhookEventId',
      'semanticKey',
      'claimId',
      'chatId',
      'messageId',
      'userId',
      'sourceProfile',
      'sourceAt',
      'rawPayloadSha256',
      'normalizedPayloadSha256',
      'ownerSnapshotSha256',
      'claimSnapshotSha256',
    ]);
    if (
      ['ownerWebhookEventId', 'semanticKey', 'claimId', 'chatId', 'messageId'].some(
        (key) => !isSourceAbandonmentIdentity(row[key]),
      ) ||
      (row.sourceProfile === SOURCE_ABANDONMENT_CHANNEL_PROFILE
        ? row.userId !== null
        : row.sourceProfile !== undefined || !isSourceAbandonmentIdentity(row.userId)) ||
      [
        'rawPayloadSha256',
        'normalizedPayloadSha256',
        'ownerSnapshotSha256',
        'claimSnapshotSha256',
      ].some((key) => typeof row[key] !== 'string' || !sha.test(row[key] as string)) ||
      typeof row.sourceAt !== 'string' ||
      !Number.isFinite(Date.parse(row.sourceAt)) ||
      new Date(row.sourceAt).toISOString() !== row.sourceAt ||
      !request.selection.ownerWebhookEventIds.includes(row.ownerWebhookEventId as string) ||
      owners.has(row.ownerWebhookEventId as string)
    )
      throw new Error('Invalid source owner evidence');
    owners.add(row.ownerWebhookEventId as string);
  }
  const children = new Set<string>();
  for (const item of output.children) {
    const row = sourceAbandonmentRecord(item);
    assertSourceAbandonmentKeys(row, [
      'jobKey',
      'queueName',
      'jobPayloadDigest',
      'chatId',
      'messageId',
      'userId',
    ]);
    if (
      ['jobKey', 'queueName', 'chatId', 'messageId'].some(
        (key) => !isSourceAbandonmentIdentity(row[key]),
      ) ||
      (row.userId !== undefined && !isSourceAbandonmentIdentity(row.userId)) ||
      typeof row.jobPayloadDigest !== 'string' ||
      !sha.test(row.jobPayloadDigest) ||
      ![
        ...MAX_ACTION_ALL_QUEUE_NAMES,
        SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
        SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
      ].includes(row.queueName as string) ||
      children.has(
        `${row.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE ? 'observation' : row.queueName === SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE ? 'channel-marker' : 'action'}:${row.jobKey}`,
      )
    )
      throw new Error('Invalid exact child evidence');
    if (
      row.queueName === SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE &&
      (row.userId !== undefined ||
        !output.selectedOwners.some((owner) => {
          const source = sourceAbandonmentRecord(owner);
          return (
            source.sourceProfile === SOURCE_ABANDONMENT_CHANNEL_PROFILE &&
            source.userId === null &&
            source.chatId === row.chatId &&
            source.messageId === row.messageId
          );
        }))
    )
      throw new Error('Channel marker requires exact authorless source');
    children.add(
      `${row.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE ? 'observation' : row.queueName === SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE ? 'channel-marker' : 'action'}:${row.jobKey}`,
    );
  }
  const inventory = output as unknown as SourceAbandonmentLiveOutput;
  if (buildSourceAbandonmentInventoryDigest(inventory) !== inventory.inventorySha256)
    throw new Error('Source inventory evidence digest mismatch');
  return inventory;
}

const allowance = () => ({
  ...LEGACY_RECOVERY_LIVE_BUDGET,
  deadlineAtMs: Date.now() + LEGACY_RECOVERY_LIVE_BUDGET.durationMs,
});
function attestationFor(
  request: SourceAbandonmentStoreRequest,
  inventory: SourceAbandonmentLiveOutput,
) {
  return {
    version: 1,
    operation: SOURCE_ABANDONMENT_OPERATION,
    sourceSha: request.binding.sourceSha,
    imageId: request.binding.imageId,
    abandonBefore: request.selection.abandonBefore,
    sourceClosureSha256: inventory.registrySha256,
    descendantsSha256: sourceAbandonmentDigest(inventory.children),
    previewSha256: inventory.previewSha256,
    binding: request.binding,
    selection: request.selection,
    selectionSha256: inventory.selectionSha256,
    inventorySha256: inventory.inventorySha256,
    inventoryArtifactSha256: request.expected.inventoryArtifactSha256,
    sqlEvidenceSha256: inventory.sqlEvidenceSha256,
    redisEvidenceSha256: inventory.redisEvidenceSha256,
  };
}

// FLAG: Installation writes only new immutable exclusions and positive receipt proofs.
// It cannot reset a started claim, retry a job, settle an unknown action or grant global immunity.
export async function executeSourceAbandonmentStore(
  prisma: PrismaClient,
  request: SourceAbandonmentStoreRequest,
  inventoryBytes: Buffer,
): Promise<LegacyRecoveryStoreOutput> {
  request = parseSourceAbandonmentStoreRequest(JSON.stringify(request));
  const inventory = verifySourceAbandonmentInventory(request, inventoryBytes);
  const attestation = attestationFor(request, inventory);
  const base = {
    version: 1 as const,
    operation: request.operation,
    certificateId: request.certificateId,
    activationAuthorized: false as const,
    bindingSha256: sourceAbandonmentDigest(request.binding),
    inventorySha256: request.expected.inventorySha256,
    previewSha256: request.expected.previewSha256,
  };
  const sharedAllowance: {
    pages: number;
    rows: number;
    probes: number;
    bytes: number;
    deadlineAtMs: number;
  } = allowance();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      await tx.$executeRaw`SET LOCAL max_parallel_workers_per_gather = 0`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      const fresh = async () => {
        const current = await inventorySourceAbandonmentSql(
          tx,
          request.selection,
          sharedAllowance,
          true,
          request.binding.publisherBotId,
        );
        const childSql = await inventorySourceAbandonmentChildSql(
          tx,
          inventory.children,
          {
            ...sharedAllowance,
            pages: sharedAllowance.pages - current.cost.pages,
            rows: sharedAllowance.rows - current.cost.rows,
            bytes: sharedAllowance.bytes - current.cost.bytes,
            probes: sharedAllowance.probes - current.cost.probes,
          },
          true,
        );
        if (
          current.issues.length ||
          childSql.issues.length ||
          sourceAbandonmentDigest({
            sources: current.stableDigest,
            children: childSql.stableDigest,
          }) !== inventory.sqlEvidenceSha256 ||
          sourceAbandonmentDigest(current.selectedOwners) !==
            sourceAbandonmentDigest(inventory.selectedOwners) ||
          buildSourceAbandonmentPreviewDigest(
            current.candidates,
            inventory.children,
            request.selection,
            inventory.registrySha256,
          ) !== inventory.previewSha256
        )
          throw new Error('Reviewed source or descendant evidence changed');
        for (const field of ['pages', 'rows', 'probes', 'bytes'] as const) {
          sharedAllowance[field] -= current.cost[field] + childSql.cost[field];
          if (sharedAllowance[field] < 0) throw new Error('Source store shared budget');
        }
        return current.candidates;
      };
      if (request.operation === 'certificate_create') {
        await fresh();
        await tx.webhookSourceAbandonmentCertificate.create({
          data: {
            id: request.certificateId,
            operation: SOURCE_ABANDONMENT_OPERATION,
            operationVersion: 1,
            sourceSha: request.binding.sourceSha,
            imageId: request.binding.imageId,
            attestation: attestation as unknown as Prisma.InputJsonValue,
            attestationDigest: sourceAbandonmentDigest(attestation),
            previewSha256: request.expected.previewSha256,
            sourceClosureSha256: inventory.registrySha256,
            descendantsSha256: sourceAbandonmentDigest(inventory.children),
            abandonBefore: new Date(request.selection.abandonBefore),
            expectedSourceCount: inventory.selectedOwners.length,
            expectedChildCount: inventory.children.length,
          },
        });
        return { ...base, state: 'UNSEALED' as const };
      }
      if (request.operation !== 'readback')
        await tx.$queryRaw`SELECT id FROM webhook_source_abandonment_certificates WHERE id = ${request.certificateId} FOR UPDATE`;
      const certificate = await tx.webhookSourceAbandonmentCertificate.findUnique({
        where: { id: request.certificateId },
      });
      if (!certificate) {
        if (request.operation === 'readback')
          return { ...base, state: 'ABSENT' as const, completeChats: 0, requiredChats: 0 };
        throw new Error('Exact source certificate absent');
      }
      if (
        certificate.attestationDigest !== sourceAbandonmentDigest(attestation) ||
        sourceAbandonmentDigest(certificate.attestation) !== sourceAbandonmentDigest(attestation) ||
        certificate.operation !== SOURCE_ABANDONMENT_OPERATION ||
        certificate.operationVersion !== 1 ||
        certificate.previewSha256 !== inventory.previewSha256 ||
        certificate.sourceClosureSha256 !== inventory.registrySha256 ||
        certificate.descendantsSha256 !== sourceAbandonmentDigest(inventory.children) ||
        certificate.abandonBefore.toISOString() !== request.selection.abandonBefore ||
        certificate.sourceSha !== request.binding.sourceSha ||
        certificate.imageId !== request.binding.imageId ||
        certificate.expectedSourceCount !== inventory.selectedOwners.length ||
        certificate.expectedChildCount !== inventory.children.length
      )
        throw new Error('Exact source certificate binding mismatch');
      if (request.operation === 'install') {
        if (certificate.sealedAt) throw new Error('Sealed source installation cannot be replayed');
        for (const chatId of [...new Set(inventory.selectedOwners.map((row) => row.chatId))].sort())
          await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
        for (const owner of [...inventory.selectedOwners].sort((a, b) =>
          a.ownerWebhookEventId.localeCompare(b.ownerWebhookEventId),
        )) {
          await tx.$queryRaw`SELECT id FROM webhook_events WHERE id = ${owner.ownerWebhookEventId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM webhook_execution_claims WHERE id = ${owner.claimId} FOR UPDATE`;
        }
        const candidates = await fresh();
        const childInputs = sourceAbandonmentChildInputs(candidates, inventory.children);
        for (const candidate of candidates) {
          const sourceId = randomUUID();
          await tx.webhookSourceAbandonment.create({
            data: {
              id: sourceId,
              operationVersion: 1,
              certificateId: certificate.id,
              semanticKey: candidate.claim.semanticKey,
              ownerWebhookEventId: candidate.owner.id,
              claimId: candidate.claim.id,
              chatId: candidate.source.chatId,
              messageId: candidate.source.messageId,
              subjectUserId: candidate.source.userId,
              sourceProfile:
                'sourceProfile' in candidate.source
                  ? candidate.source.sourceProfile
                  : SOURCE_ABANDONMENT_HUMAN_PROFILE,
              sourceAt: candidate.source.sourceAt,
              rawPayloadDigest: candidate.rawPayloadDigest,
              normalizedPayloadDigest: candidate.normalizedPayloadDigest,
              ownerSnapshot: sourceAbandonmentOwnerSnapshot(candidate.owner),
              claimSnapshot: JSON.parse(JSON.stringify(candidate.claim)),
            },
          });
          const holds = childInputs.filter(
            (child) => child.ownerWebhookEventId === candidate.owner.id,
          );
          if (holds.length)
            await tx.webhookSourceChildHold.createMany({
              data: holds.map(({ kind, childKey, payloadDigest }) => ({
                abandonmentId: sourceId,
                kind,
                childKey,
                payloadDigest,
              })),
            });
        }
        if (
          (await tx.$executeRaw`UPDATE webhook_source_abandonment_certificates SET sealed_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = ${certificate.id} AND sealed_at IS NULL`) !==
          1
        )
          throw new Error('Source certificate seal compare-and-set failed');
        for (const candidate of candidates) {
          if (
            (await materializeSourceAbandonmentReceipt(tx, candidate.owner.id, {
              certificateId: certificate.id,
            })) !== 'APPLIED_WITH_PROOF'
          )
            throw new Error('Exact source owner materialization refused');
        }
      }
      const currentCertificate = await tx.webhookSourceAbandonmentCertificate.findUniqueOrThrow({
        where: { id: certificate.id },
      });
      const sources = await tx.webhookSourceAbandonment.findMany({
        where: { certificateId: certificate.id },
        orderBy: { ownerWebhookEventId: 'asc' },
        take: inventory.selectedOwners.length + 1,
      });
      if (!currentCertificate.sealedAt) {
        if (sources.length)
          throw new Error('Unsealed source installation contains partial exclusions');
        return {
          ...base,
          state: 'UNSEALED' as const,
          completeChats: 0,
          requiredChats: new Set(inventory.selectedOwners.map((row) => row.chatId)).size,
        };
      }
      if (sources.length !== inventory.selectedOwners.length)
        throw new Error('Source installation count mismatch');
      const actualChildren: unknown[] = [];
      for (const source of sources) {
        const reviewed = inventory.selectedOwners.find(
          (row) => row.ownerWebhookEventId === source.ownerWebhookEventId,
        );
        const event = await tx.webhookEvent.findUniqueOrThrow({
          where: { id: source.ownerWebhookEventId },
        });
        const claim = await tx.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: source.claimId },
        });
        if (
          !reviewed ||
          source.operationVersion !== 1 ||
          source.semanticKey !== reviewed.semanticKey ||
          source.claimId !== reviewed.claimId ||
          source.chatId !== reviewed.chatId ||
          source.messageId !== reviewed.messageId ||
          source.subjectUserId !== reviewed.userId ||
          source.sourceProfile !== (reviewed.sourceProfile ?? SOURCE_ABANDONMENT_HUMAN_PROFILE) ||
          source.sourceAt.toISOString() !== reviewed.sourceAt ||
          source.rawPayloadDigest !== reviewed.rawPayloadSha256 ||
          source.normalizedPayloadDigest !== reviewed.normalizedPayloadSha256 ||
          sourceAbandonmentDigest(source.ownerSnapshot) !== reviewed.ownerSnapshotSha256 ||
          sourceAbandonmentDigest(source.claimSnapshot) !== reviewed.claimSnapshotSha256 ||
          sourceAbandonmentDigest(sourceAbandonmentOwnerSnapshot(event)) !==
            reviewed.ownerSnapshotSha256 ||
          sourceAbandonmentDigest(event.rawPayload) !== reviewed.rawPayloadSha256 ||
          sourceAbandonmentDigest(event.normalizedPayload) !== reviewed.normalizedPayloadSha256 ||
          sourceAbandonmentDigest(claim) !== reviewed.claimSnapshotSha256 ||
          !event.sourceDispositionId ||
          event.sourceDispositionReceiptId !== event.id
        )
          throw new Error('Frozen source installation evidence mismatch');
        const proof = await tx.webhookSourceReceiptDisposition.findUniqueOrThrow({
          where: { id: event.sourceDispositionId },
        });
        if (
          proof.receiptId !== event.id ||
          proof.abandonmentId !== source.id ||
          proof.scopeKind !== 'EXACT_OWNER' ||
          proof.originalStatus !== 'FAILED' ||
          proof.sourceDigest !== sourceAbandonmentReceiptSourceDigest(event, proof.originalStatus)
        )
          throw new Error('Source owner positive proof mismatch');
        const holds = await tx.webhookSourceChildHold.findMany({
          where: { abandonmentId: source.id },
          take: inventory.children.length + 1,
          orderBy: [{ kind: 'asc' }, { childKey: 'asc' }],
        });
        actualChildren.push(
          ...holds.map(({ kind, childKey, payloadDigest }) => ({
            ownerWebhookEventId: source.ownerWebhookEventId,
            kind,
            childKey,
            payloadDigest,
          })),
        );
      }
      const expectedChildren = inventory.children.map((child) => {
        const source = sources.filter(
          (row) =>
            row.chatId === child.chatId &&
            row.messageId === child.messageId &&
            (child.userId === undefined || row.subjectUserId === child.userId),
        );
        if (source.length !== 1) throw new Error('Stored child source mismatch');
        return {
          ownerWebhookEventId: source[0]!.ownerWebhookEventId,
          kind:
            child.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE
              ? 'SPAMMER_OBSERVATION'
              : child.queueName === SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE
                ? 'CHANNEL_AUTO_POST'
                : 'MAX_ACTION',
          childKey: child.jobKey,
          payloadDigest: child.jobPayloadDigest,
        };
      });
      const childDigests = (children: unknown[]) => children.map(sourceAbandonmentDigest).sort();
      if (
        sourceAbandonmentDigest(childDigests(actualChildren)) !==
        sourceAbandonmentDigest(childDigests(expectedChildren))
      )
        throw new Error('Exact child holds mismatch');
      const meter = new SourceInventorySqlMeter(tx, sharedAllowance);
      let scanned = 0,
        applied = 0;
      if (request.operation === 'materialize') {
        if (!request.page || !sources.some((source) => source.chatId === request.page!.chatId))
          throw new Error('Materialization outside reviewed source');
        for (const source of sources.filter((row) => row.chatId === request.page!.chatId)) {
          const left = request.page.pageSize - scanned;
          if (left <= 0) break;
          const family = await readSourceAbandonmentFamily(
            meter,
            source.chatId,
            source.messageId,
            left,
          );
          for (const row of family.slice(0, left)) {
            scanned++;
            const result = await materializeSourceAbandonmentReceipt(tx, row.id, {
              certificateId: certificate.id,
            });
            if (result === 'APPLIED_WITH_PROOF') applied++;
            else if (result !== 'ALREADY_APPLIED_SAME_PROOF')
              throw new Error('Source family materialization refused');
          }
        }
      }
      const completeByChat = new Map<string, boolean>();
      for (const source of sources) {
        const pending = await readSourceAbandonmentFamily(
          meter,
          source.chatId,
          source.messageId,
          1,
        );
        completeByChat.set(
          source.chatId,
          (completeByChat.get(source.chatId) ?? true) && pending.length === 0,
        );
      }
      const completeChats = [...completeByChat.values()].filter(Boolean).length;
      const requiredChats = completeByChat.size;
      if (request.operation === 'materialize') {
        const complete = completeByChat.get(request.page!.chatId) === true;
        return {
          ...base,
          state: 'SEALED' as const,
          page: { complete, scanned, applied, blocked: false },
          cursor: {
            chatId: request.page!.chatId,
            horizon: currentCertificate.sealedAt.toISOString(),
            afterCreatedAt: null,
            afterId: null,
            scanned,
            complete,
          },
        };
      }
      return {
        ...base,
        state: completeChats === requiredChats ? ('MATERIALIZED' as const) : ('SEALED' as const),
        completeChats,
        requiredChats,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 3000,
      timeout: 35_000,
    },
  );
}

export function sourceAbandonmentStorePoolConfig(readonly: boolean): PrismaPoolConfig {
  return {
    application_name: 'maxim-source-abandonment-store-v1',
    max: 1,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 1000,
    statement_timeout: 5000,
    options: `-c timezone=UTC -c max_parallel_workers_per_gather=0 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=35000 -c default_transaction_read_only=${readonly ? 'on' : 'off'}`,
  };
}
export function assertSourceAbandonmentStoreEnvironment(
  request: SourceAbandonmentStoreRequest,
  env: NodeJS.ProcessEnv,
): void {
  if (
    env.MAXIM_SOURCE_ABANDONMENT_OFFLINE !== '1' ||
    env.MAXIM_SOURCE_ABANDONMENT_PROTOCOL !== 'source-abandonment-v1' ||
    env.MAXIM_SOURCE_ABANDONMENT_STORE_MODE !==
      (request.operation === 'readback' ? 'readback' : 'writer') ||
    env.APP_SERVICE_NAME !== 'source-abandonment-store' ||
    env.APP_SOURCE_SHA !== request.binding.sourceSha ||
    env.MAXIM_SOURCE_ABANDONMENT_IMAGE_ID !== request.binding.imageId ||
    env.TZ !== 'UTC'
  )
    throw new Error('Exact source offline host environment required');
}
export async function runSourceAbandonmentStoreCli(): Promise<number> {
  let prisma: PrismaClient | undefined;
  try {
    const request = parseSourceAbandonmentStoreRequest(
      await readSourceAbandonmentStdin(process.stdin),
    );
    assertSourceAbandonmentStoreEnvironment(request, process.env);
    if (!process.env.DATABASE_URL) throw new Error('Offline SQL unavailable');
    const bytes = await readLegacyRecoveryInventoryFile();
    prisma = createPrismaClient(
      process.env.DATABASE_URL,
      sourceAbandonmentStorePoolConfig(request.operation === 'readback'),
    );
    const result = await executeSourceAbandonmentStore(prisma, request, bytes);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ version: 1, applied: false, activationAuthorized: false, refused: true, code: 'source_store_refused' })}\n`,
    );
    return 1;
  } finally {
    await prisma?.$disconnect();
  }
}
if (require.main === module)
  void runSourceAbandonmentStoreCli().then((code) => {
    process.exitCode = code;
  });
