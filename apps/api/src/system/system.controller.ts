import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { QueueMetricsService } from './queue-metrics.service';
import {
  canUserAccessSystem,
  readSystemAccessConfig,
  type SystemAccessConfig,
} from './system-access.util';
import { MaxApiMetricsService } from './max-api-metrics.service';
import { SystemBotsService } from './system-bots.service';
import { SystemDashboardService } from './system-dashboard.service';
import { SystemModeService } from './system-mode.service';

const systemModeBodySchema = z.object({
  mode: z.enum(['normal', 'degrade', 'auto']),
});
const maxApiMetricsQuerySchema = z.object({
  windowSec: z.coerce
    .number()
    .int()
    .min(60)
    .max(6 * 60 * 60)
    .optional(),
});
const routePreviewQueryValue = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const routePreviewBooleanSchema = z.preprocess((value) => {
  const raw = routePreviewQueryValue(value);
  if (raw === undefined) {
    return true;
  }
  if (raw === true || raw === false) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return raw;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return raw;
}, z.boolean());
const optionalRoutePreviewStringSchema = z.preprocess(
  (value) => routePreviewQueryValue(value),
  z.string().trim().min(1).optional(),
);
const systemBotRoutePreviewQuerySchema = z.object({
  chatId: z.preprocess((value) => routePreviewQueryValue(value), z.string().trim().min(1)),
  purpose: z
    .preprocess(
      (value) => routePreviewQueryValue(value),
      z
        .enum([
          'all',
          'default',
          'read',
          'send_message',
          'member_access',
          'moderation_action',
          'capability',
        ])
        .optional(),
    )
    .default('all'),
  action: z
    .preprocess(
      (value) => routePreviewQueryValue(value),
      z.enum(['delete_message', 'moderate_member']).optional(),
    )
    .optional(),
  capability: z
    .preprocess(
      (value) => routePreviewQueryValue(value),
      z
        .enum([
          'background_scans',
          'channel_stats',
          'suggestion_delivery',
          'membership_prewarm',
          'access_prewarm',
        ])
        .optional(),
    )
    .optional(),
  fallbackToPrimary: routePreviewBooleanSchema.default(true),
  botId: optionalRoutePreviewStringSchema,
});
const systemBotRouteAuditQuerySchema = z.object({
  sampleLimit: z
    .preprocess((value) => routePreviewQueryValue(value), z.coerce.number().int().min(1).max(500))
    .optional(),
  includeCovered: routePreviewBooleanSchema.default(true),
});
const systemBotMembershipAuditQuerySchema = z.object({
  sampleLimit: z
    .preprocess((value) => routePreviewQueryValue(value), z.coerce.number().int().min(1).max(200))
    .optional(),
  snapshotFreshMs: z
    .preprocess(
      (value) => routePreviewQueryValue(value),
      z.coerce
        .number()
        .int()
        .min(60_000)
        .max(30 * 24 * 60 * 60 * 1_000),
    )
    .optional(),
});

@Controller('v1/system')
@UseGuards(InitDataGuard)
export class SystemController {
  private readonly systemAccessConfig: SystemAccessConfig;

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    private readonly systemDashboardService: SystemDashboardService,
    private readonly maxApiMetricsService: MaxApiMetricsService,
    private readonly systemBotsService: SystemBotsService,
    configService: ConfigService,
  ) {
    this.systemAccessConfig = readSystemAccessConfig(configService);
  }

  @Get('metrics/queues')
  async getQueueMetrics(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    const [queues, mode] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      this.systemModeService.getEffectiveSnapshot(),
    ]);
    return { queues, mode };
  }

  @Get('metrics/max-api')
  async getMaxApiMetrics(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    this.assertSystemAdmin(user);
    const parsed = maxApiMetricsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    return this.maxApiMetricsService.getSourceSnapshot({
      windowSec: parsed.data.windowSec,
    });
  }

  @Get('dashboard')
  async getDashboard(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    return this.systemDashboardService.getSnapshot();
  }

  @Get('bots')
  async getBots(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    return this.systemBotsService.getSnapshot();
  }

  @Get('bots/routes/audit')
  async getBotRouteAudit(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    this.assertSystemAdmin(user);
    const parsed = systemBotRouteAuditQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.systemBotsService.getRouteAudit(parsed.data);
  }

  @Get('bots/routes/preview')
  async getBotRoutePreview(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    this.assertSystemAdmin(user);
    const parsed = systemBotRoutePreviewQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.systemBotsService.getRoutePreview({
      chatId: parsed.data.chatId,
      purpose: parsed.data.purpose,
      action: parsed.data.action ?? null,
      capability: parsed.data.capability ?? null,
      fallbackToPrimary: parsed.data.fallbackToPrimary,
      botId: parsed.data.botId ?? null,
    });
  }

  @Get('bots/audit')
  async getBotMembershipAudit(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    this.assertSystemAdmin(user);
    const parsed = systemBotMembershipAuditQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.systemBotsService.getMembershipAudit(parsed.data);
  }

  @Get('mode')
  async getMode(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    return this.systemModeService.getEffectiveSnapshot();
  }

  @Post('mode')
  async setMode(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.assertSystemAdmin(user);
    const parsed = systemModeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const manualMode = parsed.data.mode === 'auto' ? null : parsed.data.mode;
    return this.systemModeService.setManualMode(manualMode);
  }

  private assertSystemAdmin(user: AuthUser) {
    if (canUserAccessSystem(user.userId, this.systemAccessConfig)) {
      return;
    }

    throw new ForbiddenException('System access denied');
  }
}
