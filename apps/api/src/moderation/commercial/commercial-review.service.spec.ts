import { CommercialReviewService } from './commercial-review.service';

const updatedAt = new Date('2026-10-01T10:00:00.000Z');
function createRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sample-1',
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: 'message-1',
    source: 'TEXT',
    score: 0.85,
    evidenceHash: 'hash',
    label: null,
    reviewPriority: 90,
    observedAt: updatedAt,
    updatedAt,
    createdAt: updatedAt,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    chat: { title: 'Тестовый чат' },
    evidence: {
      source: 'TEXT',
      excerpt: 'Услуги ремонта',
      score: 85,
      actionBand: 'DELETE_ONLY',
      messageDisposition: 'DELETE',
      requiredPolicyCohorts: ['commercial-text'],
      detectorVersion: 'v1',
      decisionFingerprint: 'fingerprint',
      reviewPriority: 90,
      reasons: ['SERVICE_OFFER'],
      label: null,
      reviewReason: '',
      reviewedAt: null,
    },
    ...overrides,
  };
}
function createService(rows = [createRow()]) {
  const prisma = {
    commercialReviewSample: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: rows.length }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  return { prisma, service: new CommercialReviewService(prisma as never) };
}
const candidate = {
  chatId: 'chat-1',
  userId: 'user-1',
  messageId: 'message-1',
  text: 'Ремонт: +7 999 123-45-67 https://example.com team@example.com',
  score: 85,
  actionBand: 'DELETE_ONLY',
  source: 'TEXT' as const,
  decisionFingerprint: 'fingerprint',
  detectorVersion: 'v1',
  messageDisposition: 'DELETE' as const,
  requiredPolicyCohorts: ['commercial-text'],
};

describe('CommercialReviewService quality feedback boundary', () => {
  it('stores only sanitized excerpts in a dedicated sample table with fixed TTL and immutable deduplication', async () => {
    const { prisma, service } = createService();
    await service.recordCandidate(candidate);
    const write = prisma.commercialReviewSample.upsert.mock.calls[0]![0];
    expect(write.create.evidence.excerpt).not.toMatch(/999|example\.com|team@/u);
    expect(write.create.expiresAt.getTime() - write.create.observedAt.getTime()).toBe(
      14 * 86400_000,
    );
    expect(write.update).toEqual({});
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('accepts OCR metadata without persisting recognized text and never blocks on capture failure', async () => {
    const { prisma, service } = createService();
    await service.recordCandidate({
      ...candidate,
      source: 'OCR',
      text: '',
      messageDisposition: 'KEEP',
    });
    expect(prisma.commercialReviewSample.upsert.mock.calls[0]![0].create.evidence.excerpt).toBe('');
    prisma.commercialReviewSample.upsert.mockRejectedValueOnce(
      new Error('sensitive upstream data'),
    );
    await expect(service.recordCandidate(candidate)).resolves.toBeUndefined();
  });
  it('defaults to pending samples and bounds cursor pages by the same priority ordering', async () => {
    const rows = [createRow(), createRow({ id: 'sample-2' })];
    const { prisma, service } = createService(rows);
    const first = await service.getQueue({ limit: 1 });
    expect(prisma.commercialReviewSample.findMany.mock.calls[0]![0]).toMatchObject({
      where: { label: null },
      take: 2,
      orderBy: [{ reviewPriority: 'desc' }, { observedAt: 'desc' }, { id: 'desc' }],
    });
    expect(first.items).toHaveLength(1);
    await service.getQueue({ limit: 1, cursor: first.nextCursor });
    expect(prisma.commercialReviewSample.findMany.mock.calls[1]![0].where.OR).toHaveLength(3);
    await expect(service.getQueue({ limit: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(service.getQueue({ cursor: 'bad-cursor' })).rejects.toMatchObject({ status: 400 });
  });
  it('rejects stale labels and the read/write race without writing an audit', async () => {
    const { prisma, service } = createService();
    await expect(
      service.labelItem('sample-1', 'owner', {
        expectedUpdatedAt: '2026-10-01T09:00:00.000Z',
        label: 'NOT_COMMERCIAL',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.commercialReviewSample.updateMany).not.toHaveBeenCalled();
    prisma.commercialReviewSample.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.labelItem('sample-1', 'owner', {
        expectedUpdatedAt: updatedAt.toISOString(),
        label: 'NOT_COMMERCIAL',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('writes the label and sanitized owner audit atomically without changing reputation or MAX state', async () => {
    const { prisma, service } = createService();
    const item = await service.labelItem('sample-1', 'owner', {
      expectedUpdatedAt: updatedAt.toISOString(),
      label: 'NOT_COMMERCIAL',
      reason: 'Личный контакт +7 999 123-45-67',
    });
    expect(item.label).toBe('NOT_COMMERCIAL');
    expect(item.reviewReason).not.toContain('999');
    expect(prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      actorUserId: 'owner',
      action: 'SAFETY_DESK_COMMERCIAL_LABEL',
      payload: { detectorVersion: 'v1', previousLabel: null, label: 'NOT_COMMERCIAL' },
    });
    expect(prisma.commercialReviewSample.updateMany.mock.calls[0]![0].where.updatedAt).toEqual(
      updatedAt,
    );
  });
  it('deletes only a bounded batch of expired samples using the expiry index', async () => {
    const { prisma, service } = createService([{ ...createRow(), expiresAt: new Date(0) }]);
    await expect(service.pruneExpired(25)).resolves.toBe(1);
    expect(prisma.commercialReviewSample.findMany.mock.calls[0]![0]).toMatchObject({
      take: 25,
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.commercialReviewSample.deleteMany.mock.calls[0]![0].where.id).toEqual({
      in: ['sample-1'],
    });
  });
});
