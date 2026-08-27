import type { ManagedEntityType } from '@maxim/contracts';
import type { Logger } from '@nestjs/common';
import type { MaxClientService } from '../max/max-client.service';
import type { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES } from './admin.service.support';

type AdminDialogAdminAccessRuntimeContext = {
  prisma: PrismaService;
  maxClient: MaxClientService;
  logger: Pick<Logger, 'warn'>;
  maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService;
  resolveBackgroundReadBotAssignment: (chatId: string) => Promise<string | null>;
};

export class AdminDialogAdminAccessRuntime {
  constructor(private readonly context: AdminDialogAdminAccessRuntimeContext) {}

  async readRemoteOrPersisted(chatId: string): Promise<Set<string>> {
    try {
      const resolvedBotId = await this.context.resolveBackgroundReadBotAssignment(chatId);
      const userIds = await this.context.maxClient.getChatAdminIds(chatId, {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      return new Set(userIds.map((userId) => userId.trim()).filter(Boolean));
    } catch (error: unknown) {
      const persistedAdminIds = await this.readPersistedIds(chatId);
      if (persistedAdminIds.size > 0) {
        this.context.logger.warn(
          { chatId, err: error instanceof Error ? error.message : String(error) },
          'Using persisted admin allowlist for dialog admin accents',
        );
        return persistedAdminIds;
      }
      this.context.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to resolve admin ids for dialog messages',
      );
      return new Set();
    }
  }

  async readPersisted(chatId: string, entityType: ManagedEntityType): Promise<Set<string>> {
    try {
      const ids = await this.readPersistedIds(chatId);
      if (ids.size === 0) {
        this.scheduleRosterWarmup(chatId, entityType, 'persisted_allowlist_miss');
      }
      return ids;
    } catch (error: unknown) {
      this.scheduleRosterWarmup(chatId, entityType, 'persisted_allowlist_error');
      this.context.logger.warn(
        { chatId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to read persisted dialog admin ids',
      );
      return new Set();
    }
  }

  private async readPersistedIds(chatId: string): Promise<Set<string>> {
    const rows = await this.context.prisma.chatAdminAllowlist.findMany({
      where: { chatId },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId.trim()).filter(Boolean));
  }

  private scheduleRosterWarmup(
    chatId: string,
    entityType: ManagedEntityType,
    reason: 'persisted_allowlist_miss' | 'persisted_allowlist_error',
  ): void {
    const sync = this.context.maxChatAdminRosterSyncService;
    if (!sync) return;
    void sync.scheduleChatAdminRosterSync({ chatId, entityType }).catch((error: unknown) => {
      this.context.logger.warn(
        { chatId, entityType, reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to schedule dialog admin roster warmup',
      );
    });
  }
}
