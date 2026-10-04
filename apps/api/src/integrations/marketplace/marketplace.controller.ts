import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  marketplaceBindingsPageSchema,
  marketplaceProfileSchema,
  type MarketplaceProfileState,
  marketplaceStatisticsManifestSchema,
} from '@maxim/contracts/marketplace-integration';
import { InitDataGuard } from '../../auth/init-data.guard';
import { MiniappProfiles } from '../../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceIntegrationGuard } from './marketplace-integration.guard';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceProfileService } from './marketplace-profile.service';
import {
  MarketplaceStateService,
  marketplaceLocalGrantSql,
  type MarketplaceBindingRow,
} from './marketplace-state.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';

const uuid = z.string().uuid();
const handoffSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    generationId: uuid,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    metrics: z
      .array(z.enum(['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR']))
      .min(1)
      .max(4),
  })
  .strict();
@Controller('v1/integrations/svyazka/v1')
@UseGuards(MarketplaceIntegrationGuard)
export class MarketplaceIntegrationController {
  constructor(
    private readonly access: MarketplaceAccessService,
    private readonly state: MarketplaceStateService,
    private readonly statistics: MarketplaceStatisticsService,
    private readonly prisma: PrismaService,
  ) {}
  @Post('bindings') async create(@Body() input: unknown) {
    return this.state.present(await this.access.attest(input));
  }
  @Get('bindings/changes') async changes(@Query() raw: unknown) {
    const query = z.object({ cursor: uuid.optional() }).strict().parse(raw);
    const cursor = query.cursor ?? '00000000-0000-0000-0000-000000000000';
    const rows = await this.prisma.$queryRaw<
      Array<MarketplaceBindingRow & { grant_valid: boolean }>
    >`SELECT b.*,(${marketplaceLocalGrantSql('b')}) AS grant_valid FROM marketplace_bindings b WHERE b.id>${cursor}::uuid ORDER BY b.id LIMIT 101`;
    return marketplaceBindingsPageSchema.parse({
      bindings: rows.slice(0, 100).map((row) => {
        const denied = row.state === 'ACTIVE' && row.statistics_consent && !row.grant_valid;
        return this.state.present({
          ...row,
          state: denied ? 'UNKNOWN' : row.state,
          valid_until: denied ? null : row.valid_until,
        });
      }),
      nextCursor: rows.length > 100 ? rows[99]!.id : null,
    });
  }
  @Get('bindings/:id') async get(@Param('id') raw: string) {
    const row = await this.state.read(uuid.parse(raw));
    if (!row) throw new NotFoundException();
    const denied =
      row.state === 'ACTIVE' &&
      row.statistics_consent &&
      !(await this.state.hasActiveGrant(row.id));
    return this.state.present({
      ...row,
      state: denied ? 'UNKNOWN' : row.state,
      valid_until: denied ? null : row.valid_until,
    });
  }
  @Post('bindings/:id/recheck') async recheck(@Param('id') raw: string) {
    const row = await this.state.read(uuid.parse(raw));
    if (!row) throw new NotFoundException();
    return this.state.present(
      await this.access.attest({
        actorUserId: row.actor_user_id,
        entityId: row.entity_id,
        kind: row.kind,
        profile: row.profile,
      }),
    );
  }
  @Delete('bindings/:id')
  async revoke(@Param('id') raw: string, @Query() rawQuery: unknown) {
    const id = uuid.parse(raw);
    const input = z
      .object({ requestId: uuid, expectedRevision: z.coerce.number().int().nonnegative() })
      .strict()
      .parse(rawQuery);
    const hash = createHash('sha256')
      .update(JSON.stringify({ action: 'integration_revoke', id, ...input }))
      .digest('hex');
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        MarketplaceBindingRow[]
      >`SELECT * FROM marketplace_bindings WHERE id=${id}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException();
      const previous = await tx.$queryRaw<
        Array<{ binding_id: string; payload_hash: string; result: unknown }>
      >`SELECT * FROM marketplace_policy_requests WHERE request_id=${input.requestId}::uuid`;
      if (previous[0]) {
        if (previous[0].binding_id !== id || previous[0].payload_hash !== hash)
          throw new ConflictException('Идентификатор запроса уже использован');
        return z
          .object({ revoked: z.literal(true) })
          .strict()
          .parse(previous[0].result);
      }
      if (rows[0].revision !== input.expectedRevision)
        throw new ConflictException('Привязка изменилась');
      await tx.$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',statistics_consent=false,append_enabled=false,
        valid_until=NULL,public_verified_until=NULL,lease_id=NULL,lease_until=NULL,checked_at=now(),revision=revision+1,append_revision=append_revision+1,updated_at=now()
        WHERE id=${id}::uuid AND (state<>'REVOKED' OR statistics_consent=true OR append_enabled=true OR lease_id IS NOT NULL OR valid_until IS NOT NULL OR public_verified_until IS NOT NULL)`;
      const result = { revoked: true as const };
      await tx.$executeRaw`INSERT INTO marketplace_policy_requests(request_id,binding_id,payload_hash,result) VALUES(${input.requestId}::uuid,${id}::uuid,${hash},${JSON.stringify(result)}::jsonb)`;
      return result;
    });
  }
  @Get('bindings/:id/statistics') statisticsPage(
    @Param('id') raw: string,
    @Query() query: unknown,
  ) {
    return this.statistics.page(uuid.parse(raw), query);
  }
  @Post('bindings/:id/handoff') async handoff(@Param('id') raw: string, @Body() body: unknown) {
    const id = uuid.parse(raw);
    const input = handoffSchema.parse(body);
    const generation = await this.prisma.$queryRaw<
      Array<{ manifest: unknown; rows: unknown }>
    >`SELECT manifest,rows FROM marketplace_statistics_generations WHERE id=${input.generationId}::uuid AND binding_id=${id}::uuid`;
    if (!generation[0]) throw new ConflictException('Выгрузка не найдена');
    const manifest = marketplaceStatisticsManifestSchema.parse(generation[0].manifest);
    const rows = z
      .array(
        z.object({
          metric: z.string(),
          incomplete: z.boolean().optional(),
          complete: z.boolean().optional(),
          value: z.number().nullable().optional(),
        }),
      )
      .parse(generation[0].rows);
    if (!manifest.complete || manifest.sha256 !== input.sha256)
      throw new ConflictException('Выгрузка не готова к переключению');
    for (const metric of input.metrics) {
      const points = rows.filter((row) => row.metric === metric);
      if (
        !points.length ||
        points.some((point) => point.incomplete === true || point.complete === false) ||
        (metric === 'AUDIENCE' &&
          (points.length < 90 || points.some((point) => point.value === null)))
      )
        throw new ConflictException('Недостаточно подтверждённых измерений');
    }
    const changed = await this.prisma
      .$executeRaw`UPDATE marketplace_bindings SET collection_owner='MAXIM',collection_metrics=${JSON.stringify([...new Set(input.metrics)])}::jsonb,
      revision=revision+1,updated_at=now() WHERE id=${id}::uuid AND revision=${input.expectedRevision} AND generation_id=${input.generationId}::uuid
      AND ${marketplaceLocalGrantSql()} AND history_complete=true AND history_cursor IS NULL AND history_anomaly=false AND statistics_checked_at>now()-interval '5 minutes'`;
    if (!changed) {
      const current = await this.state.read(id);
      if (
        !current ||
        !(await this.state.hasActiveGrant(id)) ||
        current.collection_owner !== 'MAXIM' ||
        current.generation_id !== input.generationId ||
        current.state !== 'ACTIVE' ||
        !current.statistics_consent ||
        !current.valid_until ||
        current.valid_until.getTime() <= Date.now() ||
        !current.statistics_checked_at ||
        Date.now() - current.statistics_checked_at.getTime() > 5 * 60_000 ||
        JSON.stringify([...z.array(z.string()).parse(current.collection_metrics)].sort()) !==
          JSON.stringify([...new Set(input.metrics)].sort())
      )
        throw new ConflictException('Привязка изменилась');
    }
    return this.get(id);
  }
}

