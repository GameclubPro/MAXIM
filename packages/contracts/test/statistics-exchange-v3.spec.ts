import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_V3_CAPABILITIES,
  EXCHANGE_V3_STATISTICS_PAGE_BYTES,
  exchangeV3AccessPageSchema,
  exchangeV3AccessQuerySchema,
  exchangeV3CapabilitiesSchema,
  exchangeV3ContentCanonical,
  exchangeV3ContentSchema,
  exchangeV3EnvelopeBytes,
  exchangeV3GrantInputSchema,
  exchangeV3MembershipManifestSchema,
  exchangeV3MembershipPageSchema,
  exchangeV3MetadataResponseSchema,
  exchangeV3ScopeSchema,
  exchangeV3ScopeSummarySchema,
  exchangeV3StatisticsPageSchema,
  validateExchangeV3Head,
  validateExchangeV3StatisticsPage,
  type ExchangeV3Content,
  type ExchangeV3Head,
} from '../src/statistics-exchange-v3.js';

const id = '00000000-0000-4000-8000-000000000001';
const bucket = '2026-10-20T00:00:00.000Z';
const until = '2026-10-21T00:00:00.000Z';
const now = Date.parse(until);
const summary = {
  metric: 'REACH' as const,
  horizon: 0 as const,
  coverageFrom: bucket,
  coverageUntil: until,
  complete: true,
  population: 'NONEMPTY' as const,
  proofObservedAt: until,
};
function content(): ExchangeV3Content {
  return {
    generationId: id,
    contentHash: '0'.repeat(64),
    producerRevision: 1,
    origin: 'MAXIM',
    method: 'utc-buckets-v1',
    from: bucket,
    to: until,
    asOf: until,
    rowCount: 1,
    pageCount: 1,
    sha256: '0'.repeat(64),
    scopes: [{ ...summary }],
    horizonToleranceSeconds: 900,
  };
}
function head(): ExchangeV3Head {
  return {
    version: 3,
    grantId: id,
    grantRevision: 1,
    bindingId: id,
    bindingRevision: 1,
    entityId: '-123',
    kind: 'CHANNEL',
    content: content(),
    unchanged: false,
    health: [
      {
        metric: 'REACH',
        horizon: 0,
        checkedAt: until,
        lastObservationAt: until,
        nextExpectedAt: null,
        errorCode: null,
      },
    ],
    access: { checkedAt: until, validUntil: '2026-10-21T00:05:00.000Z', accessRevision: 1 },
  };
}
function page() {
  return {
    version: 3,
    generationId: id,
    contentHash: '0'.repeat(64),
    pageIndex: 0,
    rows: [
      {
        origin: 'MAXIM',
        method: 'utc-buckets-v1',
        revision: 1,
        data: {
          metric: 'REACH',
          horizon: 0,
          bucket,
          observedAt: until,
          posts: 1,
          samples: 1,
          views: 100,
          incomplete: false,
          maxDelaySeconds: null as number | null,
        },
      },
    ],
    nextPageIndex: null,
  };
}

