import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BroadcastHandoffResponse,
  BroadcastHandoffState,
  ManagedEntityType,
  MaxUpdate,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AdminDialogLinkService } from '../admin/admin-dialog-link.service';
import { AdminService } from '../admin/admin.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { ManagedBroadcastService } from '../admin/managed-broadcast.service';
import { ManagedGiveawayService } from '../admin/managed-giveaway.service';
import { ManualModerationService } from '../admin/manual-moderation.service';
import { SupportRequestsService } from '../admin/support-requests.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisCounterService } from './redis-counter.service';
import { PrivateControlService as LegacyPrivateControlService } from './private-control.service.legacy';

@Injectable()
export class PrivateControlService extends LegacyPrivateControlService {
  constructor(
    maxClient: MaxClientService,
    adminService: AdminService,
    adminSettingsService: AdminSettingsService,
    manualModerationService: ManualModerationService,
    managedGiveawayService: ManagedGiveawayService,
    @Optional() redisCounter?: RedisCounterService,
    @Optional() configService?: ConfigService,
    @Optional() maxBotLinkService?: MaxBotLinkService,
    @Optional() managedBroadcastService?: ManagedBroadcastService,
    @Optional() adminDialogLinkService?: AdminDialogLinkService,
    @Optional() supportRequestsService?: SupportRequestsService,
    @Optional() prisma?: PrismaService,
  ) {
    super(
      maxClient,
      adminService,
      adminSettingsService,
      manualModerationService,
      managedGiveawayService,
      redisCounter,
      configService,
      maxBotLinkService,
      managedBroadcastService,
      adminDialogLinkService,
      supportRequestsService,
      prisma,
    );
  }

  override handleUpdate(update: MaxUpdate): Promise<void> {
    return this.runWithUpdateSessionBot(update, () => super.handleUpdate(update));
  }

  override handleBotStarted(update: MaxUpdate): Promise<void> {
    return this.runWithUpdateSessionBot(update, () => super.handleBotStarted(update));
  }

  override handoffBroadcastFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffBroadcastFromMiniapp(sourceChatId, user, body, entityType),
    );
  }

  override getBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.getBroadcastHandoffState(sourceChatId, user, entityType),
    );
  }

  override clearBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.clearBroadcastHandoffState(sourceChatId, user, entityType),
    );
  }

  override handoffRulesFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffRulesFromMiniapp(sourceChatId, user),
    );
  }

  override openChannelSuggestionFromCallback(params: {
    userId: string;
    chatId: string;
    token: string;
    botId?: string | null;
  }): Promise<boolean> {
    return this.runWithSessionBot(params.botId, () =>
      super.openChannelSuggestionFromCallback(params),
    );
  }

  override handoffGiveawayFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffGiveawayFromMiniapp(sourceChatId, user, body, entityType),
    );
  }

  override handoffProfileMentionFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    targetUserId: string,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffProfileMentionFromMiniapp(sourceChatId, user, targetUserId, body, entityType),
    );
  }
}
