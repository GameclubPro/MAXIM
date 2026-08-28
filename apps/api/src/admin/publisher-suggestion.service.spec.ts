import { BadRequestException, ConflictException } from '@nestjs/common';
import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import {
  buildLegacyPublisherSuggestionPublicationRequestId,
  buildPublisherSuggestionPublicationRequestId,
  PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
  PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
} from './publisher-suggestion-review-protocol';

const user = {
  userId: 'admin-1',
  username: 'admin',
  displayName: 'Админ',
  avatarUrl: 'https://cdn.example/admin.png',
  profileUrl: 'https://max.ru/admin',
};

const otherUser = {
  userId: 'admin-2',
  username: 'editor',
  displayName: 'Редактор',
  avatarUrl: null,
  profileUrl: null,
};

function sqlText(query: { strings?: readonly string[] }): string {
  return query.strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function createClaimedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'suggest',
    text: '**Идея для поста\n\nПродолжение**',
    textFormat: 'markdown',
    authorDisplayName: 'Читатель',
    reviewStatus: 'publishing',
    reviewAction: 'publish',
    reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
    reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
    reviewPublicationRequestId: buildPublisherSuggestionPublicationRequestId(
      'suggestion-1',
      'claim-1',
    ),
    reviewClaimToken: 'claim-1',
    reviewClaimedAt: '2026-08-27T10:05:00.000Z',
    reviewClaimedByUserId: user.userId,
    reviewClaimedByUsername: user.username,
    reviewClaimedByDisplayName: user.displayName,
    reviewClaimedByAvatarUrl: user.avatarUrl,
    reviewClaimedByProfileUrl: user.profileUrl,
    ...overrides,
  };
}

