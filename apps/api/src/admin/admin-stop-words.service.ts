import {
  assertFixedModeratorCapabilitiesForSettings,
  lockModeratorSettingsChat,
} from '../max/fixed-moderator-capabilities';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
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
  readStopWordsPolicy,
  stopWordsPolicyStorage,
} from '../moderation/stop-words/stop-words.policy';
import { StopWordsMatcher } from '../moderation/stop-words/stop-words.matcher';
import { createAllowlistLinkMatcher } from '../moderation/rule-engine-link-detector';
import { resolveImageTextStopListOcrRuntimePolicy } from '../moderation/commercial-ocr/image-text-stop-list.runtime';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import type { StopWordsPolicy } from '@maxim/contracts/settings';
import { readStopWordsStorageStatus } from '../moderation/stop-words/stop-words-storage-status';
import { readEditableStopWordsPolicy } from './stop-words-editable-policy';
import { OcrReadinessStateService } from '../health/ocr-readiness-state.service';
import { assertStopWordsStorageEditable } from './stop-words-storage-boundary';

@Injectable()
export class AdminStopWordsService {
  private readonly matcher = new StopWordsMatcher();

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: ManagedEntitiesService,
    private readonly settings: AdminSettingsService,
    private readonly capabilities: AdminSettingsBotCapabilityService,
    private readonly cache: ChatContextCacheService,
    private readonly config: ConfigService,
    @Optional() private readonly ocrReadiness?: OcrReadinessStateService,
  ) {}

  async read(chatId: string, user: AuthUser): Promise<StopWordsState> {
    await this.admin.assertChatAdminAccess(chatId, user);
    const settings = await this.load(chatId, user);
    return {
      policy: readEditableStopWordsPolicy(settings),
      revision: settings.stopWordsRevision,
      settingsRevision: settings.updatedAt.toISOString(),
      storageStatus: readStopWordsStorageStatus(settings),
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

  async update(
    chatId: string,
    user: AuthUser,
    body: unknown,
    networkWrite?: NetworkSettingsWriteOptions & { settingsRevision?: string },
  ): Promise<StopWordsState> {
    await this.admin.assertChatAdminAccess(chatId, user);
    const parsed = updateStopWordsRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { policy, expectedRevision, replaceInvalidStorage } = parsed.data;
    const current = await this.load(chatId, user);
    const storageStatus = readStopWordsStorageStatus(current);
    // FLAG: Older clients submit full disabled fallbacks. Only an explicit standalone
    // replacement intent, fenced by this row's revision, may replace invalid storage.
    if (networkWrite || (storageStatus === 'invalid' && replaceInvalidStorage !== true)) {
      assertStopWordsStorageEditable({
        revision: current.stopWordsRevision,
        storageStatus,
      });
    }
    if (networkWrite) readEditableStopWordsPolicy(current);
    if (current.stopWordsRevision !== expectedRevision) {
      // FLAG: Recover only the exact already-committed standalone request. Network writes
      // retain their operation receipts; a different policy or media remains a conflict.
      const storedPolicy =
        readStopWordsStorageStatus(current) === 'valid' ? readStopWordsPolicy(current) : null;
      if (
        !networkWrite &&
        current.stopWordsRevision === expectedRevision + 1 &&
        storedPolicy &&
        isDeepStrictEqual(storedPolicy, policy)
      ) {
        await this.cache.invalidate(chatId);
        return {
          policy: storedPolicy,
          revision: current.stopWordsRevision,
          settingsRevision: current.updatedAt.toISOString(),
          storageStatus: 'valid',
          imageScanStatus: await this.imageScanStatus(),
        };
      }
      throw this.conflict();
    }
    if (
      networkWrite?.settingsRevision &&
      current.updatedAt.toISOString() !== networkWrite.settingsRevision
    )
      throw this.conflict();
    if (policy.enabled) {
      await this.capabilities.assertChatSettingsBotCapabilities(
        chatId,
        [
          { permission: 'write', featureKeys: ['stopWordsPolicy'] },
          ...(policy.sanctions.muteEnabled || policy.sanctions.banEnabled
            ? [{ permission: 'add_remove_members' as const, featureKeys: ['stopWordsPolicy'] }]
            : []),
        ],
        networkWrite ? { forceLive: true } : undefined,
      );
    }
    const settingsRevision = await this.prisma.$transaction(async (tx) => {
      const lockedChat = await lockModeratorSettingsChat(tx, chatId);
      await assertFixedModeratorCapabilitiesForSettings(
        tx,
        lockedChat,
        policy.enabled
          ? [
              'send_message',
              ...(policy.sanctions.muteEnabled || policy.sanctions.banEnabled
                ? ['moderate_member' as const]
                : []),
            ]
          : [],
      );

      if (networkWrite?.validateOnly) return current.updatedAt.toISOString();

      const changed = await tx.chatSettings.updateMany({
        where: { chatId, stopWordsRevision: expectedRevision, updatedAt: current.updatedAt },
        data: { ...stopWordsPolicyStorage(policy), stopWordsRevision: { increment: 1 } },
      });
      if (changed.count !== 1) throw this.conflict();
      const written = await tx.chatSettings.findUniqueOrThrow({
        where: { chatId },
        select: { updatedAt: true },
      });
      if (networkWrite?.onCommitted) {
        await networkWrite.onCommitted(tx, written.updatedAt.toISOString());
      }
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
      return written.updatedAt.toISOString();
    });
    if (!networkWrite?.deferFollowup && !networkWrite?.validateOnly)
      await this.cache.invalidate(chatId);
    return {
      policy,
      revision: expectedRevision + (networkWrite?.validateOnly ? 0 : 1),
      settingsRevision,
      storageStatus: 'valid',
      imageScanStatus: await this.imageScanStatus(),
    };
  }

  async updateNetworkSettings(
    chatId: string,
    user: AuthUser,
    policy: StopWordsPolicy,
    expectedRevision: number,
    settingsRevision: string,
    options: NetworkSettingsWriteOptions,
  ): Promise<StopWordsState> {
    return this.update(
      chatId,
      user,
      { policy, expectedRevision },
      { ...options, settingsRevision },
    );
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
    const snapshot = await this.ocrReadiness?.read();
    return snapshot?.mode === 'on' && snapshot.ready && snapshot.identityVerified
      ? 'ready'
      : 'unavailable';
  }
}
