import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { exchangeMeasurementSchema } from '@maxim/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService, marketplaceLocalGrantSql } from './marketplace-state.service';
import { statisticsExchangeActorAllowed } from './statistics-exchange.settings';
import { exchangeRetentionFrom } from './statistics-exchange-values';

export type StatisticsExchangeAudienceObservation = { capturedAt: Date; participantsCount: number };

@Injectable()
export class StatisticsExchangeAudienceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly state: MarketplaceStateService,
  ) {}

  async importedAudience(
    actor: string,
    entityId: string,
    kind: 'CHAT' | 'CHANNEL',
  ): Promise<StatisticsExchangeAudienceObservation[]> {
    if (!statisticsExchangeActorAllowed(this.config, actor)) return [];
    const projections = await this.prisma.$queryRaw<
      Array<{
        id: string;
        revision: bigint;
        binding_id: string;
        remote_binding_id: string;
        rows: unknown;
      }>
    >`
      SELECT g.id,g.revision,b.id AS binding_id,e.remote_binding_id,p.rows FROM statistics_exchange_grants g
      JOIN statistics_exchange_entities e ON e.grant_id=g.id
      JOIN marketplace_bindings b ON b.id=e.binding_id
      JOIN statistics_exchange_imports p ON p.grant_id=g.id AND p.grant_revision=g.revision AND p.entity_id=e.entity_id AND p.kind=e.kind
      WHERE g.actor_user_id=${actor} AND g.state='ACTIVE' AND e.entity_id=${entityId} AND e.kind=${kind}
        AND e.remote_valid_until>now() AND p.remote_valid_until>now() AND e.remote_binding_id::text=p.manifest->>'bindingId'
        AND b.actor_user_id=${actor} AND b.entity_id=${entityId} AND b.kind=${kind} AND ${marketplaceLocalGrantSql('b')}`;
    const projection = projections[0];
    if (!projection) return [];
    if (!(await this.state.hasActiveGrant(projection.binding_id)))
      throw new ConflictException('Доступ изменился');
    const observations = z
      .array(exchangeMeasurementSchema)
      .max(3000)
      .parse(projection.rows)
      .flatMap((row) =>
        row.origin === 'EXCHANGE' &&
        row.data.bucket >= exchangeRetentionFrom() &&
        row.data.metric === 'AUDIENCE' &&
        row.data.value !== null &&
        row.data.observedAt
          ? [{ capturedAt: new Date(row.data.observedAt), participantsCount: row.data.value }]
          : [],
      )
      .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    // FLAG: Analytics reads publish no generation and recheck exact grant revision after loading data.
    const current = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT g.id FROM statistics_exchange_grants g JOIN statistics_exchange_entities e ON e.grant_id=g.id
      JOIN marketplace_bindings b ON b.id=e.binding_id
      JOIN statistics_exchange_imports p ON p.grant_id=g.id AND p.grant_revision=g.revision AND p.entity_id=e.entity_id AND p.kind=e.kind
      WHERE g.id=${projection.id}::uuid AND g.actor_user_id=${actor} AND g.state='ACTIVE' AND g.revision=${projection.revision}
        AND e.entity_id=${entityId} AND e.kind=${kind} AND e.remote_valid_until>now() AND e.remote_binding_id=${projection.remote_binding_id}::uuid AND p.remote_valid_until>now() AND e.remote_binding_id::text=p.manifest->>'bindingId' AND b.id=${projection.binding_id}::uuid AND ${marketplaceLocalGrantSql('b')}`;
    if (!current[0]) throw new ConflictException('Доступ изменился');
    return observations;
  }
}
