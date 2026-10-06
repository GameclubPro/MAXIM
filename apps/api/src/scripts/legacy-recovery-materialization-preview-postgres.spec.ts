import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient, type WebhookEvent } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  inspectLegacyRecoveryCandidate,
  createLegacyColdCertificate,
  installAndSealLegacyRecoveryBatch,
  materializeLegacyHeldReceiptPage,
  buildLegacyRecoveryPreviewDigest,
  legacySnapshotDigest,
  type LegacyRecoveryCandidate,
} from '../webhook/webhook-legacy-cold-install';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { previewLegacyRecoveryMaterialization } from './legacy-recovery-materialization-preview';
const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const native = url ? describe : describe.skip;
const allowance = () => ({
  pages: 512,
  rows: 50_000,
  probes: 512,
  bytes: 8 * 1024 * 1024,
  deadlineAtMs: Date.now() + 25_000,
});
native('read-only materialization preview on representative PostgreSQL history', () => {
  jest.setTimeout(40_000);
  let db: PrismaClient, reader: PrismaClient, candidate: LegacyRecoveryCandidate, chatId: string;
  const noise = `materialization-noise-${randomUUID()}`,
    receipts: string[] = [],
    certificates: string[] = [];
  const oldOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Disposable local database required');
    db = createPrismaClient(url, { max: 1, statement_timeout: 5000, options: '-c timezone=UTC' });
    reader = createPrismaClient(url, {
      max: 1,
      statement_timeout: 5000,
      options: '-c timezone=UTC -c default_transaction_read_only=on',
    });
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    for (let page = 0; page < 10; page++) {
      await db.webhookEvent.createMany({
        data: Array.from({ length: 500 }, (_, index) => ({
          id: `${noise}-${page}-${index}`,
          dedupKey: `${noise}-${page}-${index}`,
          status: 'PROCESSED' as const,
          rawPayload: {},
          normalizedPayload: {},
          createdAt: new Date('2020-01-01T00:00:00Z'),
        })),
      });
      await db.webhookExecutionClaim.createMany({
        data: Array.from({ length: 500 }, (_, index) => ({
          id: `${noise}-${page}-${index}`,
          kind: index % 2 ? 'COMMAND' : 'EXECUTION',
          semanticKey: `${noise}-${page}-${index}`,
          status: 'COMPLETED' as const,
        })),
      });
    }
    await db.chat.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        id: `${noise}-chat-${index}`,
        title: 'Noise',
      })),
    });
    await db.chatSettings.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({ chatId: `${noise}-chat-${index}` })),
    });
    await db.$executeRawUnsafe('ANALYZE webhook_events');
    await db.$executeRawUnsafe('ANALYZE webhook_execution_claims');
    await db.$executeRawUnsafe('ANALYZE chat_settings');
  });
  beforeEach(async () => {
    chatId = `-preview-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Preview', settings: { create: {} } } });
    const cutoff = (
      await db.$queryRaw<
        Array<{ at: Date }>
      >`SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
    )[0]!.at;
    const event = await receipt('Old ordinary source', 'held-user', cutoff.getTime() - 5000, {
      status: 'FAILED',
      errorMessage:
        'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
    });
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: event.id,
        enforced: false,
        createdAt: event.createdAt,
      },
    });
    candidate = (await inspectLegacyRecoveryCandidate(db, event.id, ['major']))!;
    expect(candidate).toBeTruthy();
  });
  afterEach(async () => {
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: receipts } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: receipts.splice(0) } } });
    for (const certificateId of certificates.splice(0)) {
      const authority = await db.webhookLegacySealedAuthority.findUnique({
        where: { certificateId },
      });
      if (authority)
        await db.webhookLegacyReceiptDisposition.deleteMany({
          where: { authorityId: authority.id },
        });
      await db.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId } });
      await db.webhookLegacyRecovery.deleteMany({ where: { certificateId } });
      await db.webhookLegacySealedAuthority.deleteMany({ where: { certificateId } });
      await db.webhookLegacyQuiescenceCertificate.delete({ where: { id: certificateId } });
    }
    await db.chatSettings.deleteMany({ where: { chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
    await db.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
  });
  afterAll(async () => {
    await db.webhookExecutionClaim.deleteMany({ where: { id: { startsWith: noise } } });
    await db.webhookEvent.deleteMany({ where: { id: { startsWith: noise } } });
    await db.chatSettings.deleteMany({ where: { chatId: { startsWith: noise } } });
    await db.chat.deleteMany({ where: { id: { startsWith: noise } } });
    await db.nightModeTransitionReconcileRequest.deleteMany({
      where: { chatId: { startsWith: noise } },
    });
    await reader.$disconnect();
    await db.$disconnect();
    if (oldOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = oldOffline;
  });
  async function receipt(
    text = 'Ordinary',
    userId = 'held-user',
    at = Date.now() - 1000,
    change: Partial<WebhookEvent> = {},
  ) {
    const id = randomUUID();
    const raw = {
      update_type: 'message_created',
      update_id: id,
      timestamp: at,
      message: {
        sender: { user_id: userId, is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: at,
        body: { mid: id, text },
      },
    };
    const normalized = new WebhookParser().parse(raw, { botId: 'major' });
    receipts.push(id);
    return db.webhookEvent.create({
      data: {
        id,
        botId: 'major',
        dedupKey: `major:${id}`,
        semanticKey: buildWebhookSemanticEventKey(normalized),
        rawPayload: raw,
        normalizedPayload: JSON.parse(JSON.stringify(normalized)),
        createdAt: new Date(at + 1),
        ...change,
      } as never,
    });
  }
  async function preview(overrides: Partial<ReturnType<typeof allowance>> = {}) {
    return reader.$transaction(
      (tx) =>
        previewLegacyRecoveryMaterialization(tx, [candidate], { ...allowance(), ...overrides }),
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
  }
  async function actualPage() {
    const sourceSha = 'a'.repeat(40),
      imageId = `sha256:${'b'.repeat(64)}`;
    const cert = await createLegacyColdCertificate(db, {
      version: 1,
      sourceSha,
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256: buildLegacyRecoveryPreviewDigest([candidate], []),
      queueFenceNonce: 'disposable-preview-test',
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true,
        }),
      ),
    });
    certificates.push(cert.id);
    await installAndSealLegacyRecoveryBatch(db, cert.id, [candidate], []);
    return materializeLegacyHeldReceiptPage(db, cert.id, chatId);
  }
  it('predicts an ordinary held prefix using the real classifier without writing and matches actual installation', async () => {
    const event = await receipt();
    const result = await preview();
    expect(result.issues).toEqual([]);
    expect(result.decision).toBe('READY');
    expect(result.activationAuthorized).toBe(false);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).legacyDispositionId,
    ).toBeNull();
    expect(
      await db.webhookLegacyReceiptDisposition.count({ where: { receiptId: { in: receipts } } }),
    ).toBe(0);
    expect(await actualPage()).toMatchObject({ blocked: false, complete: true, applied: 1 });
  });
  it.each(['тишина 12', '/ban', 'Старт'])(
    'refuses pre-seal command %s before any writer',
    async (text) => {
      await receipt(text);
      const certificatesBefore = await db.webhookLegacyQuiescenceCertificate.count();
      const result = await preview();
      expect(result.decision).toBe('DENY');
      expect(result.issues[0]?.code).toMatch(/materialization_preview_(blocked|unproved)/u);
      expect(await db.webhookLegacyQuiescenceCertificate.count()).toBe(certificatesBefore);
      await expect(actualPage()).resolves.toMatchObject({ blocked: true });
    },
  );
  it('checks the current custom command name', async () => {
    await db.chatSettings.update({ where: { chatId }, data: { adminSilenceCommandName: 'пауза' } });
    await receipt('пауза 12');
    expect((await preview()).decision).toBe('DENY');
  });
  it.each(['EXECUTION', 'UNKNOWN_OLD_KIND'])(
    'includes %s claims when predicting a blocker',
    async (kind) => {
      const event = await receipt();
      await db.webhookExecutionClaim.create({
        data: {
          id: `${noise}-case-${randomUUID()}`,
          kind,
          semanticKey: event.semanticKey!,
          webhookEventId: kind === 'UNKNOWN_OLD_KIND' ? null : event.id,
          businessStartedAt: new Date(),
        },
      });
      expect((await preview()).issues).toEqual([
        { code: 'materialization_preview_blocked', descriptor: 'sql:materialization-preview' },
      ]);
    },
  );
  it('keeps digest stable across read-only snapshots while including changed source evidence', async () => {
    const event = await receipt();
    const first = await preview();
    const second = await preview();
    expect(first.decision).toBe('READY');
    expect(second.proofSha256).toBe(first.proofSha256);
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { errorMessage: 'changed evidence' },
    });
    expect((await preview()).proofSha256).not.toBe(first.proofSha256);
  });
  it('walks more than one same-timestamp page and stays out of unrelated retained history', async () => {
    const at = Date.now() - 1000;
    const template = await receipt('Other author', 'unrelated-user', at);
    const rows = Array.from({ length: 205 }, () => ({
      ...template,
      id: randomUUID(),
      dedupKey: randomUUID(),
    }));
    receipts.push(...rows.map(({ id }) => id));
    await db.webhookEvent.createMany({ data: rows as never });
    const result = await preview();
    expect(result.issues).toEqual([]);
    expect(result.scannedReceipts).toBe(207);
    expect(result.prefixPages).toBe(2);
    expect(
      result.plans.filter((plan) => plan.indexes.includes('webhook_events_ordered_chat_head_idx')),
    ).toHaveLength(2);
    expect(result.cost.probes).toBeLessThan(40);
  });
  it('rejects a new pre-seal command at the required cold recheck', async () => {
    await receipt();
    expect((await preview()).decision).toBe('READY');
    await receipt('тишина 12');
    expect((await preview()).decision).toBe('DENY');
  });
  it('refuses a writable or non-repeatable snapshot', async () => {
    expect(
      (
        await db.$transaction(
          (tx) => previewLegacyRecoveryMaterialization(tx, [candidate], allowance()),
          { isolationLevel: 'RepeatableRead' },
        )
      ).decision,
    ).toBe('DENY');
    expect(
      (
        await reader.$transaction(
          (tx) => previewLegacyRecoveryMaterialization(tx, [candidate], allowance()),
          { isolationLevel: 'ReadCommitted' },
        )
      ).decision,
    ).toBe('DENY');
  });
  it.each(['future', 'oversize', 'budget'] as const)(
    'refuses %s prefixes before installation',
    async (fault) => {
      await receipt(
        fault === 'oversize' ? 'x'.repeat(150_000) : 'Ordinary',
        'unrelated-user',
        fault === 'future' ? Date.now() + 10_000 : Date.now() - 1000,
      );
      const result = await preview(fault === 'budget' ? { pages: 1 } : {});
      expect(result.decision).toBe('DENY');
      expect(result.activationAuthorized).toBe(false);
    },
  );
});
