import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { MarketplaceProfileRelayResponse } from '@maxim/contracts/marketplace-integration';
import type { StatsSummaryResult } from '@maxim/contracts/statistics-central';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StatsReadService } from '../../statistics/stats-read.service';
import { summarizeStats } from '../../statistics/stats-selector';
import type { StatsCandidate } from '../../statistics/stats-types';
import type { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceProfileService } from './marketplace-profile.service';
import { MarketplaceStateService, type MarketplaceBindingRow } from './marketplace-state.service';

function fixture(central = true, summary?: StatsSummaryResult) {
  const config = new ConfigService({
    STATISTICS_CENTRAL_ENABLED: central,
    STATISTICS_CENTRAL_MODE: central ? 'CENTRAL' : 'LEGACY',
  });
  const binding: MarketplaceBindingRow = {
    id: randomUUID(),
    actor_user_id: '323459159',
    entity_id: '-100',
    kind: 'CHANNEL',
    profile: 'moderation',
    bot_id: 'native-fixture-bot',
    state: 'ACTIVE',
    revision: 1,
    checked_at: new Date(),
    valid_until: new Date(Date.now() + 300_000),
    updated_at: new Date(),
    generation_id: null,
    statistics_checked_at: null,
    native_history_checked_at: null,
    native_full_checked_at: null,
    native_audience_checked_at: null,
    history_complete: false,
    history_from: null,
    history_to: null,
    history_cursor: null,
    history_signature: null,
    discovery_from: null,
    discovery_to: null,
    history_anomaly: false,
    statistics_consent: false,
    statistics_revoked_at: null,
    collection_owner: 'SHADOW',
    collection_metrics: [],
    append_enabled: false,
    append_revision: 1,
    profile_revision: 1,
    profile_snapshot: null,
    public_url: null,
    public_verified_until: null,
    button_diagnostic: null,
    next_collect_at: new Date(),
    next_access_at: new Date(),
    lease_id: null,
    lease_until: null,
    metadata: {
      title: 'Native fixture',
      description: '',
      imageUrl: null,
      publicUrl: null,
      audience: 0,
      isPublic: false,
    },
  };
  const prisma = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
  const access: Pick<MarketplaceAccessService, 'attest'> = {
    attest: jest
      .fn<
        ReturnType<MarketplaceAccessService['attest']>,
        Parameters<MarketplaceAccessService['attest']>
      >()
      .mockResolvedValue(binding),
  };
  const state = new MarketplaceStateService(prisma as unknown as PrismaService, config);
  const centralStats: Pick<StatsReadService, 'localSummary'> = {
    localSummary: jest
      .fn<
        ReturnType<StatsReadService['localSummary']>,
        Parameters<StatsReadService['localSummary']>
      >()
      .mockImplementation(async () => {
        if (!summary) throw new Error('Fixture reader unavailable');
        return summary;
      }),
  };
  const service = new MarketplaceProfileService(
    prisma as unknown as PrismaService,
    config,
    state,
    access as MarketplaceAccessService,
    centralStats as StatsReadService,
  );
  const remote: MarketplaceProfileRelayResponse = {
    bindingId: binding.id,
    entityId: binding.entity_id,
    kind: binding.kind,
    revision: 1,
    listing: null,
    choices: { topics: ['Тест'], regions: ['Тест'] },
    capabilities: {
      canEdit: true,
      canPublish: true,
      canPause: false,
      publicState: 'DRAFT',
      placementState: 'BOT_REQUIRED',
      connectUrl: 'https://max.ru/test',
      manageUrl: null,
    },
  };
  const relay = jest.spyOn(service, 'relay').mockResolvedValue(remote);
  return { binding, prisma, service, relay, centralStats };
}

function summaryFixture(rows: StatsCandidate[] = []): StatsSummaryResult {
  return {
    contractVersion: 1,
    asOf: '2026-10-24T10:00:00.000Z',
    nextCursor: null,
    results: [
      {
        contextId: randomUUID(),
        entity: { kind: 'CHANNEL', maxId: '-100' },
        periodDays: 90,
        status: 'READY',
        revision: { canonicalRevision: '1', entityRevision: '1', selectorVersion: 1 },
        access: {
          viewId: randomUUID(),
          sourceAuthorityDependencies: [],
          validUntil: '2026-10-24T10:05:00.000Z',
        },
        summary: summarizeStats(rows, 90, 'CHANNEL', ['AUDIENCE'], [0]),
      },
    ],
  };
}

