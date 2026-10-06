import { createHash, randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  inspectLegacyRecoveryCandidate,
  buildLegacyRecoveryPreviewDigest,
  legacySnapshotDigest,
} from '../webhook/webhook-legacy-cold-install';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  legacyRecoveryLiveDigest,
  type LegacyRecoveryLiveOutput,
} from './legacy-recovery-live-protocol';
import {
  executeLegacyRecoveryStore,
  legacyRecoveryStorePoolConfig,
  parseLegacyRecoveryStoreRequest,
  type LegacyRecoveryStoreRequest,
} from './legacy-recovery-store';
const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const native = url ? describe : describe.skip;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
native('standalone legacy recovery store PostgreSQL boundaries', () => {
  jest.setTimeout(30_000);
  let database: PrismaClient,
    readonlyDatabase: PrismaClient,
    request: LegacyRecoveryStoreRequest,
    bytes: Buffer,
    chatId: string,
    ownerId: string;
  const previousOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Disposable local database required');
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    database = createPrismaClient(url, legacyRecoveryStorePoolConfig(false));
    readonlyDatabase = createPrismaClient(url, legacyRecoveryStorePoolConfig(true));
    const [identity] = await readonlyDatabase.$queryRaw<
      Array<{ timezone: string; readonly: string }>
    >`SELECT current_setting('TimeZone') AS timezone, current_setting('transaction_read_only') AS readonly`;
    expect(identity).toEqual({ timezone: 'UTC', readonly: 'on' });
  });
  beforeEach(async () => {
    const [migration] = await database.$queryRaw<
      Array<{ at: Date }>
    >`SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL LIMIT 1`;
    const at = migration!.at.getTime() - 5000;
    chatId = `-store-cli-${randomUUID()}`;
    ownerId = randomUUID();
    await database.chat.create({
      data: { id: chatId, title: 'Offline native fixture', entityType: 'CHAT' },
    });
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: at,
        message: {
          sender: { user_id: '12345', name: 'Fixture', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: at,
          body: { mid: randomUUID(), text: 'Ordinary source' },
        },
      },
      { botId: 'major-1' },
    );
    const owner = await database.webhookEvent.create({
      data: {
        id: ownerId,
        botId: 'major-1',
        dedupKey: ownerId,
        semanticKey: buildWebhookSemanticEventKey(update),
        normalizedPayload: JSON.parse(JSON.stringify(update)),
        rawPayload: JSON.parse(JSON.stringify(update.raw)),
        status: 'FAILED',
        createdAt: new Date(at + 1000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    await database.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: owner.semanticKey!,
        webhookEventId: ownerId,
        enforced: false,
        createdAt: owner.createdAt,
      },
    });
    const candidate = (await inspectLegacyRecoveryCandidate(database, ownerId, ['major-1']))!;
    expect(candidate).not.toBeNull();
    const sourceSha = 'a'.repeat(40),
      imageId = `sha256:${'b'.repeat(64)}`;
    const binding = {
      maintenanceId: randomUUID(),
      queueFenceNonce: randomUUID(),
      transitionJournalSha256: sha('journal'),
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
    };
    request = parseLegacyRecoveryStoreRequest(
      JSON.stringify({
        version: 1,
        operation: 'certificate_create',
        certificateId: randomUUID(),
        binding,
        selection: { ownerWebhookEventIds: [ownerId], majorBotIds: ['major-1'] },
        expected: {
          inventorySha256: sha('inventory'),
          inventoryArtifactSha256: sha('placeholder'),
          previewSha256: buildLegacyRecoveryPreviewDigest([candidate], []),
        },
      }),
    );
    const output: LegacyRecoveryLiveOutput = {
      version: 1,
      operation: 'inventory_preview',
      applied: false,
      activationAuthorized: false,
      decision: 'READY_TO_INSTALL',
      binding: request.binding,
      selectionSha256: legacyRecoveryLiveDigest(request.selection),
      registrySha256: sha('registry'),
      inventorySha256: request.expected.inventorySha256,
      previewSha256: request.expected.previewSha256,
      selectedOwners: [
        {
          ownerWebhookEventId: ownerId,
          semanticKey: candidate.owner.semanticKey!,
          claimId: candidate.claim.id,
          ...candidate.source,
          sourceAt: candidate.source.sourceAt.toISOString(),
          rawPayloadSha256: candidate.rawPayloadDigest,
          normalizedPayloadSha256: candidate.normalizedPayloadDigest,
          ownerSnapshotSha256: legacySnapshotDigest(candidate.owner),
          claimSnapshotSha256: legacySnapshotDigest(candidate.claim),
        },
      ],
      children: [],
      sqlPlans: [],
      issues: [],
      cost: { pages: 1, rows: 1, probes: 1, bytes: 0 },
    };
    bytes = Buffer.from(`${JSON.stringify(output)}\n`);
    request = {
      ...request,
      expected: { ...request.expected, inventoryArtifactSha256: sha(bytes.toString()) },
    };
  });
  afterEach(async () => {
    await database.webhookExecutionClaim.deleteMany({ where: { webhookEventId: ownerId } });
    await database.webhookEvent.deleteMany({ where: { id: ownerId } });
    await database.webhookLegacyReceiptDisposition.deleteMany({ where: { receiptId: ownerId } });
    await database.webhookLegacyMaterializationCursor.deleteMany({
      where: { certificateId: request.certificateId },
    });
    await database.webhookLegacySealedAuthority.deleteMany({
      where: { certificateId: request.certificateId },
    });
    await database.webhookLegacyRecovery.deleteMany({
      where: { certificateId: request.certificateId },
    });
    await database.webhookLegacyQuiescenceCertificate.deleteMany({
      where: { id: request.certificateId },
    });
    await database.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await readonlyDatabase?.$disconnect();
    await database?.$disconnect();
    if (previousOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = previousOffline;
  });
  const call = (operation: LegacyRecoveryStoreRequest['operation']) =>
    executeLegacyRecoveryStore(
      operation === 'readback' ? readonlyDatabase : database,
      { ...request, operation },
      bytes,
    );
  it('uses the recorded UUID across create, seal, one page and a separate read-only reconciliation', async () => {
    expect((await call('readback')).state).toBe('ABSENT');
    expect((await call('certificate_create')).state).toBe('UNSEALED');
    expect((await call('readback')).state).toBe('UNSEALED');
    await expect(call('certificate_create')).rejects.toThrow();
    expect((await call('install')).state).toBe('SEALED');
    await expect(call('install')).rejects.toThrow('cannot retry');
    const page = await executeLegacyRecoveryStore(
      database,
      { ...request, operation: 'materialize', page: { chatId, pageSize: 1 } },
      bytes,
    );
    expect(page).toMatchObject({
      activationAuthorized: false,
      page: { scanned: 1, applied: 0, complete: true },
      cursor: { chatId, complete: true },
    });
    expect((await call('readback')).state).toBe('MATERIALIZED');
    expect((await database.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).status).toBe(
      'FAILED',
    );
  });
  it('reconciles a lost committed transaction response without installing twice', async () => {
    await call('certificate_create');
    const unknownResultClient = new Proxy(database, {
      get(target, key) {
        if (key === '$transaction')
          return async (...args: unknown[]) => {
            await Reflect.apply(target.$transaction, target, args);
            throw new Error('simulated lost commit response');
          };
        return Reflect.get(target, key);
      },
    });
    await expect(
      executeLegacyRecoveryStore(unknownResultClient, { ...request, operation: 'install' }, bytes),
    ).rejects.toThrow('lost commit');
    expect((await call('readback')).state).toBe('SEALED');
    expect(
      await database.webhookLegacyRecovery.count({
        where: { certificateId: request.certificateId },
      }),
    ).toBe(1);
  });
  it('refuses changed exact source evidence before creating a certificate', async () => {
    await database.webhookEvent.update({ where: { id: ownerId }, data: { enqueueAttempts: 1 } });
    await expect(call('certificate_create')).rejects.toThrow('evidence changed');
    expect((await call('readback')).state).toBe('ABSENT');
  });
  it('cannot materialize an unreviewed chat or write through the read-only client', async () => {
    await call('certificate_create');
    await call('install');
    await expect(
      executeLegacyRecoveryStore(
        database,
        { ...request, operation: 'materialize', page: { chatId: '-unreviewed', pageSize: 1 } },
        bytes,
      ),
    ).rejects.toThrow('reviewed scope');
    await expect(
      readonlyDatabase.webhookLegacyMaterializationCursor.create({
        data: { certificateId: request.certificateId, chatId, horizon: new Date() },
      }),
    ).rejects.toThrow();
  });
});