describe('parallel v3 statistics contract', () => {
  it('allows explicit supported-v2 capability negotiation without treating a failed request as unsupported', () => {
    expect(
      exchangeV3CapabilitiesSchema.parse({ ...EXCHANGE_V3_CAPABILITIES, supportedVersions: [2] })
        .supportedVersions,
    ).toEqual([2]);
    expect(
      exchangeV3CapabilitiesSchema.safeParse({
        ...EXCHANGE_V3_CAPABILITIES,
        supportedVersions: [3, 3],
      }).success,
    ).toBe(false);
  });
  it('requires horizon only for reach and accepts independent 0/24/48 scopes', () => {
    for (const horizon of [0, 24, 48])
      expect(exchangeV3ScopeSchema.parse({ metric: 'REACH', horizon })).toEqual({
        metric: 'REACH',
        horizon,
      });
    expect(exchangeV3ScopeSchema.safeParse({ metric: 'REACH' }).success).toBe(false);
    expect(exchangeV3ScopeSchema.safeParse({ metric: 'AUDIENCE', horizon: 0 }).success).toBe(false);
  });
  it('keeps real scope coverage narrower than a newer unrelated observation', () => {
    const value = content();
    value.to = value.asOf = '2026-10-21T01:00:00.000Z';
    expect(exchangeV3ContentSchema.parse(value).scopes[0]).toEqual(summary);
    value.scopes[0]!.coverageUntil = '2026-10-22T00:00:00.000Z';
    expect(exchangeV3ContentSchema.safeParse(value).success).toBe(false);
  });
  it('rejects empty/complete coverage without actual native proof or a bounded interval', () => {
    expect(
      exchangeV3ScopeSummarySchema.safeParse({
        ...summary,
        population: 'EMPTY',
        proofObservedAt: null,
      }).success,
    ).toBe(false);
    expect(
      exchangeV3ScopeSummarySchema.safeParse({ ...summary, coverageUntil: null }).success,
    ).toBe(false);
    expect(
      exchangeV3ScopeSummarySchema.safeParse({
        ...summary,
        metric: 'AUDIENCE',
        horizon: undefined,
        population: 'EMPTY',
      }).success,
    ).toBe(false);
    expect(
      exchangeV3ScopeSummarySchema.safeParse({ ...summary, population: 'EMPTY' }).success,
    ).toBe(true);
  });
  it('hashes stable explicit content properties and every coverage correction', () => {
    const a = content(),
      b = {
        ...a,
        generationId: '00000000-0000-4000-8000-000000000002',
        contentHash: '1'.repeat(64),
      };
    const digest = (v: ExchangeV3Content) =>
      createHash('sha256').update(exchangeV3ContentCanonical(v)).digest('hex');
    expect(digest(a)).toBe(digest(b));
    b.scopes = [{ ...summary, coverageUntil: '2026-10-20T23:00:00.000Z' }];
    expect(digest(a)).not.toBe(digest(b));
    expect(exchangeV3ContentCanonical({ ...a, sha256: '2'.repeat(64) })).not.toBe(
      exchangeV3ContentCanonical(a),
    );
  });
  it('checks fresh health independently from the frozen content clock and rejects future proofs', () => {
    const value = head();
    value.health[0]!.checkedAt = '2026-10-21T00:01:00.000Z';
    value.access.checkedAt = value.health[0]!.checkedAt!;
    expect(validateExchangeV3Head(value, now + 60000)).toEqual(value);
    expect(() => validateExchangeV3Head(value, now)).toThrow(
      'Invalid exchange v3 observation time',
    );
    value.health[0]!.checkedAt = until;
    expect(() => validateExchangeV3Head(value, now)).toThrow(
      'Invalid exchange v3 observation time',
    );
  });
  it('does not accept unchanged=true without the caller pinned material hash', () => {
    const value = { ...head(), unchanged: true };
    expect(() => validateExchangeV3Head(value, now)).toThrow(
      'Invalid exchange v3 conditional identity',
    );
    expect(validateExchangeV3Head(value, now, '0'.repeat(64)).unchanged).toBe(true);
  });
  it('pins immutable page identity, UTC rows and exact reach horizon', () => {
    expect(validateExchangeV3StatisticsPage(page(), head(), now).rows).toHaveLength(1);
    const different = page();
    different.rows[0]!.data.horizon = 24;
    different.rows[0]!.data.maxDelaySeconds = 0;
    expect(() => validateExchangeV3StatisticsPage(different, head(), now)).toThrow(
      'Invalid exchange v3 metric scope',
    );
    expect(() =>
      validateExchangeV3StatisticsPage(
        { ...page(), generationId: '00000000-0000-4000-8000-000000000002' },
        head(),
        now,
      ),
    ).toThrow('Invalid exchange v3 page identity');
  });
  it('rejects semantic duplicate rows while preserving producer timestamp spelling', () => {
    const value = page(),
      alias = {
        ...value.rows[0]!,
        data: { ...value.rows[0]!.data, bucket: '2026-10-20T00:00:00Z' },
      };
    const h = head();
    h.content!.rowCount = 2;
    expect(() =>
      validateExchangeV3StatisticsPage({ ...value, rows: [value.rows[0], alias] }, h, now),
    ).toThrow('Invalid exchange measurement identity or interval');
  });
  it('checks serialized UTF-8 envelopes instead of accepting schema-valid oversized timestamp payloads', () => {
    const value = page();
    value.rows = Array.from({ length: 200 }, () => ({
      ...value.rows[0]!,
      data: { ...value.rows[0]!.data, observedAt: `2026-10-21T00:00:00.${'0'.repeat(1000)}Z` },
    }));
    expect(exchangeV3EnvelopeBytes(value)).toBeGreaterThan(EXCHANGE_V3_STATISTICS_PAGE_BYTES);
    expect(exchangeV3StatisticsPageSchema.safeParse(value).success).toBe(false);
  });
});

