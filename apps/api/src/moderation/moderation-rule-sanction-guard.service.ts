import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import {
  assertModerationRuleSanctionAuthority,
  type ModerationRuleSanctionAuthority,
} from './moderation-rule-sanction-authority';
export { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';

@Injectable()
export class ModerationRuleSanctionGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertAllowed(
    params: ModerationRuleSanctionAuthority & { botId?: string },
    options?: {
      beforeFinalAuthority?: () => Promise<void>;
      assertFinalOwnership?: () => Promise<void>;
    },
  ): Promise<void> {
    await assertModerationRuleSanctionAuthority(this.prisma, params, {
      isKnownBotUserId: (userId) => this.bots.isKnownBotUserId(userId),
      getMemberAccess: () =>
        this.max.getChatMemberAccess(params.chatId, params.userId, {
          botId: params.botId,
          bypassCache: true,
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
          timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
        }),
      consumeImmunity: (input) => this.immunity.consumeForMessage(input),
      beforeFinalAuthority: options?.beforeFinalAuthority,
      assertFinalOwnership: options?.assertFinalOwnership,
      profanityRolloutMode:
        this.config.get<string>('PROFANITY_V2_ROLLOUT_MODE') === 'legacy' ? 'legacy' : 'on',
    });
  }
}
