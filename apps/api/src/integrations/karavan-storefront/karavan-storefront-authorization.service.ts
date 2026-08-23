import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModerationAccessService } from '../../moderation/moderation-access.service';
import { KaravanStorefrontAllowlistService } from './karavan-storefront-allowlist.service';

export type KaravanStorefrontPublicationAuthorization = {
  chatId: string;
  actorUserId: string;
  adminsOnly: boolean;
};

/**
 * Central policy for the relay. Allowlist entries are checked locally first;
 * an administrator check then uses ModerationAccessService's shared cache and
 * targeted MAX lookup. Unknown/timeout access is deliberately denied.
 */
@Injectable()
export class KaravanStorefrontAuthorizationService {
  private readonly logger = new Logger(KaravanStorefrontAuthorizationService.name);

  constructor(
    private readonly allowlist: KaravanStorefrontAllowlistService,
    @Optional() private readonly moderationAccess?: ModerationAccessService,
  ) {}

  async canPublish(params: KaravanStorefrontPublicationAuthorization): Promise<boolean> {
    if (!params.adminsOnly) {
      return true;
    }

    const chatId = params.chatId.trim();
    const actorUserId = params.actorUserId.trim();
    if (!chatId || !actorUserId) {
      return false;
    }

    try {
      if (await this.allowlist.isActive(chatId, actorUserId)) {
        return true;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Karavan allowlist lookup failed; denying publication',
      );
      return false;
    }

    if (!this.moderationAccess) {
      this.logger.warn({ chatId }, 'Karavan admin access checker is unavailable');
      return false;
    }

    try {
      const result = await this.moderationAccess.resolveSenderChatAdminCheck(
        chatId,
        undefined,
        actorUserId,
        {
          allowRemoteLookup: true,
          skipRemoteLookupWhenLocalAdminsKnown: false,
          // Keep the message hot path bounded when MAX is slow. A cache hit is
          // returned immediately; a miss gets a short targeted probe.
          remoteLookupSoftTimeoutMs: 350,
        },
      );
      return result.isAdmin && result.source !== 'local_fallback';
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Karavan admin access check failed; denying publication',
      );
      return false;
    }
  }
}