function audience(producer: 'MAXIM' | 'EXCHANGE', day: string, value: number): StatsCandidate {
  const observedAt = `${day}T12:00:00.000Z`;
  return {
    producer,
    scope: { metric: 'AUDIENCE', horizon: 0, method: { id: 'AUDIENCE_SNAPSHOT', version: 1 }, day },
    value: { value, observedAt },
    coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
    health: {
      state: 'OK',
      lastAttemptAt: null,
      lastSuccessAt: observedAt,
      nextExpectedAt: null,
      errorCode: null,
    },
  };
}

describe('central statistics and ordinary marketplace profile policy', () => {
  it('does not read copied generations or change legacy policy to show ordinary central availability', async () => {
    const f = fixture();
    const result = await f.service.get('323459159', 'CHANNEL', '-100', 'moderation');
    expect(result.binding.statisticsConsent).toBe(false);
    expect(result.statistics?.state).toBe('PENDING');
    expect(f.binding.statistics_consent).toBe(false);
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('presents merged measured history through ordinary profile fields without provider metadata', async () => {
    const f = fixture(
      true,
      summaryFixture([audience('MAXIM', '2026-10-22', 15), audience('EXCHANGE', '2026-10-23', 0)]),
    );
    const result = await f.service.get('323459159', 'CHANNEL', '-100', 'moderation');
    expect(f.centralStats.localSummary).toHaveBeenCalledWith(
      { kind: 'CHANNEL', maxId: '-100' },
      '323459159',
      'native-fixture-bot',
      90,
    );
    expect(result.statistics).toEqual({
      state: 'AVAILABLE',
      observedDays: 2,
      lastObservedAt: '2026-10-23T12:00:00.000Z',
      from: '2026-07-27T00:00:00.000Z',
      to: '2026-10-24T10:00:00.000Z',
    });
    expect(JSON.stringify(result.statistics)).not.toMatch(
      /MAXIM|EXCHANGE|producer|authority|consent/i,
    );
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('distinguishes an authorized empty history from a failed ordinary statistics read', async () => {
    const empty = fixture(true, summaryFixture());
    expect(
      (await empty.service.get('323459159', 'CHANNEL', '-100', 'moderation')).statistics,
    ).toMatchObject({ state: 'EMPTY', observedDays: 0, lastObservedAt: null });
    const unavailable = fixture();
    expect(
      (await unavailable.service.get('323459159', 'CHANNEL', '-100', 'moderation')).statistics,
    ).toEqual({ state: 'PENDING', observedDays: 0, lastObservedAt: null, from: null, to: null });
  });

  it.each(['save', 'publish'] as const)(
    'allows %s without a separate analytics confirmation after CENTRAL cutover',
    async (action) => {
      const f = fixture();
      const input = {
        action,
        requestId: randomUUID(),
        expectedRevision: 1,
        ...(action === 'save'
          ? { details: { title: 'Fixture', description: '', topic: 'Тест', region: 'Тест' } }
          : {}),
      };
      const result = await f.service.mutate('323459159', 'CHANNEL', '-100', 'moderation', input);
      expect(f.relay).toHaveBeenCalledWith(f.binding, input);
      expect(result.binding.statisticsConsent).toBe(false);
      expect(result.statistics?.state).toBe('PENDING');
      expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each(['save', 'publish'] as const)(
    'keeps an explicit profile revoke authoritative for %s even after passive access recovery',
    async (action) => {
      const f = fixture();
      f.binding.statistics_revoked_at = new Date();
      const input = {
        action,
        requestId: randomUUID(),
        expectedRevision: 1,
        ...(action === 'save'
          ? { details: { title: 'Fixture', description: '', topic: 'Тест', region: 'Тест' } }
          : {}),
      };
      const read = await f.service.get('323459159', 'CHANNEL', '-100', 'moderation');
      expect(read.statistics?.state).toBe('DISABLED');
      expect(f.centralStats.localSummary).not.toHaveBeenCalled();
      f.relay.mockClear();
      await expect(
        f.service.mutate('323459159', 'CHANNEL', '-100', 'moderation', input),
      ).rejects.toThrow('Профиль пока недоступен');
      expect(f.relay).not.toHaveBeenCalled();
    },
  );

  it('preserves pre-cutover consent requirements and allows hiding an explicitly revoked profile', async () => {
    const old = fixture(false);
    await expect(
      old.service.mutate('323459159', 'CHANNEL', '-100', 'moderation', {
        action: 'publish',
        requestId: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toThrow('Профиль пока недоступен');
    const current = fixture();
    current.binding.statistics_revoked_at = new Date();
    await expect(
      current.service.mutate('323459159', 'CHANNEL', '-100', 'moderation', {
        action: 'pause',
        requestId: randomUUID(),
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      binding: { statisticsConsent: false },
      statistics: { state: 'DISABLED' },
    });
  });
});