function createFixture(payloadOverrides: Record<string, unknown> = {}) {
  let payload: Record<string, unknown> = {
    type: 'suggest',
    text: '**Идея для поста\n\nПродолжение**',
    textFormat: 'markdown',
    authorDisplayName: 'Читатель',
    reviewStatus: 'pending',
    ...payloadOverrides,
  };
  const row = () => ({
    id: 'suggestion-1',
    chatId: 'channel-1',
    payload,
    createdAt: new Date('2026-08-27T10:00:00.000Z'),
  });
  const auditLog = {
    findMany: jest.fn().mockImplementation(async () => [row()]),
    findFirst: jest.fn().mockImplementation(async () => row()),
    findFirstOrThrow: jest.fn().mockImplementation(async () => row()),
  };
  const prisma = {
    auditLog,
    publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const policy = { getEntity: jest.fn().mockResolvedValue({ id: 'channel-1' }) };
  const publications = {
    create: jest.fn().mockResolvedValue({ id: 'publication-1' }),
  };
  const publicationQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new PublisherSuggestionService(
    prisma as never,
    policy as never,
    publications as never,
    publicationQueue as never,
  );
  return {
    service,
    policy,
    prisma,
    publications,
    publicationQueue,
    row,
    setPayload(next: Record<string, unknown>) {
      payload = next;
    },
  };
}

describe('PublisherSuggestionService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('paginates pending work independently from newer history', async () => {
    const fixture = createFixture();
    const pendingRows = Array.from({ length: 26 }, (_, index) => ({
      ...fixture.row(),
      id: `pending-${String(index).padStart(3, '0')}`,
      createdAt: new Date(Date.UTC(2026, 7, 27, 10, 0, 25 - index)),
    }));
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 126 }] : pendingRows,
    );

    const result = await fixture.service.list('channel-1', user, {
      view: 'pending',
      limit: 25,
    });
    if (!('total' in result)) throw new Error('Expected paginated response');

    expect(fixture.policy.getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(result.items).toHaveLength(25);
    expect(result.total).toBe(126);
    expect(result.nextCursor).toEqual(expect.any(String));
    const pageSql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(pageSql).toContain("NOT IN ('published', 'cancelled')");
    expect(pageSql).toContain('ORDER BY created_at DESC, id DESC');
    expect(pageSql).toContain('LIMIT ?');
  });

  it('binds list cursors to the exact channel and view', async () => {
    const fixture = createFixture();
    const page = Array.from({ length: 26 }, (_, index) => ({
      ...fixture.row(),
      id: `pending-${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 27, 10, 0, 25 - index)),
    }));
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 26 }] : page,
    );
    const first = await fixture.service.list('channel-1', user, {
      view: 'pending',
      limit: 25,
    });
    if (!('nextCursor' in first)) throw new Error('Expected paginated response');

    await expect(
      fixture.service.list('channel-1', user, {
        view: 'history',
        limit: 25,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('falls back to plain text for legacy suggestions without a supported format', async () => {
    const fixture = createFixture({ textFormat: 'html' });
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 1 }] : [fixture.row()],
    );

    const result = await fixture.service.list('channel-1', user, { view: 'pending' });

    expect(result.items[0]).toHaveProperty('textFormat', 'plain');
  });

  it('keeps the old strict response shape for cached pre-pagination miniapps', async () => {
    const fixture = createFixture();

    const result = await fixture.service.list('channel-1', user, {});

    expect(result).toEqual({
      items: [
        {
          id: 'suggestion-1',
          text: '**Идея для поста\n\nПродолжение**',
          authorDisplayName: 'Читатель',
          createdAt: '2026-08-27T10:00:00.000Z',
          reviewStatus: 'pending',
          publicationId: null,
        },
      ],
    });
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('atomically claims a publish request and only enqueues it from the HTTP path', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload();
    jest.spyOn(fixture.service as any, 'claimPending').mockImplementation(async () => {
      fixture.setPayload(claimedPayload);
      return fixture.row();
    });

    const result = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
      responseVersion: 2,
    });

    expect(result.suggestion.reviewStatus).toBe('publishing');
    expect(result.suggestion).toEqual(
      expect.objectContaining({ textFormat: 'markdown', reviewError: null }),
    );
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith('suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('does not lose a durable claim when immediate queue enqueue fails', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload();
    jest.spyOn(fixture.service as any, 'claimPending').mockImplementation(async () => {
      fixture.setPayload(claimedPayload);
      return fixture.row();
    });
    fixture.publicationQueue.enqueue.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'publishing' }) });
  });

  it('rejects cancel once a publication claim exists', async () => {
    const fixture = createFixture(createClaimedPayload());

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', otherUser, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns a conflict when publish wins while a concurrent cancel is persisting', async () => {
    const fixture = createFixture();
    jest.spyOn(fixture.service as any, 'cancelPending').mockImplementation(async () => {
      fixture.setPayload(createClaimedPayload());
      return null;
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', otherUser, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects cancel for a pending row that still owns an exact durable claim', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewStatus: 'pending' }));
    const cancel = jest.spyOn(fixture.service as any, 'cancelPending');

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('returns a conflict when cancel wins while a concurrent publish is claiming', async () => {
    const fixture = createFixture();
    jest.spyOn(fixture.service as any, 'claimPending').mockImplementation(async () => {
      fixture.setPayload({ ...fixture.row().payload, reviewStatus: 'cancelled' });
      return null;
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.publicationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('is idempotent only for the same terminal review action', async () => {
    const published = createFixture({ reviewStatus: 'published', publicationId: 'publication-1' });

    await expect(
      published.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({
      suggestion: expect.objectContaining({ reviewStatus: 'published' }),
    });
    await expect(
      published.service.review('channel-1', 'suggestion-1', user, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps cached review clients on the legacy strict suggestion shape', async () => {
    const fixture = createFixture({
      reviewStatus: 'published',
      publicationId: 'publication-1',
    });

    const legacy = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
    });
    const current = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
      responseVersion: 2,
    });

    expect(legacy.suggestion).not.toHaveProperty('textFormat');
    expect(legacy.suggestion).not.toHaveProperty('reviewError');
    expect(current.suggestion).toEqual(
      expect.objectContaining({ textFormat: 'markdown', reviewError: null }),
    );
  });

  it('allows exactly one claim across two concurrent reviewers', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload();
    const claim = jest
      .spyOn(fixture.service as any, 'claimPending')
      .mockImplementation(async () => {
        fixture.setPayload(claimedPayload);
        return fixture.row();
      });

    const first = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
    });
    const second = await fixture.service.review('channel-1', 'suggestion-1', otherUser, {
      action: 'publish',
    });

    expect(first.suggestion.reviewStatus).toBe('publishing');
    expect(second.suggestion.reviewStatus).toBe('publishing');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(fixture.publicationQueue.enqueue).toHaveBeenNthCalledWith(2, 'suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
  });

  it('uses a SQL compare-and-set that claims only pending suggestions', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw.mockResolvedValue([]);

    await (fixture.service as any).claimPending('suggestion-1', 'channel-1', user);

    const sql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain(
      "COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') = 'pending'",
    );
    expect(sql).toContain("payload->>'reviewClaimToken' IS NULL");
    expect(sql).toContain('action = ?::text');
    expect(sql).toContain('RETURNING id');
  });

  it('publishes in the worker with the stored actor, stable request id and markdown format', async () => {
    const fixture = createFixture(createClaimedPayload());
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(fixture.publications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.userId, username: user.username }),
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
        intent: 'publish',
        content: expect.objectContaining({
          text: '**Идея для поста\n\nПродолжение**',
          textFormat: 'markdown',
        }),
        audience: expect.objectContaining({
          targets: [{ chatId: 'channel-1', entityType: 'channel' }],
        }),
      }),
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'suggestion-1' }),
      expect.objectContaining({ claimToken: 'claim-1' }),
      'publication-1',
    );
  });

  it('recovers a crash after publication creation without creating a duplicate', async () => {
    const fixture = createFixture(createClaimedPayload());
    fixture.publications.create.mockResolvedValue({ id: 'publication-existing' });
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');

    expect(fixture.publications.create).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
      }),
      'publication-existing',
    );
  });

  it('ignores a superseded worker token before idempotent publication creation', async () => {
    const fixture = createFixture(createClaimedPayload());

    await expect(
      fixture.service.processPublicationJob('suggestion-1', 'stale-token'),
    ).resolves.toBe(true);

    expect(fixture.prisma.publicationMutationRecord.findUnique).not.toHaveBeenCalled();
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('reconciles a pending row that still owns the exact migrated claim token', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewStatus: 'pending' }));
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(fixture.publications.create).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimToken: 'claim-1' }),
      'publication-1',
    );
  });

  it('releases an exact claim after a terminal create failure', async () => {
    const fixture = createFixture(createClaimedPayload());
    fixture.publications.create.mockRejectedValue(new BadRequestException('invalid content'));
    const release = jest
      .spyOn(fixture.service as any, 'releaseTerminalClaim')
      .mockResolvedValue(undefined as never);

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(release).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimToken: 'claim-1' }),
      'invalid content',
    );
  });

  it('clears a terminal exact claim from the pending recovery state', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewStatus: 'pending' }));
    fixture.publications.create.mockRejectedValue(new BadRequestException('invalid content'));

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(sqlText(fixture.prisma.$executeRaw.mock.calls[0]?.[0])).toContain(
      "payload->>'reviewStatus' IN ('publishing', 'pending')",
    );
  });

  it('keeps the exact claim for a retryable create failure', async () => {
    const fixture = createFixture(createClaimedPayload());
    const transient = new Error('database unavailable');
    fixture.publications.create.mockRejectedValue(transient);
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).rejects.toBe(
      transient,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('does not bind a colliding actor/request publication without request-hash validation', async () => {
    const fixture = createFixture(createClaimedPayload());
    const collision = new BadRequestException(
      'Ключ повтора уже использован для другого изменения.',
    );
    fixture.publications.create.mockRejectedValue(collision);
    fixture.prisma.publicationMutationRecord.findUnique.mockResolvedValue({
      publicationId: 'unrelated-publication',
    });
    const finalize = jest.spyOn(fixture.service as any, 'finalizeClaim');
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).rejects.toBe(
      collision,
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not release a terminal claim when publication absence cannot be proven', async () => {
    const fixture = createFixture(createClaimedPayload());
    const lookupFailure = new Error('publication lookup unavailable');
    fixture.prisma.publicationMutationRecord.findUnique.mockRejectedValueOnce(lookupFailure);
    fixture.publications.create.mockRejectedValue(new BadRequestException('invalid content'));
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).rejects.toBe(
      lookupFailure,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('leaves legacy queue claims to the existing channel-dialog processor', async () => {
    const fixture = createFixture({
      ...createClaimedPayload(),
      reviewPublicationProtocol: 'max_action_ledger_v1',
    });

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      false,
    );
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('upgrades a pre-deploy inline publishing claim to the durable queue protocol', async () => {
    const legacyPayload = {
      type: 'suggest',
      text: 'Старая предложка',
      reviewStatus: 'publishing',
      reviewedAt: '2026-08-27T10:05:00.000Z',
      reviewedByUserId: user.userId,
    };
    const fixture = createFixture(legacyPayload);
    const migratedPayload = {
      ...legacyPayload,
      reviewAction: 'publish',
      reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
      reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
      reviewPublicationRequestId:
        buildLegacyPublisherSuggestionPublicationRequestId('suggestion-1'),
      reviewClaimToken: 'migrated-claim-1',
      reviewClaimedAt: legacyPayload.reviewedAt,
      reviewClaimedByUserId: user.userId,
      reviewClaimMigratedFrom: 'inline_v0',
    };
    jest.spyOn(fixture.service as any, 'migrateLegacyInlineClaim').mockImplementation(async () => {
      fixture.setPayload(migratedPayload);
      return fixture.row();
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'publishing' }) });
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith(
      'suggestion-1',
      'migrated-claim-1',
      { recycleCompleted: true },
    );
  });

  it('migrates only the exact legacy inline reviewer and timestamp claim', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw.mockResolvedValue([]);
    const row = {
      ...fixture.row(),
      payload: {
        ...fixture.row().payload,
        reviewStatus: 'publishing',
        reviewedAt: '2026-08-27T10:05:00.000Z',
        reviewedByUserId: user.userId,
      },
    };

    await (fixture.service as any).migrateLegacyInlineClaim(row, row.payload, user);

    const sql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("payload->>'reviewPublicationProtocol' IS NULL");
    expect(sql).toContain("payload->>'reviewedByUserId' = ?::text");
    expect(sql).toContain("payload->>'reviewedAt' = ?::text");
  });

  it('does not migrate a recent inline claim that an old HTTP worker can still own', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const fixture = createFixture();
    const row = {
      ...fixture.row(),
      payload: {
        ...fixture.row().payload,
        reviewStatus: 'publishing',
        reviewedAt: '2026-08-27T11:55:00.000Z',
        reviewedByUserId: user.userId,
      },
    };

    await expect(
      (fixture.service as any).migrateLegacyInlineClaim(row, row.payload, user),
    ).resolves.toBeNull();
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('falls through when the job belongs to the legacy audit-log action', async () => {
    const fixture = createFixture();
    fixture.prisma.auditLog.findFirst.mockResolvedValue(null);

    await expect(
      fixture.service.processPublicationJob('legacy-suggestion', 'claim-1'),
    ).resolves.toBe(false);
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });
});
