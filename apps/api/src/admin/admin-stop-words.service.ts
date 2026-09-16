import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  stopWordsPreviewRequestSchema,
  updateStopWordsRequestSchema,
  type StopWordsState,
} from '@maxim/contracts/settings';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { AdminSettingsService } from './admin-settings.service';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import {
  migrateStopWordsPolicy,
  stopWordsPolicyStorage,
} from '../moderation/stop-words/stop-words.policy';
import { StopWordsMatcher } from '../moderation/stop-words/stop-words.matcher';
import { createAllowlistLinkMatcher } from '../moderation/rule-engine-link-detector';
import { resolveImageTextStopListOcrRuntimePolicy } from '../moderation/commercial-ocr/image-text-stop-list.runtime';

@Injectable()
export class AdminStopWordsService {
  private readonly matcher = new StopWordsMatcher();
  private readiness: { until: number; value: StopWordsState['imageScanStatus'] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: ManagedEntitiesService,
    private readonly settings: AdminSettingsService,
    private readonly capabilities: AdminSettingsBotCapabilityService,
    private readonly cache: ChatContextCacheService,
    private readonly config: ConfigService,
  ) {}

  async read(chatId: string, user: AuthUser): Promise<StopWordsState> {
    await this.admin.assertChatAdminAccess(chatId, user);
    const settings = await this.load(chatId, user);
    return {
      policy: migrateStopWordsPolicy(settings),
      revision: settings.stopWordsRevision,
      imageScanStatus: await this.imageScanStatus(),
    };
  }

  async status(chatId: string, user: AuthUser) {
    await this.admin.assertChatAdminAccess(chatId, user);
    const row = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: { stopWordsRevision: true },
    });
    return { revision: row?.stopWordsRevision ?? 0, imageScanStatus: await this.imageScanStatus() };
  }

  async update(chatId: string, user: AuthUser, body: unknown): Promise<StopWordsState> {
    await this.admin.assertChatAdminAccess(chatId, user);
    const parsed = updateStopWordsRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { policy, expectedRevision } = parsed.data;
    const current = await this.load(chatId, user);
    if (current.stopWordsRevision !== expectedRevision) throw this.conflict();
    if (policy.enabled) {
      await this.capabilities.assertChatSettingsBotCapabilities(chatId, [
        { permission: 'write', featureKeys: ['stopWordsPolicy'] },
        ...(policy.sanctions.muteEnabled || policy.sanctions.banEnabled
          ? [{ permission: 'add_remove_members' as const, featureKeys: ['stopWordsPolicy'] }]
          : []),
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.chatSettings.updateMany({
        where: { chatId, stopWordsRevision: expectedRevision, updatedAt: current.updatedAt },
        data: { ...stopWordsPolicyStorage(policy), stopWordsRevision: { increment: 1 } },
      });
      if (changed.count !== 1) throw this.conflict();
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'UPDATE_STOP_WORDS',
          // FLAG: Preview text, message templates and base64 media never enter the audit log.
          payload: {
            revision: expectedRevision + 1,
            enabled: policy.enabled,
            ruleCount: policy.rules.length,
            domainCount: policy.domains.length,
            imageScanEnabled: policy.imageScanEnabled,
            warnEnabled: policy.sanctions.warnEnabled,
            muteEnabled: policy.sanctions.muteEnabled,
            banEnabled: policy.sanctions.banEnabled,
          },
        },
      });
    });
    await this.cache.invalidate(chatId);
    return {
      policy,
      revision: expectedRevision + 1,
      imageScanStatus: await this.imageScanStatus(),
    };
  }

  async preview(chatId: string, user: AuthUser, body: unknown) {
    await this.admin.assertChatAdminAccess(chatId, user);
    const parsed = stopWordsPreviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const domains = await this.prisma.domainAllowlist.findMany({
      where: { chatId, OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }] },
      select: { domain: true },
    });
    return {
      enabled: parsed.data.policy.enabled,
      matches: this.matcher.detect({
        ...parsed.data,
        isLinkAllowlisted: createAllowlistLinkMatcher(domains.map((entry) => entry.domain)),
      }),
    };
  }

  private async load(chatId: string, user: AuthUser) {
    let row = await this.prisma.chatSettings.findUnique({ where: { chatId } });
    if (!row) {
      await this.settings.getSettings(chatId, user);
      row = await this.prisma.chatSettings.findUnique({ where: { chatId } });
    }
    if (!row) throw new NotFoundException('Настройки чата не найдены.');
    return row;
  }

  private conflict() {
    return new ConflictException({
      code: 'STOP_WORDS_REVISION_CONFLICT',
      message: 'Стоп-слова уже изменены. Обновите список перед сохранением.',
    });
  }

  private async imageScanStatus(): Promise<StopWordsState['imageScanStatus']> {
    const runtime = resolveImageTextStopListOcrRuntimePolicy({
      configService: this.config,
      sandboxBoundaryVerified: false,
    });
    if (runtime.mode !== 'on') return runtime.mode;
    if (this.readiness && this.readiness.until > Date.now()) return this.readiness.value;
    let value: StopWordsState['imageScanStatus'] = 'unavailable';
    try {
      // Fixed internal destination; no user-controlled URL or credentials are forwarded.
      const response = await fetch('http://api-media-analysis:3001/api/health/ready?scope=ocr', {
        signal: AbortSignal.timeout(1_000),
        redirect: 'error',
      });
      if (response.ok) {
        const body = (await response.json()) as {
          ok?: boolean;
          checks?: { ocr?: { ready?: boolean } };
        };
        if (body.ok === true && body.checks?.ocr?.ready === true) value = 'ready';
      }
    } catch {
      /* Missing readiness cannot authorize image moderation. */
    }
    this.readiness = { until: Date.now() + 5_000, value };
    return value;
  }
}