describe('v3 bounded membership and access', () => {
  const entity = { entityId: '-123', kind: 'CHANNEL' as const, profile: 'moderation' as const };
  const membership = {
    version: 3,
    snapshotId: id,
    actorUserId: '123',
    membershipRevision: 1,
    entityCount: 200,
    pageCount: 2,
    sha256: '0'.repeat(64),
    createdAt: bucket,
    expiresAt: until,
  };
  it('does not impose a total 100-platform roster limit or accept incomplete empty snapshots', () => {
    expect(exchangeV3MembershipManifestSchema.parse(membership).entityCount).toBe(200);
    expect(
      exchangeV3MembershipManifestSchema.safeParse({ ...membership, entityCount: 0, pageCount: 1 })
        .success,
    ).toBe(false);
    expect(
      exchangeV3MembershipPageSchema.safeParse({
        version: 3,
        snapshotId: id,
        membershipRevision: 1,
        pageIndex: 0,
        entities: [],
        nextPageIndex: 1,
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate platform profiles and changed page numbering', () => {
    const p = {
      version: 3,
      snapshotId: id,
      membershipRevision: 1,
      pageIndex: 0,
      entities: [entity, { ...entity, profile: 'publisher' }],
      nextPageIndex: 1,
    };
    expect(exchangeV3MembershipPageSchema.safeParse(p).success).toBe(false);
    expect(
      exchangeV3MembershipPageSchema.safeParse({ ...p, entities: [entity], nextPageIndex: 2 })
        .success,
    ).toBe(false);
  });
  it('uses exact access filters as a mutual pair without a sweep cursor', () => {
    expect(exchangeV3AccessQuerySchema.parse({ entityId: '-123', kind: 'CHANNEL' })).toEqual({
      entityId: '-123',
      kind: 'CHANNEL',
    });
    expect(exchangeV3AccessQuerySchema.safeParse({ entityId: '-123' }).success).toBe(false);
    expect(
      exchangeV3AccessQuerySchema.safeParse({ entityId: '-123', kind: 'CHANNEL', cursor: '' })
        .success,
    ).toBe(false);
  });
  it('keeps profiles out of access bodies and rejects unbounded UTF-8 URLs', () => {
    const access = {
      version: 3,
      grantId: id,
      grantRevision: 1,
      accessRevision: 1,
      entities: [],
      nextCursor: null,
    };
    expect(
      exchangeV3AccessPageSchema.safeParse({ ...access, metadata: { description: 'private' } })
        .success,
    ).toBe(false);
    const metadata = {
      title: 'Канал 😀',
      description: 'Описание',
      imageUrl: null,
      publicUrl: `https://example.com/${'я'.repeat(3000)}`,
      audience: 100,
      isPublic: true,
    };
    expect(
      exchangeV3MetadataResponseSchema.safeParse({
        version: 3,
        metadataVersion: '0'.repeat(64),
        changed: true,
        metadata,
      }).success,
    ).toBe(false);
  });
  it('allows a compact CAS advance across skipped local revisions without replay TTL extension', () => {
    const value = {
      version: 3,
      requestId: id,
      grantId: id,
      actorUserId: '123',
      expectedRevision: 1,
      revision: 3,
      state: 'ACTIVE',
      membershipSnapshot: { snapshotId: id, membershipRevision: 1, sha256: '0'.repeat(64) },
    };
    expect(exchangeV3GrantInputSchema.parse(value).revision).toBe(3);
    expect(exchangeV3GrantInputSchema.safeParse({ ...value, revision: 1 }).success).toBe(false);
    expect(exchangeV3GrantInputSchema.safeParse({ ...value, state: 'REVOKED' }).success).toBe(
      false,
    );
  });
});
