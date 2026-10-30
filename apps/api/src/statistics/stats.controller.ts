import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import {
  statsAuthorityRequestSchema,
  statsAuthorityResolveRequestSchema,
  statsIngestRequestSchema,
  statsSummaryRequestSchema,
  statsHistoryRequestSchema,
} from '@maxim/contracts/statistics-central-validation';
import {
  STATS_CONTROLLER_PREFIX,
  type StatsStatusResult,
} from '@maxim/contracts/statistics-central';
import { PrismaService } from '../prisma/prisma.service';
import { StatsAccessService } from './stats-access.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsReadService } from './stats-read.service';
import { StatsChangesService } from './stats-changes.service';
import { StatsAnalyticsService } from './stats-analytics.service';
import { statsAnalyticsRequestSchema } from '@maxim/contracts/statistics-analytics-validation';
import { analyticsFailure, statsReadBudgetFor } from './stats-read-budget';
import { assertBytes, centralEnabled, StatsFailure } from './stats-common';

@Injectable()
export class StatsGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const configured = this.config.get<string>('SVYAZKA_ANALYTICS_TOKEN');
    const header = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>()
      .headers.authorization;
    const actual = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const digest = (v: string) => createHash('sha256').update(v).digest();
    if (!configured || !actual || !timingSafeEqual(digest(configured), digest(actual)))
      throw new StatsFailure('UNAUTHENTICATED', 401);
    return true;
  }
}
@Controller(STATS_CONTROLLER_PREFIX)
@UseGuards(StatsGuard)
export class StatsController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly access: StatsAccessService,
    private readonly ingestService: StatsIngestService,
    private readonly read: StatsReadService,
    private readonly feed: StatsChangesService,
    private readonly analyticsService: StatsAnalyticsService,
  ) {}
  private enabled() {
    if (!centralEnabled(this.config)) throw new StatsFailure('UNAVAILABLE', 503);
  }
  private parse<T>(
    schema: z.ZodType<T>,
    body: unknown,
    limit: number,
    request?: { headers: Record<string, string | number | undefined> },
  ) {
    assertBytes(body, limit);
    // content-length is the actual received UTF-8 body size before normalization, including whitespace.
    const length = request?.headers['content-length'];
    if (length !== undefined && (!Number.isFinite(Number(length)) || Number(length) > limit))
      throw new StatsFailure('BODY_TOO_LARGE', 413);
    const result = schema.safeParse(body);
    if (!result.success) throw new StatsFailure('INVALID_REQUEST', 400);
    return result.data;
  }
  @Get('status') async status(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StatsStatusResult> {
    const enabled = centralEnabled(this.config),
      epoch = this.config.get<string>('STATISTICS_CENTRAL_EXCHANGE_EPOCH') ?? null;
    const schema =
      (
        await this.prisma.$queryRaw<
          Array<{ ready: boolean }>
        >`SELECT to_regclass('stats_entities') IS NOT NULL AND to_regclass('stats_authorities') IS NOT NULL AND to_regclass('stats_measurements') IS NOT NULL AND to_regclass('stats_ingest_requests') IS NOT NULL AND to_regclass('stats_changes') IS NOT NULL AS ready`
      )[0]?.ready === true;
    const centralReady = enabled && schema && !!epoch;
    reply.header('x-statistics-analytics-version', '1');
    reply.header('Cache-Control', 'no-store');
    return {
      contractVersion: 1,
      selectorVersion: 1,
      enabled,
      centralReady,
      producerEpoch: epoch,
      storeMode: this.config.get('STATISTICS_CENTRAL_MODE') === 'CENTRAL' ? 'CENTRAL' : 'LEGACY',
      legacyHistory: {
        imports: enabled ? 'RETIRED' : 'ACTIVE',
        exports: enabled ? 'RETIRED' : 'ACTIVE',
      },
      capabilities: centralReady
        ? ['AUTHORITIES', 'INGEST', 'SUMMARIES', 'HISTORY', 'CHANGES']
        : [],
    };
  }
  @Post('authorities:batch') authorities(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | number | undefined> },
  ) {
    this.enabled();
    return this.access.attest(this.parse(statsAuthorityRequestSchema, body, 131_072, req));
  }
  @Post('authorities:resolve') resolveAuthority(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | number | undefined> },
  ) {
    this.enabled();
    return this.access.resolve(this.parse(statsAuthorityResolveRequestSchema, body, 65_536, req));
  }
  @Post('ingest') ingest(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | number | undefined> },
  ) {
    this.enabled();
    return this.ingestService.ingest(this.parse(statsIngestRequestSchema, body, 65_536, req));
  }
  @Post('summaries:batch') summaries(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | number | undefined> },
  ) {
    this.enabled();
    return this.read.summaries(this.parse(statsSummaryRequestSchema, body, 65_536, req));
  }
  @Post('history:batch') history(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | number | undefined> },
  ) {
    this.enabled();
    return this.read.history(this.parse(statsHistoryRequestSchema, body, 65_536, req));
  }
  @Get('changes')
  changes(@Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    this.enabled();
    const parsed = z
      .object({
        cursor: z.string().min(1).max(8192).optional(),
        limit: z.coerce.number().int().min(1).max(250).default(250),
      })
      .strict()
      .safeParse({ cursor, limit });
    if (!parsed.success) throw new StatsFailure('INVALID_REQUEST', 400);
    return this.feed.changes(parsed.data.cursor, parsed.data.limit);
  }
  @Post('analytics:read')
  async analytics(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | number | undefined> },
  ) {
    try {
      this.enabled();
      const budget = statsReadBudgetFor(req);
      return await this.analyticsService.read(
        this.parse(statsAnalyticsRequestSchema, body, 65_536, req),
        budget,
      );
    } catch (error) {
      throw analyticsFailure(error);
    }
  }
}