@Controller('v1/marketplace')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class MarketplaceProfileController {
  constructor(private readonly profiles: MarketplaceProfileService) {}
  @Get('capability') capability(@CurrentUser() user: AuthUser) {
    return this.profiles.capability(user.userId);
  }
  @Get('entities/:kind/:entityId/profile') async get(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Param('entityId') id: string,
    @Query('profile') profile: unknown,
    @Req() request: { miniappProfile?: string },
    @Query('view') view?: unknown,
  ) {
    return this.presentation(
      await this.profiles.get(user.userId, kind, id, this.profile(profile, request)),
      view,
    );
  }
  @Post('entities/:kind/:entityId/profile') async mutate(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Param('entityId') id: string,
    @Query('profile') profile: unknown,
    @Body() body: unknown,
    @Req() request: { miniappProfile?: string },
    @Query('view') view?: unknown,
  ) {
    return this.presentation(
      await this.profiles.mutate(user.userId, kind, id, this.profile(profile, request), body),
      view,
    );
  }
  private presentation(state: MarketplaceProfileState, view: unknown): MarketplaceProfileState {
    if (view === '2') return state;
    // FLAG: Old mini-app schemas reject unknown response keys during a rolling release.
    const legacy = { ...state };
    delete legacy.capabilities;
    delete legacy.statistics;
    return legacy;
  }
  private profile(input: unknown, request: { miniappProfile?: string }) {
    const profile = marketplaceProfileSchema.parse(input ?? request.miniappProfile);
    if (profile !== request.miniappProfile)
      throw new ConflictException('Профиль запуска не совпадает');
    return profile;
  }
}
