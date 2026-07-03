import {
  claimManagedGiveawayResponseSchema,
  giveawayEligibilityStateSchema,
  managedEntityTypeSchema,
  managedGiveawayDetailsSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  managedGiveawaySummarySchema,
  managedGiveawayWinnerSchema,
  markManagedGiveawayWinnerDeliveredRequestSchema,
  MAX_BROADCAST_IMAGE_BASE64_LENGTH,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  rerollManagedGiveawayWinnerRequestSchema,
  type ClaimManagedGiveawayResponse,
  type ManagedEntityType,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
  type ManagedGiveawayWinner,
  type ResolveRequiredSubscriptionChannelResponse,
  type UpdateManagedGiveawayRequest,
  updateManagedGiveawayRequestSchema,
} from '@maxim/contracts';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  GiveawayEligibilityState,
  ManagedEntityAccessState,
  ManagedGiveawayStatus,
  ManagedGiveawayWinnerStatus,
  Prisma,
} from '../prisma/prisma-client';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import {
  buildManagedGiveawayDrawRank,
  normalizeManagedGiveawayDraft,
} from '../common/managed-giveaway.util';
import {
  containsSupportedMarkdownSyntax,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
import {
  MaxClientService,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import {
  MaxMembershipLookupService,
  type MaxMembershipLookupIssueKind,
  type MaxMembershipLookupPolicy,
} from '../max/max-membership-lookup.service';
import {
  buildCompactGiveawayClaimStartPayload,
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
  parseCompactGiveawayClaimStartPayload,
} from '../max/max-deep-link.util';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import { normalizeMembershipAccessSnapshot } from '../max/max-bot-access-policy.util';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';
import { MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS } from './admin.service.support';

type GiveawayActionSource = 'miniapp' | 'private_bot' | 'runner' | 'private_claim';

const GIVEAWAY_IMAGE_MAX_BYTES = Math.floor((MAX_BROADCAST_IMAGE_BASE64_LENGTH * 3) / 4);
const GIVEAWAY_LOCK_STALE_MS = 60_000;
const GIVEAWAY_DUE_BATCH_SIZE = 20;
const GIVEAWAY_DUE_FETCH_BATCH_SIZE = GIVEAWAY_DUE_BATCH_SIZE * 4;
const GIVEAWAY_START_PARAM_PREFIX = 'gg-';
const GIVEAWAY_CLAIM_START_PREFIX = 'ggc-';
const GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE =
  'Не удалось проверить участие в исходном чате. Повторите позже.';
const GIVEAWAY_RUNNER_LOOKUP_FAILURE_COUNT_TTL_SEC = 6 * 60 * 60;
const GIVEAWAY_RUNNER_LOOKUP_BACKOFF_BASE_MS = 60_000;
const GIVEAWAY_RUNNER_LOOKUP_BACKOFF_MAX_MS = 60 * 60_000;
const GIVEAWAY_RUNNER_LOOKUP_DEFER_AFTER_FAILURE_COUNT = 4;
const GIVEAWAY_RUNNER_LOOKUP_DEFER_MS = 30 * 60_000;
const GIVEAWAY_RUNNER_LOOKUP_TERMINAL_DEFER_MS = 2 * 60 * 60_000;
const MANAGED_GIVEAWAY_INCLUDE = {
  prizes: {
    orderBy: { position: 'asc' },
  },
  entries: {
    orderBy: [{ joinedAt: 'asc' }],
  },
  winners: {
    include: {
      prize: true,
      entry: true,
    },
    orderBy: [{ selectedAt: 'asc' }],
  },
} as const satisfies Prisma.ManagedGiveawayInclude;

type PersistedGiveawayWithRelations = Prisma.ManagedGiveawayGetPayload<{
  include: typeof MANAGED_GIVEAWAY_INCLUDE;
}>;
type PersistedManagedGiveaway = Prisma.ManagedGiveawayGetPayload<Record<string, never>>;
type PersistedManagedGiveawayPrize = Prisma.ManagedGiveawayPrizeGetPayload<Record<string, never>>;
type PersistedManagedGiveawayEntry = Prisma.ManagedGiveawayEntryGetPayload<Record<string, never>>;
type PersistedManagedGiveawayWinner = Prisma.ManagedGiveawayWinnerGetPayload<Record<string, never>>;
type GiveawayRerollCandidate = {
  entry: PersistedManagedGiveawayEntry;
  drawRank: string;
};
type GiveawayDrawClaimResult =
  | { status: 'claimed'; giveaway: PersistedGiveawayWithRelations; drawSeed: string }
  | { status: 'completed'; giveaway: PersistedGiveawayWithRelations };
type GiveawayEligibilityResult = {
  state: GiveawayEligibilityState;
  reason: string | null;
  missingChannelIds: string[];
};
type GiveawayEntryAuditAction = 'ENTER_GIVEAWAY' | 'RECHECK_GIVEAWAY_ENTRY';
type GiveawayEligibilityCheckOptions = {
  strictChannelCheck?: boolean;
  forceFreshMembership?: boolean;
  lookupPolicy?: MaxMembershipLookupPolicy;
  allowStaleMembershipOnError?: boolean;
  failedChannelId?: string;
};

export class ManagedGiveawayMembershipLookupUnavailableError extends Error {
  constructor(
    readonly kind: MaxMembershipLookupIssueKind,
    readonly chatId: string,
    readonly retryAfterMs: number | null,
  ) {
    super(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
    this.name = 'ManagedGiveawayMembershipLookupUnavailableError';
  }
}

@Injectable()
export class ManagedGiveawayService {
  private readonly logger = new Logger(ManagedGiveawayService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly giveawayRunnerFailureCounts = new Map<
    string,
    { count: number; expiresAtMs: number }
  >();
  private readonly giveawayRunnerBackoffUntilMs = new Map<string, number>();
  private readonly giveawayRunnerDeferredUntilMs = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly adminService: AdminService,
    configService: ConfigService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
  ) {
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    this.maxBotToken =
      this.maxBotLinkService?.getBotTokenSync() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [this.maxBotToken]);
  }

  async listManagedGiveaways(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawaySummary[]> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const rows = await this.prisma.managedGiveaway.findMany({
      where: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        entries: {
          select: {
            eligibilityState: true,
          },
        },
        winners: {
          where: {
            status: {
              not: ManagedGiveawayWinnerStatus.REROLLED,
            },
          },
          select: {
            id: true,
          },
        },
      },
    });

    return rows.map((row) => managedGiveawaySummarySchema.parse(this.mapGiveawaySummary(row)));
  }

  async createManagedGiveaway(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);
    await this.ensureNoConcurrentManagedGiveaway(sourceChatId, entityType);

    const payload = this.parseManagedGiveawayDraft(body);
    const row = await this.prisma.managedGiveaway.create({
      data: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
        actorUserId: user.userId,
        title: payload.title,
        description: payload.description,
        imageEnabled: payload.imageEnabled,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        imageFileName: payload.imageFileName,
        startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
        endsAt: new Date(payload.endsAt),
        claimHours: payload.claimHours,
        requiredChannelIds: payload.requiredChannelIds,
        prizes: {
          create: payload.prizes.map((prize) => ({
            position: prize.position,
            title: prize.title,
            displayTitle: prize.displayTitle,
          })),
        },
      },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'CREATE_GIVEAWAY', {
      giveawayId: row.id,
      entityType,
      title: payload.title,
      prizes: payload.prizes.length,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(row));
  }

  async getManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const row = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(row));
  }

  async refreshManagedGiveawayPublication(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    await this.editGiveawayPublicationIfNeeded(giveaway, giveaway.status);
    await this.writeAuditLog(sourceChatId, user.userId, 'REFRESH_GIVEAWAY_PUBLICATION', {
      giveawayId,
      entityType,
      status: giveaway.status,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(giveaway));
  }

  async updateManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const existing = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (existing.status !== ManagedGiveawayStatus.DRAFT) {
      throw new BadRequestException('Изменять можно только черновик розыгрыша.');
    }

    const payload = this.parseManagedGiveawayDraft(body);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.managedGiveawayPrize.deleteMany({
        where: { giveawayId: existing.id },
      });

      await tx.managedGiveaway.update({
        where: { id: existing.id },
        data: {
          actorUserId: user.userId,
          title: payload.title,
          description: payload.description,
          imageEnabled: payload.imageEnabled,
          imageBase64: payload.imageBase64,
          imageMimeType: payload.imageMimeType,
          imageFileName: payload.imageFileName,
          startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
          endsAt: new Date(payload.endsAt),
          claimHours: payload.claimHours,
          requiredChannelIds: payload.requiredChannelIds,
        },
      });

      await tx.managedGiveawayPrize.createMany({
        data: payload.prizes.map((prize) => ({
          giveawayId: existing.id,
          position: prize.position,
          title: prize.title,
          displayTitle: prize.displayTitle,
        })),
      });

      return tx.managedGiveaway.findUniqueOrThrow({
        where: { id: existing.id },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'UPDATE_GIVEAWAY', {
      giveawayId: existing.id,
      entityType,
      title: payload.title,
      prizes: payload.prizes.length,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
  }

  async publishManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (giveaway.status !== ManagedGiveawayStatus.DRAFT) {
      throw new BadRequestException('Публиковать можно только черновик розыгрыша.');
    }
    await this.ensureNoConcurrentManagedGiveaway(sourceChatId, entityType, giveaway.id);

    const now = new Date();
    const startsAt =
      giveaway.startsAt && giveaway.startsAt.getTime() > now.getTime() ? giveaway.startsAt : null;
    const nextStatus = startsAt ? ManagedGiveawayStatus.SCHEDULED : ManagedGiveawayStatus.ACTIVE;
    if (!giveaway.description.trim()) {
      throw new BadRequestException('Добавьте текст розыгрыша в чат-боте перед публикацией.');
    }
    const publicationBotId = await this.resolveGiveawayPublicationBotId(sourceChatId);
    const publicationButton = await this.buildGiveawayEntryButton(giveaway);
    const imagePayload = await this.uploadGiveawayImage(giveaway, publicationBotId);
    const publicationTextPayload = this.buildFormattedGiveawayTextPayload(
      this.buildGiveawayPublicationText(giveaway),
    );
    const publicationOptions = {
      ...(publicationTextPayload.textFormat
        ? { textFormat: publicationTextPayload.textFormat }
        : {}),
      ...(publicationButton ? { buttons: [[publicationButton]] } : {}),
      ...(imagePayload ? { imagePayload } : {}),
    } satisfies MaxSendMessageOptions;
    const publication = publicationBotId
      ? await this.maxClient.sendMessageImmediateWithResolvedLink(
          sourceChatId,
          publicationTextPayload.text,
          publicationOptions,
          { botId: publicationBotId },
        )
      : await this.maxClient.sendMessageImmediateWithResolvedLink(
          sourceChatId,
          publicationTextPayload.text,
          publicationOptions,
        );

    const publishedAt = new Date();
    const updated = await this.prisma.managedGiveaway.update({
      where: { id: giveaway.id },
      data: {
        actorUserId: user.userId,
        status: nextStatus,
        publicationMessageId: publication.messageId,
        publicationUrl: publication.url,
        publishedAt,
      },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'PUBLISH_GIVEAWAY', {
      giveawayId: giveaway.id,
      entityType,
      status: nextStatus,
      publicationMessageId: publication.messageId,
      publicationUrl: publication.url,
      source,
    });
    await this.chatContextCache.invalidate(sourceChatId);

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
  }

  async closeManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (
      giveaway.status !== ManagedGiveawayStatus.ACTIVE &&
      giveaway.status !== ManagedGiveawayStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        'Завершить можно только активный или запланированный розыгрыш.',
      );
    }

    const completed = await this.drawGiveaway(giveaway.id, source, user.userId);
    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(completed));
  }

  async rerollManagedGiveawayWinner(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);
    const parsed = rerollManagedGiveawayWinnerRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (giveaway.status !== ManagedGiveawayStatus.COMPLETED || !giveaway.drawSeed) {
      throw new BadRequestException('Реролл доступен только после завершения розыгрыша.');
    }

    const winner = giveaway.winners.find((row) => row.id === parsed.data.winnerId);
    if (!winner || winner.status === ManagedGiveawayWinnerStatus.REROLLED) {
      throw new BadRequestException('Победитель для реролла не найден.');
    }
    if (
      winner.status !== ManagedGiveawayWinnerStatus.SELECTED &&
      winner.status !== ManagedGiveawayWinnerStatus.CLAIMED &&
      winner.status !== ManagedGiveawayWinnerStatus.EXPIRED
    ) {
      throw new BadRequestException(
        'Реролл доступен только для актуального или просроченного места.',
      );
    }

    const nextEntry = this.pickNextRerollCandidate(giveaway, giveaway.drawSeed);

    if (!nextEntry) {
      throw new BadRequestException('Больше подходящих участников для реролла нет.');
    }

    const now = new Date();
    const claimDeadlineAt = this.buildGiveawayClaimDeadlineAt(giveaway, now);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.managedGiveawayEntry.update({
        where: { id: nextEntry.entry.id },
        data: { drawRank: nextEntry.drawRank, checkedAt: now },
      });

      await tx.managedGiveawayWinner.update({
        where: { id: winner.id },
        data: {
          status: ManagedGiveawayWinnerStatus.REROLLED,
          rerolledAt: now,
        },
      });

      await tx.managedGiveawayWinner.create({
        data: {
          giveawayId: giveaway.id,
          prizeId: winner.prizeId,
          entryId: nextEntry.entry.id,
          rank: winner.rank,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: now,
          claimDeadlineAt,
          claimedAt: null,
          expiredAt: null,
          deliveredAt: null,
          rerolledAt: null,
        },
      });

      return tx.managedGiveaway.findUniqueOrThrow({
        where: { id: giveaway.id },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });
    });

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(updated);
    const refreshed = await this.findGiveawayById(updated.id);
    await this.sendWinnerDirectMessages(refreshed, [
      this.buildWinnerNotificationKey(nextEntry.entry.id, winner.prizeId),
    ]);
    await this.writeAuditLog(sourceChatId, user.userId, 'REROLL_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: winner.id,
      nextEntryId: nextEntry.entry.id,
      entityType,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(refreshed));
  }

  async markManagedGiveawayWinnerDelivered(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);
    const parsed = markManagedGiveawayWinnerDeliveredRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    const winner = giveaway.winners.find((row) => row.id === parsed.data.winnerId);
    if (!winner || winner.status === ManagedGiveawayWinnerStatus.REROLLED) {
      throw new BadRequestException('Победитель не найден.');
    }
    const effectiveWinnerStatus = this.resolveEffectiveWinnerStatus(winner);
    if (
      effectiveWinnerStatus !== ManagedGiveawayWinnerStatus.CLAIMED &&
      effectiveWinnerStatus !== ManagedGiveawayWinnerStatus.SELECTED
    ) {
      throw new BadRequestException('Выдачу можно отметить только для актуального победителя.');
    }

    const updated = await this.prisma.managedGiveawayWinner.update({
      where: { id: winner.id },
      data: {
        status: ManagedGiveawayWinnerStatus.DELIVERED,
        deliveredAt: new Date(),
      },
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'DELIVER_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: updated.id,
      entityType,
      source,
    });

    const refreshed = await this.prisma.managedGiveaway.findUniqueOrThrow({
      where: { id: giveaway.id },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.editGiveawayPublicationIfNeeded(refreshed, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(refreshed);

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(refreshed));
  }

  async cancelManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (
      giveaway.status !== ManagedGiveawayStatus.DRAFT &&
      giveaway.status !== ManagedGiveawayStatus.SCHEDULED &&
      giveaway.status !== ManagedGiveawayStatus.ACTIVE
    ) {
      throw new BadRequestException(
        'Отменить можно только текущий черновик или активный розыгрыш.',
      );
    }

    const canceledAt = new Date();
    const updated = await this.prisma.managedGiveaway.update({
      where: { id: giveaway.id },
      data: {
        status: ManagedGiveawayStatus.CANCELED,
        canceledAt,
        lockedAt: null,
      },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.CANCELED);
    await this.writeAuditLog(sourceChatId, user.userId, 'CANCEL_GIVEAWAY', {
      giveawayId,
      entityType,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
  }

  async deleteManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<void> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (
      giveaway.status !== ManagedGiveawayStatus.COMPLETED &&
      giveaway.status !== ManagedGiveawayStatus.CANCELED
    ) {
      throw new BadRequestException('Удалять можно только завершённый или отменённый розыгрыш.');
    }

    await this.prisma.managedGiveaway.delete({
      where: { id: giveaway.id },
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'DELETE_GIVEAWAY', {
      giveawayId,
      entityType,
      source,
      status: giveaway.status,
    });
  }

  async resolveManagedGiveawayRequiredChannel(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<ResolveRequiredSubscriptionChannelResponse> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const parsed = resolveRequiredSubscriptionChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channel = await this.adminService.resolveRequiredSubscriptionChannelReferenceValue(
      parsed.data.value,
    );
    return resolveRequiredSubscriptionChannelResponseSchema.parse({ channel });
  }

  async getPublicGiveaway(giveawayId: string, _user: AuthUser): Promise<ManagedGiveawayPublic> {
    const refreshed = await this.findPublicGiveawayById(giveawayId);
    await this.upsertParticipantChatAccess(refreshed);

    return managedGiveawayPublicSchema.parse(await this.mapPublicGiveaway(refreshed));
  }

  async getGiveawayParticipantState(
    giveawayId: string,
    user: AuthUser,
  ): Promise<ManagedGiveawayParticipantState> {
    const refreshed = await this.findPublicGiveawayById(giveawayId);
    await this.upsertParticipantChatAccess(refreshed);

    return managedGiveawayParticipantStateSchema.parse(
      this.mapParticipantState(refreshed, user.userId),
    );
  }

  async enterGiveaway(
    giveawayId: string,
    user: AuthUser,
  ): Promise<ManagedGiveawayParticipantState> {
    const refreshed = await this.findPublicGiveawayById(giveawayId);
    this.assertGiveawayOpenForEntry(refreshed);
    await this.upsertParticipantChatAccess(refreshed);

    const eligibility = await this.evaluateGiveawayEligibility(refreshed, user.userId);
    const displayName = this.resolveUserDisplayName(user);
    const existing = refreshed.entries.find((entry) => entry.userId === user.userId) ?? null;
    const checkedAt = new Date();
    const saved = await this.prisma.managedGiveawayEntry.upsert({
      where: {
        giveawayId_userId: {
          giveawayId: refreshed.id,
          userId: user.userId,
        },
      },
      create: {
        giveawayId: refreshed.id,
        userId: user.userId,
        displayName,
        eligibilityState: eligibility.state,
        eligibilityReason: eligibility.reason,
        missingChannelIds: eligibility.missingChannelIds,
        checkedAt,
      },
      update: {
        displayName,
        eligibilityState: eligibility.state,
        eligibilityReason: eligibility.reason,
        missingChannelIds: eligibility.missingChannelIds,
        checkedAt,
      },
    });

    const auditAction = this.resolveGiveawayEntryAuditAction(existing, saved);
    if (auditAction) {
      await this.writeAuditLog(refreshed.sourceChatId, user.userId, auditAction, {
        giveawayId: refreshed.id,
        entityType: this.fromPrismaEntityType(refreshed.entityType),
        previousEntryId: existing?.id ?? null,
        entryId: saved.id,
        eligibilityState: saved.eligibilityState,
        eligibilityReason: saved.eligibilityReason,
        missingChannelIds: this.readMissingChannelIds(saved.missingChannelIds),
      });
    }

    const latest = await this.findGiveawayById(refreshed.id);
    await this.editGiveawayPublicationIfNeeded(latest, ManagedGiveawayStatus.ACTIVE);
    return managedGiveawayParticipantStateSchema.parse(
      this.mapParticipantState(latest, user.userId),
    );
  }

  async claimGiveaway(
    giveawayId: string,
    user: AuthUser,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ClaimManagedGiveawayResponse> {
    const giveaway = await this.findPublicGiveawayById(giveawayId);
    if (giveaway.status !== ManagedGiveawayStatus.COMPLETED) {
      throw new BadRequestException('Розыгрыш ещё не завершён.');
    }

    const winner = giveaway.winners.find(
      (row) =>
        row.entry.userId === user.userId && row.status !== ManagedGiveawayWinnerStatus.REROLLED,
    );
    if (!winner) {
      throw new NotFoundException('Для вас нет актуального приза.');
    }
    if (winner.status === ManagedGiveawayWinnerStatus.CLAIMED) {
      const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(giveaway.prizes);
      return claimManagedGiveawayResponseSchema.parse({
        ok: true,
        winner: this.mapGiveawayWinner(winner, prizeDisplayTitleById),
      });
    }
    if (winner.status !== ManagedGiveawayWinnerStatus.SELECTED) {
      throw new BadRequestException('Приз уже обработан.');
    }
    if (winner.claimDeadlineAt && winner.claimDeadlineAt.getTime() <= Date.now()) {
      await this.prisma.managedGiveawayWinner.update({
        where: { id: winner.id },
        data: {
          status: ManagedGiveawayWinnerStatus.EXPIRED,
          expiredAt: new Date(),
        },
      });
      throw new BadRequestException('Срок подтверждения приза уже истёк.');
    }

    const eligibility = await this.evaluateGiveawayEligibility(giveaway, user.userId, {
      strictChannelCheck: true,
      forceFreshMembership: true,
      lookupPolicy: 'giveaway_strict',
      allowStaleMembershipOnError: false,
    });
    if (eligibility.state !== GiveawayEligibilityState.VERIFIED) {
      throw new BadRequestException(
        eligibility.reason || 'Не удалось повторно подтвердить выполнение условий розыгрыша.',
      );
    }

    const updated = await this.prisma.managedGiveawayWinner.update({
      where: { id: winner.id },
      data: {
        status: ManagedGiveawayWinnerStatus.CLAIMED,
        claimedAt: new Date(),
      },
      include: {
        prize: true,
        entry: true,
      },
    });

    await this.writeAuditLog(giveaway.sourceChatId, user.userId, 'CLAIM_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: updated.id,
      source,
    });

    const refreshed = await this.prisma.managedGiveaway.findUniqueOrThrow({
      where: { id: giveaway.id },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.editGiveawayPublicationIfNeeded(refreshed, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(refreshed);
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(refreshed.prizes);

    return claimManagedGiveawayResponseSchema.parse({
      ok: true,
      winner: this.mapGiveawayWinner(updated, prizeDisplayTitleById),
    });
  }

  async processDueManagedGiveaways(reason: 'startup' | 'scheduled'): Promise<void> {
    const now = new Date();
    await this.expireDueGiveawayClaims(now);
    const staleLockBefore = new Date(now.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const rows = await this.prisma.managedGiveaway.findMany({
      where: {
        status: {
          in: [
            ManagedGiveawayStatus.SCHEDULED,
            ManagedGiveawayStatus.ACTIVE,
            ManagedGiveawayStatus.DRAWING,
          ],
        },
        AND: [
          {
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
          },
          {
            OR: [
              {
                status: ManagedGiveawayStatus.SCHEDULED,
                startsAt: {
                  lte: now,
                },
              },
              {
                endsAt: {
                  lte: now,
                },
              },
            ],
          },
        ],
      },
      orderBy: [{ endsAt: 'asc' }, { startsAt: 'asc' }],
      take: GIVEAWAY_DUE_FETCH_BATCH_SIZE,
      select: { id: true, sourceChatId: true },
    });
    const accessBlockedSourceChatIds = await this.findAccessBlockedGiveawaySourceChatIds(
      rows.map((row) => row.sourceChatId),
    );

    let processed = 0;
    for (const row of rows) {
      if (processed >= GIVEAWAY_DUE_BATCH_SIZE) {
        break;
      }
      const sourceChatId = this.normalizeNonEmptyString(row.sourceChatId);
      if (sourceChatId && accessBlockedSourceChatIds.has(sourceChatId)) {
        continue;
      }
      if ((await this.getManagedGiveawayRunnerDeferRemainingMs(row.id)) > 0) {
        continue;
      }
      if ((await this.getManagedGiveawayRunnerBackoffRemainingMs(row.id)) > 0) {
        continue;
      }
      await this.processDueManagedGiveaway(row.id, reason, staleLockBefore);
      processed += 1;
    }
  }

  private async findAccessBlockedGiveawaySourceChatIds(
    sourceChatIds: readonly (string | null | undefined)[],
  ): Promise<Set<string>> {
    const normalizedSourceChatIds = Array.from(
      new Set(
        sourceChatIds
          .map((chatId) => this.normalizeNonEmptyString(chatId))
          .filter((chatId): chatId is string => Boolean(chatId)),
      ),
    );
    if (normalizedSourceChatIds.length === 0) {
      return new Set();
    }

    const [deniedRows, membershipRows, grantedRows] = await Promise.all([
      typeof this.prisma.managedEntityAccessEdge?.findMany === 'function'
        ? this.prisma.managedEntityAccessEdge.findMany({
            where: {
              chatId: { in: normalizedSourceChatIds },
              state: ManagedEntityAccessState.BOT_DENIED,
            },
            select: { chatId: true, botId: true },
          })
        : Promise.resolve([]),
      typeof this.prisma.chatBotMembership?.findMany === 'function'
        ? this.prisma.chatBotMembership.findMany({
            where: {
              chatId: { in: normalizedSourceChatIds },
              status: {
                in: [ChatBotMembershipStatus.ACTIVE, ChatBotMembershipStatus.REMOVED],
              },
            },
            select: {
              chatId: true,
              botId: true,
              status: true,
              permissionsSnapshot: true,
            },
          })
        : Promise.resolve([]),
      typeof this.prisma.managedEntityAccessEdge?.findMany === 'function'
        ? this.prisma.managedEntityAccessEdge.findMany({
            where: {
              chatId: { in: normalizedSourceChatIds },
              state: ManagedEntityAccessState.GRANTED,
              OR: [
                { expiresAt: { gt: new Date() } },
                {
                  expiresAt: null,
                  checkedAt: {
                    gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
                  },
                },
              ],
            },
            select: { chatId: true },
          })
        : Promise.resolve([]),
    ]);
    const activeMembershipChatIds = new Set(
      membershipRows
        .filter((row) => {
          if (row.status !== ChatBotMembershipStatus.ACTIVE) {
            return false;
          }
          const snapshot = normalizeMembershipAccessSnapshot(row.permissionsSnapshot);
          return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
        })
        .map((row) => this.normalizeNonEmptyString(row.chatId))
        .filter((chatId): chatId is string => Boolean(chatId)),
    );
    for (const row of grantedRows) {
      const chatId = this.normalizeNonEmptyString(row.chatId);
      if (chatId) {
        activeMembershipChatIds.add(chatId);
      }
    }

    const removedOnlyMembershipRows = membershipRows.filter(
      (row) =>
        row.status === ChatBotMembershipStatus.REMOVED &&
        !activeMembershipChatIds.has(this.normalizeNonEmptyString(row.chatId) ?? ''),
    );
    return new Set(
      [
        ...deniedRows.filter(
          (row) => !activeMembershipChatIds.has(this.normalizeNonEmptyString(row.chatId) ?? ''),
        ),
        ...removedOnlyMembershipRows,
      ]
        .map((row) => this.normalizeNonEmptyString(row.chatId))
        .filter((chatId): chatId is string => Boolean(chatId)),
    );
  }

  getGiveawaySettingsMiniappUrl(chatId: string, entityType: ManagedEntityType): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `${this.appBaseUrl}/app/channel/${encodedChatId}/settings?focus=giveaway`
      : `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=giveaway`;
  }

  async getCurrentManagedGiveawayForEntity(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawayDetails | null> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const row = await this.prisma.managedGiveaway.findFirst({
      where: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
        status: {
          in: [
            ManagedGiveawayStatus.DRAFT,
            ManagedGiveawayStatus.SCHEDULED,
            ManagedGiveawayStatus.ACTIVE,
            ManagedGiveawayStatus.DRAWING,
            ManagedGiveawayStatus.COMPLETED,
          ],
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    return row ? managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(row)) : null;
  }

  parseClaimStartPayload(payload: string | null): { giveawayId: string; winnerId: string } | null {
    const compactPayload = parseCompactGiveawayClaimStartPayload(
      payload,
      this.maxBotTokenValidationSecrets,
    );
    if (compactPayload) {
      return compactPayload;
    }

    if (!payload || !payload.startsWith(GIVEAWAY_CLAIM_START_PREFIX)) {
      return null;
    }

    const encodedPayload = payload.slice(GIVEAWAY_CLAIM_START_PREFIX.length);
    if (!encodedPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
        v?: number;
        k?: string;
        g?: string;
        w?: string;
        s?: string;
      };
      if (
        parsed.v !== 1 ||
        parsed.k !== 'giveaway-claim' ||
        typeof parsed.g !== 'string' ||
        typeof parsed.w !== 'string' ||
        typeof parsed.s !== 'string'
      ) {
        return null;
      }
      if (!this.isValidGiveawayClaimSignature(parsed.s, parsed.g, parsed.w)) {
        return null;
      }

      return {
        giveawayId: parsed.g.trim(),
        winnerId: parsed.w.trim(),
      };
    } catch {
      return null;
    }
  }

  async getGiveawayClaimContext(
    giveawayId: string,
    winnerId: string,
    userId: string,
  ): Promise<{
    giveaway: ManagedGiveawayDetails;
    winner: ManagedGiveawayWinner;
  } | null> {
    const giveaway = await this.findGiveawayById(giveawayId);
    const winner = giveaway.winners.find(
      (row) =>
        row.id === winnerId &&
        row.entry.userId === userId &&
        row.status !== ManagedGiveawayWinnerStatus.REROLLED,
    );
    if (!winner) {
      return null;
    }

    return {
      giveaway: managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(giveaway)),
      winner: managedGiveawayWinnerSchema.parse(
        this.mapGiveawayWinner(winner, this.buildPrizeDisplayTitleById(giveaway.prizes)),
      ),
    };
  }

  buildGiveawayClaimBotStartUrl(
    giveawayId: string,
    winnerId: string,
    botId?: string | null,
  ): string | null {
    const compactPayload = buildCompactGiveawayClaimStartPayload(
      { giveawayId, winnerId },
      this.getCurrentBotToken(botId),
    );
    const payload =
      compactPayload ??
      `${GIVEAWAY_CLAIM_START_PREFIX}${Buffer.from(
        JSON.stringify({
          v: 1,
          k: 'giveaway-claim',
          g: giveawayId,
          w: winnerId,
          s: this.buildGiveawayClaimSignature(giveawayId, winnerId, this.getCurrentBotToken(botId)),
        }),
        'utf8',
      ).toString('base64url')}`;
    if (!isValidMaxBotStartPayload(payload)) {
      return null;
    }

    const targetBotId = botId?.trim() || this.ownBotUserId;
    return (
      this.maxBotLinkService?.buildBotStartUrlSync(payload, botId) ??
      (targetBotId
        ? `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(payload)}`
        : null)
    );
  }

  getGiveawayPublicMiniappUrl(giveawayId: string): string | null {
    return this.buildGiveawayDirectWebAppUrl(giveawayId);
  }

  private async assertAdminEntityAccess(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<void> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
      return;
    }

    await this.adminService.getSettings(sourceChatId, user);
  }

  private parseManagedGiveawayDraft(body: unknown): UpdateManagedGiveawayRequest {
    const parsed = updateManagedGiveawayRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = normalizeManagedGiveawayDraft(parsed.data);
    if (normalized.imageEnabled) {
      const imageBuffer = this.decodeImageBase64(normalized.imageBase64);
      if (imageBuffer.length > GIVEAWAY_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Изображение розыгрыша слишком большое.');
      }
    }

    return normalized;
  }

  private async ensureNoConcurrentManagedGiveaway(
    sourceChatId: string,
    entityType: ManagedEntityType,
    excludeId?: string | null,
  ): Promise<void> {
    const existing = await this.prisma.managedGiveaway.findFirst({
      where: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
        status: {
          in: [
            ManagedGiveawayStatus.DRAFT,
            ManagedGiveawayStatus.SCHEDULED,
            ManagedGiveawayStatus.ACTIVE,
            ManagedGiveawayStatus.DRAWING,
          ],
        },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: {
        id: true,
      },
    });

    if (existing) {
      throw new BadRequestException(
        'У чата уже есть текущий розыгрыш. Завершите или отмените его.',
      );
    }
  }

  private async findGiveawayForSource(
    sourceChatId: string,
    giveawayId: string,
    entityType: ManagedEntityType,
  ): Promise<PersistedGiveawayWithRelations> {
    const row = await this.prisma.managedGiveaway.findFirst({
      where: {
        id: giveawayId,
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
      },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException('Розыгрыш не найден.');
    }

    return row;
  }

  private async findGiveawayById(giveawayId: string): Promise<PersistedGiveawayWithRelations> {
    const row = await this.prisma.managedGiveaway.findUnique({
      where: { id: giveawayId },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException('Розыгрыш не найден.');
    }

    return row;
  }

  private async findPublicGiveawayById(
    giveawayId: string,
  ): Promise<PersistedGiveawayWithRelations> {
    const giveaway = await this.findGiveawayById(giveawayId);
    if (giveaway.status === ManagedGiveawayStatus.SCHEDULED) {
      await this.activateScheduledGiveawayIfDue(giveaway);
    }

    const refreshed = await this.findGiveawayById(giveawayId);
    this.assertGiveawayPubliclyAccessible(refreshed);
    return refreshed;
  }

  private assertGiveawayPubliclyAccessible(giveaway: PersistedGiveawayWithRelations): void {
    const hasPublicReference =
      Boolean(giveaway.publishedAt) ||
      Boolean(giveaway.publicationMessageId?.trim()) ||
      Boolean(giveaway.publicationUrl?.trim()) ||
      Boolean(giveaway.resultsMessageId?.trim()) ||
      Boolean(giveaway.resultsUrl?.trim());

    if (giveaway.status === ManagedGiveawayStatus.DRAFT) {
      throw new NotFoundException('Розыгрыш не найден.');
    }

    if (giveaway.status === ManagedGiveawayStatus.CANCELED && !hasPublicReference) {
      throw new NotFoundException('Розыгрыш не найден.');
    }
  }

  private mapGiveawaySummary(
    row: PersistedManagedGiveaway & {
      entries: Array<{ eligibilityState: GiveawayEligibilityState }>;
      winners: Array<{ id: string }>;
    },
  ): ManagedGiveawaySummary {
    const entriesCount = row.entries.length;
    const verifiedEntriesCount = row.entries.filter(
      (entry) => entry.eligibilityState === GiveawayEligibilityState.VERIFIED,
    ).length;
    const pendingEntriesCount = row.entries.filter(
      (entry) => entry.eligibilityState === GiveawayEligibilityState.PENDING,
    ).length;

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      hasImage: row.imageEnabled,
      entriesCount,
      verifiedEntriesCount,
      pendingEntriesCount,
      winnersCount: row.winners.length,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      publicationUrl: row.publicationUrl ?? null,
      resultsUrl: row.resultsUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapGiveawayDetails(row: PersistedGiveawayWithRelations): ManagedGiveawayDetails {
    const summary = this.mapGiveawaySummary({
      ...row,
      winners: row.winners.filter(
        (winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED,
      ),
    });
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(row.prizes);

    return {
      ...summary,
      sourceChatId: row.sourceChatId,
      entityType: this.fromPrismaEntityType(row.entityType),
      description: row.description,
      imageEnabled: row.imageEnabled,
      imageBase64: row.imageBase64,
      imageMimeType: row.imageMimeType,
      imageFileName: row.imageFileName,
      claimHours: row.claimHours,
      requiredChannelIds: this.readRequiredChannelIds(row.requiredChannelIds),
      publicationMessageId: row.publicationMessageId ?? null,
      resultsMessageId: row.resultsMessageId ?? null,
      prizes: row.prizes.map((prize) => ({
        id: prize.id,
        position: prize.position,
        title: prize.title,
        displayTitle: prizeDisplayTitleById.get(prize.id) ?? this.resolvePrizeDisplayTitle(prize),
      })),
      winners: row.winners
        .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
        .sort((left, right) => left.prize.position - right.prize.position)
        .map((winner) => this.mapGiveawayWinner(winner, prizeDisplayTitleById)),
    };
  }

  private resolvePrizeDisplayTitle(prize: PersistedManagedGiveawayPrize): string {
    const displayTitle =
      typeof prize.displayTitle === 'string' ? prize.displayTitle.trim() : '';
    if (displayTitle) {
      return displayTitle;
    }

    const title = prize.title.trim();
    return title || `${prize.position} место`;
  }

  private parseLegacyNumberedPrizeTitle(value: string): { base: string; ordinal: number } | null {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    const match = /^(.+?)\s+(\d{1,3})$/u.exec(normalized);
    if (!match) {
      return null;
    }

    const base = (match[1] ?? '').trim().replace(/\s+/gu, ' ');
    const ordinal = Number(match[2]);
    if (!base || !Number.isInteger(ordinal) || ordinal < 1) {
      return null;
    }

    return { base, ordinal };
  }

  private buildPrizeDisplayTitleById(
    prizes: PersistedManagedGiveawayPrize[],
  ): Map<string, string> {
    const sortedPrizes = [...prizes].sort((left, right) => left.position - right.position);
    const titlesById = new Map<string, string>();
    const legacyGroups = new Map<string, { ids: string[]; ordinals: number[] }>();

    for (const prize of sortedPrizes) {
      const explicitTitle =
        typeof prize.displayTitle === 'string' ? prize.displayTitle.trim() : '';
      if (explicitTitle) {
        titlesById.set(prize.id, explicitTitle);
        continue;
      }

      const parsed = this.parseLegacyNumberedPrizeTitle(prize.title);
      if (!parsed) {
        titlesById.set(prize.id, this.resolvePrizeDisplayTitle(prize));
        continue;
      }

      const group = legacyGroups.get(parsed.base) ?? { ids: [], ordinals: [] };
      group.ids.push(prize.id);
      group.ordinals.push(parsed.ordinal);
      legacyGroups.set(parsed.base, group);
    }

    for (const [base, group] of legacyGroups.entries()) {
      const uniqueOrdinals = new Set(group.ordinals);
      const canTreatAsRepeatedPrize =
        group.ids.length > 1 &&
        uniqueOrdinals.size === group.ids.length &&
        group.ordinals.every((ordinal) => ordinal >= 1 && ordinal <= group.ids.length);

      for (const id of group.ids) {
        if (!titlesById.has(id)) {
          const prize = sortedPrizes.find((item) => item.id === id);
          titlesById.set(
            id,
            canTreatAsRepeatedPrize ? base : this.resolvePrizeDisplayTitle(prize!),
          );
        }
      }
    }

    return titlesById;
  }

  private async mapPublicGiveaway(
    row: PersistedGiveawayWithRelations,
  ): Promise<ManagedGiveawayPublic> {
    const requiredChannelIds = this.readRequiredChannelIds(row.requiredChannelIds).filter(
      (channelId) => channelId !== row.sourceChatId,
    );
    const [sourceTitle, sourceLink, requiredChannels] = await Promise.all([
      this.resolveSourceTitle(row.sourceChatId),
      this.resolveChatLink(row.sourceChatId),
      Promise.all(
        requiredChannelIds.map(async (channelId) => ({
          id: channelId,
          title: await this.resolveSourceTitle(channelId),
          link: await this.resolveChatLink(channelId),
        })),
      ),
    ]);
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(row.prizes);

    return {
      id: row.id,
      sourceChatId: row.sourceChatId,
      sourceTitle,
      sourceLink,
      entityType: this.fromPrismaEntityType(row.entityType),
      title: row.title,
      description: row.description,
      status: row.status,
      imageEnabled: row.imageEnabled,
      imageBase64: row.imageBase64,
      imageMimeType: row.imageMimeType,
      imageFileName: row.imageFileName,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt.toISOString(),
      claimHours: row.claimHours,
      requiredChannelIds,
      requiredChannels,
      entriesCount: this.countPublicGiveawayEntries(row.entries),
      winnersCount: row.winners.filter(
        (winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED,
      ).length,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      publicationUrl: row.publicationUrl ?? null,
      resultsUrl: row.resultsUrl ?? null,
      prizes: row.prizes.map((prize) => ({
        id: prize.id,
        position: prize.position,
        title: prize.title,
        displayTitle: prizeDisplayTitleById.get(prize.id) ?? this.resolvePrizeDisplayTitle(prize),
      })),
      winners:
        row.status === ManagedGiveawayStatus.COMPLETED
          ? row.winners
              .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
              .sort((left, right) => left.prize.position - right.prize.position)
              .map((winner) => ({
                prizePosition: winner.prize.position,
                prizeTitle: winner.prize.title,
                prizeDisplayTitle:
                  prizeDisplayTitleById.get(winner.prize.id) ??
                  this.resolvePrizeDisplayTitle(winner.prize),
                displayName: this.resolvePublicWinnerDisplayName(winner),
                status: this.resolveEffectiveWinnerStatus(winner),
              }))
          : [],
    };
  }

  private mapParticipantState(
    row: PersistedGiveawayWithRelations,
    userId: string,
  ): ManagedGiveawayParticipantState {
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(row.prizes);
    const entry = row.entries.find((item) => item.userId === userId) ?? null;
    const winner = entry
      ? (row.winners.find(
          (item) =>
            item.entryId === entry.id && item.status !== ManagedGiveawayWinnerStatus.REROLLED,
        ) ?? null)
      : null;
    const winnerStatus = winner ? this.resolveEffectiveWinnerStatus(winner) : null;
    const canClaim =
      winner?.id && winnerStatus === ManagedGiveawayWinnerStatus.SELECTED
        ? !this.isGiveawayClaimDeadlineExpired(winner, Date.now())
        : false;
    return {
      joined: Boolean(entry),
      entryId: entry?.id ?? null,
      eligibilityState: entry ? giveawayEligibilityStateSchema.parse(entry.eligibilityState) : null,
      eligibilityReason: entry?.eligibilityReason ?? null,
      missingChannelIds:
        entry?.eligibilityState === GiveawayEligibilityState.REJECTED
          ? (() => {
              const storedMissingChannelIds = this.readMissingChannelIds(entry.missingChannelIds);
              return storedMissingChannelIds.length > 0
                ? storedMissingChannelIds
                : this.buildGiveawayMandatoryChannelIds(row);
            })()
          : [],
      joinedAt: entry?.joinedAt.toISOString() ?? null,
      isWinner: Boolean(winner),
      winnerId: winner?.id ?? null,
      winnerStatus,
      claimDeadlineAt: winner?.claimDeadlineAt?.toISOString() ?? null,
      prizePosition: winner?.prize.position ?? null,
      prizeTitle: winner?.prize.title ?? null,
      prizeDisplayTitle: winner
        ? (prizeDisplayTitleById.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize))
        : null,
      canClaim,
      claimBotUrl:
        canClaim && winner ? this.buildGiveawayClaimBotStartUrl(row.id, winner.id) : null,
    };
  }

  private mapGiveawayWinner(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
    prizeDisplayTitleById?: Map<string, string>,
  ): ManagedGiveawayWinner {
    return {
      id: winner.id,
      prizeId: winner.prizeId,
      prizePosition: winner.prize.position,
      prizeTitle: winner.prize.title,
      prizeDisplayTitle:
        prizeDisplayTitleById?.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize),
      entryId: winner.entryId,
      userId: winner.entry.userId,
      displayName: winner.entry.displayName ?? null,
      status: this.resolveEffectiveWinnerStatus(winner),
      selectedAt: winner.selectedAt.toISOString(),
      claimDeadlineAt: winner.claimDeadlineAt?.toISOString() ?? null,
      claimedAt: winner.claimedAt?.toISOString() ?? null,
      deliveredAt: winner.deliveredAt?.toISOString() ?? null,
      expiredAt: winner.expiredAt?.toISOString() ?? null,
      rerolledAt: winner.rerolledAt?.toISOString() ?? null,
    };
  }

  private resolvePublicWinnerDisplayName(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
  ): string | null {
    const status = this.resolveEffectiveWinnerStatus(winner);
    return status === ManagedGiveawayWinnerStatus.SELECTED ||
      status === ManagedGiveawayWinnerStatus.CLAIMED ||
      status === ManagedGiveawayWinnerStatus.DELIVERED
      ? (winner.entry.displayName ?? null)
      : null;
  }

  private resolveEffectiveWinnerStatus(
    winner: PersistedManagedGiveawayWinner,
  ): ManagedGiveawayWinnerStatus {
    if (
      winner.status === ManagedGiveawayWinnerStatus.SELECTED &&
      this.isGiveawayClaimDeadlineExpired(winner, Date.now())
    ) {
      return ManagedGiveawayWinnerStatus.EXPIRED;
    }

    return winner.status;
  }

  private isGiveawayClaimDeadlineExpired(
    winner: Pick<PersistedManagedGiveawayWinner, 'claimDeadlineAt'>,
    nowMs: number,
  ): boolean {
    return Boolean(winner.claimDeadlineAt && winner.claimDeadlineAt.getTime() <= nowMs);
  }

  private buildGiveawayClaimDeadlineAt(
    giveaway: Pick<PersistedManagedGiveaway, 'claimHours'>,
    base: Date,
  ): Date | null {
    const claimHours = Number.isInteger(giveaway.claimHours)
      ? Math.max(1, Math.min(336, giveaway.claimHours))
      : 24;
    return new Date(base.getTime() + claimHours * 60 * 60 * 1_000);
  }

  private formatPublicWinnerName(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
    useRichText = false,
  ): string {
    const displayName = this.resolvePublicWinnerDisplayName(winner);
    if (!displayName) {
      return 'победитель определён';
    }

    if (!useRichText) {
      return displayName;
    }

    return `[${this.escapeMarkdown(displayName)}](max://user/${encodeURIComponent(winner.entry.userId)})`;
  }

  private pickNextRerollCandidate(
    giveaway: PersistedGiveawayWithRelations,
    drawSeed: string,
  ): GiveawayRerollCandidate | null {
    const excludedEntryIds = new Set(giveaway.winners.map((row) => row.entryId));
    return (
      giveaway.entries
        .filter((entry) => entry.eligibilityState === GiveawayEligibilityState.VERIFIED)
        .map((entry) => ({
          entry,
          drawRank: entry.drawRank ?? buildManagedGiveawayDrawRank(drawSeed, entry.userId),
        }))
        .filter(({ entry }) => !excludedEntryIds.has(entry.id))
        .sort(
          (left, right) =>
            left.drawRank.localeCompare(right.drawRank) ||
            left.entry.userId.localeCompare(right.entry.userId),
        )[0] ?? null
    );
  }

  private async uploadGiveawayImage(
    giveaway: Pick<
      PersistedManagedGiveaway,
      'imageEnabled' | 'imageBase64' | 'imageMimeType' | 'imageFileName'
    >,
    botId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (!giveaway.imageEnabled) {
      return undefined;
    }

    try {
      const imageBuffer = this.decodeImageBase64(giveaway.imageBase64);
      return botId
        ? await this.maxClient.uploadImage(
            imageBuffer,
            this.resolveImageFileName(giveaway.imageFileName, giveaway.imageMimeType),
            giveaway.imageMimeType,
            { botId },
          )
        : await this.maxClient.uploadImage(
            imageBuffer,
            this.resolveImageFileName(giveaway.imageFileName, giveaway.imageMimeType),
            giveaway.imageMimeType,
          );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to upload giveaway image',
      );
      throw new BadRequestException('Не удалось загрузить изображение розыгрыша.');
    }
  }

  private async buildGiveawayEntryButton(
    giveaway: Pick<PersistedGiveawayWithRelations, 'id' | 'sourceChatId' | 'entries'>,
  ): Promise<MaxMessageButton | null> {
    return this.buildGiveawayMiniappButton(
      giveaway.sourceChatId,
      giveaway.id,
      `Участвовать · ${this.formatGiveawayEntriesCount(
        this.countPublicGiveawayEntries(giveaway.entries),
      )}`,
    );
  }

  private async buildGiveawayOpenButton(
    giveaway: Pick<PersistedGiveawayWithRelations, 'id' | 'sourceChatId'>,
  ): Promise<MaxMessageButton | null> {
    return this.buildGiveawayMiniappButton(giveaway.sourceChatId, giveaway.id, 'Открыть розыгрыш');
  }

  private async buildGiveawayResultsButton(
    giveaway: Pick<PersistedGiveawayWithRelations, 'id' | 'sourceChatId'>,
  ): Promise<MaxMessageButton | null> {
    return this.buildGiveawayMiniappButton(
      giveaway.sourceChatId,
      giveaway.id,
      'Проверить результаты',
    );
  }

  private async buildGiveawayMiniappButton(
    sourceChatId: string,
    giveawayId: string,
    text: string,
  ): Promise<MaxMessageButton | null> {
    const botId = await this.resolveGiveawayButtonBotId(sourceChatId);
    const launchUrl = this.buildGiveawayLaunchUrl(giveawayId);

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    const webAppUrl = this.buildGiveawayDirectWebAppUrl(giveawayId);
    const botContactId = this.resolveBotContactId(botId);

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    if (webAppUrl) {
      return {
        type: 'link',
        text,
        url: webAppUrl,
      };
    }

    return null;
  }

  private formatGiveawayEntriesCount(value: number): string {
    if (value >= 1_000_000) {
      const normalized =
        value >= 10_000_000 ? (value / 1_000_000).toFixed(0) : (value / 1_000_000).toFixed(1);
      return `${normalized.replace(/\.0$/u, '')}M`;
    }

    if (value >= 1_000) {
      const normalized = value >= 10_000 ? (value / 1_000).toFixed(0) : (value / 1_000).toFixed(1);
      return `${normalized.replace(/\.0$/u, '')}K`;
    }

    return String(Math.max(0, value));
  }

  private countPublicGiveawayEntries(
    entries: ReadonlyArray<{ eligibilityState: GiveawayEligibilityState }>,
  ): number {
    return entries.filter((entry) => entry.eligibilityState !== GiveawayEligibilityState.REJECTED)
      .length;
  }

  private buildGiveawayPublicationText(
    giveaway: Pick<PersistedGiveawayWithRelations, 'description' | 'title'>,
  ): string {
    const description = giveaway.description.trim();
    if (description) {
      return description;
    }

    const title = giveaway.title.trim();
    if (title) {
      return title;
    }

    return 'Розыгрыш';
  }

  private buildFormattedGiveawayTextPayload(sourceText: string): {
    text: string;
    textFormat?: MaxSendMessageOptions['textFormat'];
  } {
    const textFormat = containsSupportedMarkdownSyntax(sourceText) ? 'html' : undefined;
    return {
      text: textFormat === 'html' ? renderSupportedMarkdownAsHtml(sourceText) : sourceText,
      ...(textFormat ? { textFormat } : {}),
    };
  }

  private buildGiveawayResultsTextPayload(giveaway: PersistedGiveawayWithRelations): {
    text: string;
    textFormat?: MaxSendMessageOptions['textFormat'];
  } {
    const text = this.buildGiveawayResultsText(giveaway);
    return containsSupportedMarkdownSyntax(text) ? { text, textFormat: 'markdown' } : { text };
  }

  private buildGiveawayResultsText(giveaway: PersistedGiveawayWithRelations): string {
    const lines: string[] = ['🎉 Результаты розыгрыша:'];
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(giveaway.prizes);
    const currentWinners = giveaway.winners
      .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
      .sort((left, right) => left.prize.position - right.prize.position);
    const hasPublicationReference = Boolean(giveaway.publicationMessageId?.trim());
    const useRichText = currentWinners.some((winner) =>
      Boolean(this.resolvePublicWinnerDisplayName(winner)),
    );
    const shouldShowPrizeTitle =
      currentWinners.length > 1 &&
      currentWinners.some((winner) => {
        const title = (
          prizeDisplayTitleById.get(winner.prize.id) ??
          this.resolvePrizeDisplayTitle(winner.prize)
        ).trim();
        return title.length > 0 && title !== `${winner.prize.position} место`;
      });

    if (!hasPublicationReference && giveaway.title.trim()) {
      lines.push(
        '',
        useRichText ? this.escapeMarkdown(giveaway.title.trim()) : giveaway.title.trim(),
      );
    }

    if (currentWinners.length === 0) {
      lines.push('', 'Подходящих участников не нашлось.');
      return lines.join('\n');
    }

    lines.push('', currentWinners.length === 1 ? '🏆 Победитель:' : '🏆 Победители:', '');
    for (const winner of currentWinners) {
      const effectiveStatus = this.resolveEffectiveWinnerStatus(winner);
      const publicName = this.resolvePublicWinnerDisplayName(winner);
      if (!publicName) {
        lines.push(
          effectiveStatus === ManagedGiveawayWinnerStatus.EXPIRED
            ? `${winner.prize.position}. Место освобождено, можно запустить реролл`
            : `${winner.prize.position}. Победитель определён`,
        );
        continue;
      }

      const prizeTitle = (
        prizeDisplayTitleById.get(winner.prize.id) ??
        this.resolvePrizeDisplayTitle(winner.prize)
      ).trim();
      const prizeSuffix = shouldShowPrizeTitle
        ? ` — ${useRichText ? this.escapeMarkdown(prizeTitle) : prizeTitle}`
        : '';
      const statusSuffix =
        effectiveStatus === ManagedGiveawayWinnerStatus.DELIVERED ? ' (приз выдан)' : '';
      lines.push(
        `${winner.prize.position}. ${this.formatPublicWinnerName(winner, useRichText)}${prizeSuffix}${statusSuffix}`,
      );
    }

    return lines.join('\n');
  }

  private async buildGiveawayResultsMessageOptions(
    giveaway: PersistedGiveawayWithRelations,
  ): Promise<MaxSendMessageOptions | undefined> {
    const button = await this.buildGiveawayResultsButton(giveaway);
    const publicationMessageId = giveaway.publicationMessageId?.trim() ?? '';

    if (!button && !publicationMessageId) {
      return undefined;
    }

    return {
      ...(button ? { buttons: [[button]] } : {}),
      ...(publicationMessageId
        ? {
            messageLink: {
              type: 'reply' as const,
              mid: publicationMessageId,
            },
          }
        : {}),
    };
  }

  private mergeMessageOptionsWithTextFormat(
    options: MaxSendMessageOptions | undefined,
    textFormat: MaxSendMessageOptions['textFormat'] | undefined,
  ): MaxSendMessageOptions | undefined {
    if (!options && !textFormat) {
      return undefined;
    }

    return {
      ...(options ?? {}),
      ...(textFormat ? { textFormat } : {}),
    };
  }

  private buildWinnerNotificationKey(entryId: string, prizeId: string): string {
    return `${entryId}:${prizeId}`;
  }

  private buildGiveawayWinnerDirectMessageText(
    giveaway: PersistedGiveawayWithRelations,
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
  ): string {
    const lines = ['🎉 Вы выиграли в розыгрыше!'];
    const title = giveaway.title.trim();
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(giveaway.prizes);
    const prizeTitle = (
      prizeDisplayTitleById.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize)
    ).trim();

    if (title) {
      lines.push('', title);
    }

    lines.push('', `Место: ${winner.prize.position}`);
    if (prizeTitle && prizeTitle !== `${winner.prize.position} место`) {
      lines.push(`Приз: ${prizeTitle}`);
    }

    if (winner.claimDeadlineAt) {
      lines.push(`До: ${winner.claimDeadlineAt.toLocaleString('ru-RU')}`);
    }

    lines.push('', 'Итоги уже опубликованы в группе.');
    return lines.join('\n');
  }

  private buildGiveawayWinnerDirectMessageOptions(
    giveaway: PersistedGiveawayWithRelations,
    winner: PersistedManagedGiveawayWinner,
    botId?: string | null,
  ): MaxSendMessageOptions | undefined {
    const claimRow: MaxMessageButton[] = [];
    const claimUrl =
      this.resolveEffectiveWinnerStatus(winner) === ManagedGiveawayWinnerStatus.SELECTED
        ? this.buildGiveawayClaimBotStartUrl(giveaway.id, winner.id, botId)
        : null;
    if (claimUrl) {
      claimRow.push({
        type: 'link',
        text: 'Забрать приз',
        url: claimUrl,
      });
    }

    const referenceRow: MaxMessageButton[] = [];

    if (giveaway.publicationUrl) {
      referenceRow.push({
        type: 'link',
        text: 'Открыть пост',
        url: giveaway.publicationUrl,
      });
    }

    if (giveaway.resultsUrl) {
      referenceRow.push({
        type: 'link',
        text: 'Итоги',
        url: giveaway.resultsUrl,
      });
    }

    const buttons = [claimRow, referenceRow].filter((row) => row.length > 0);
    return buttons.length > 0 ? { buttons } : undefined;
  }

  private async sendWinnerDirectMessages(
    giveaway: PersistedGiveawayWithRelations,
    targetWinnerKeys: string[],
  ): Promise<void> {
    const targetKeys = new Set(targetWinnerKeys);
    if (targetKeys.size === 0) {
      return;
    }

    const winners = giveaway.winners.filter(
      (winner) =>
        winner.status !== ManagedGiveawayWinnerStatus.REROLLED &&
        targetKeys.has(this.buildWinnerNotificationKey(winner.entryId, winner.prizeId)),
    );
    const notificationBotId = await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId);

    for (const winner of winners) {
      try {
        const text = this.buildGiveawayWinnerDirectMessageText(giveaway, winner);
        const options = this.buildGiveawayWinnerDirectMessageOptions(
          giveaway,
          winner,
          notificationBotId,
        );
        if (notificationBotId) {
          await this.maxClient.sendMessageImmediateToUser(winner.entry.userId, text, options, {
            botId: notificationBotId,
          });
        } else {
          await this.maxClient.sendMessageImmediateToUser(winner.entry.userId, text, options);
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            winnerId: winner.id,
            userId: winner.entry.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to send direct giveaway winner message',
        );
      }
    }
  }

  private async editGiveawayPublicationIfNeeded(
    giveaway: PersistedGiveawayWithRelations,
    status: ManagedGiveawayStatus,
  ): Promise<void> {
    const messageId = giveaway.publicationMessageId?.trim() ?? '';
    if (!messageId) {
      return;
    }

    let publicationBotId: string | undefined;
    try {
      publicationBotId = await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId);
      if (status === ManagedGiveawayStatus.CANCELED) {
        const button = await this.buildGiveawayOpenButton(giveaway);
        const options = button ? { buttons: [[button]] } : undefined;
        if (publicationBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
            { botId: publicationBotId },
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
          );
        }
        return;
      }

      if (status === ManagedGiveawayStatus.ACTIVE) {
        const button = await this.buildGiveawayEntryButton(giveaway);
        const options = button ? { buttons: [[button]] } : undefined;
        if (publicationBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
            { botId: publicationBotId },
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
          );
        }
        return;
      }

      const button = await this.buildGiveawayOpenButton(giveaway);
      const options = button ? { buttons: [[button]] } : undefined;
      if (publicationBotId) {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          messageId,
          null,
          options,
          { botId: publicationBotId },
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          messageId,
          null,
          options,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          sourceChatId: giveaway.sourceChatId,
          status,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to edit giveaway publication message',
      );
      await this.recordManagedGiveawayMaxAccessLoss({
        giveaway,
        botId: publicationBotId ?? null,
        source: 'managed_giveaway:publication',
        operation: 'edit',
        error,
      });
    }
  }

  private async republishGiveawayResults(giveaway: PersistedGiveawayWithRelations): Promise<void> {
    const publicationBotId = await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId);
    const resultsTextPayload = this.buildGiveawayResultsTextPayload(giveaway);
    const resultOptions = this.mergeMessageOptionsWithTextFormat(
      await this.buildGiveawayResultsMessageOptions(giveaway),
      resultsTextPayload.textFormat,
    );
    if (!giveaway.resultsMessageId?.trim()) {
      try {
        const result = publicationBotId
          ? await this.maxClient.sendMessageImmediateWithResolvedLink(
              giveaway.sourceChatId,
              resultsTextPayload.text,
              resultOptions,
              { botId: publicationBotId },
            )
          : await this.maxClient.sendMessageImmediateWithResolvedLink(
              giveaway.sourceChatId,
              resultsTextPayload.text,
              resultOptions,
            );
        await this.prisma.managedGiveaway.update({
          where: { id: giveaway.id },
          data: {
            resultsMessageId: result.messageId,
            resultsUrl: result.url,
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to publish giveaway results message',
        );
        await this.recordManagedGiveawayMaxAccessLoss({
          giveaway,
          botId: publicationBotId ?? null,
          source: 'managed_giveaway:results',
          operation: 'send',
          error,
        });
      }
      return;
    }

    try {
      if (publicationBotId) {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          giveaway.resultsMessageId,
          resultsTextPayload.text,
          resultOptions,
          { botId: publicationBotId },
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          giveaway.resultsMessageId,
          resultsTextPayload.text,
          resultOptions,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh giveaway results message',
      );
      await this.recordManagedGiveawayMaxAccessLoss({
        giveaway,
        botId: publicationBotId ?? null,
        source: 'managed_giveaway:results',
        operation: 'edit',
        error,
      });
    }
  }

  private async recordManagedGiveawayMaxAccessLoss(params: {
    giveaway: PersistedGiveawayWithRelations;
    botId: string | null;
    source: string;
    operation: 'send' | 'edit';
    error: unknown;
  }): Promise<void> {
    try {
      const result =
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
          chatId: params.giveaway.sourceChatId,
          botId: params.botId,
          entityType: params.giveaway.entityType,
          source: params.source,
          operation: params.operation,
          error: params.error,
        });
      if (result?.recorded) {
        this.logger.warn(
          {
            giveawayId: params.giveaway.id,
            sourceChatId: params.giveaway.sourceChatId,
            botId: params.botId,
            source: params.source,
            operation: params.operation,
            reason: result.reason,
          },
          'Managed giveaway source lost MAX access and runtime work was stopped',
        );
      }
    } catch (accessLossError: unknown) {
      this.logger.debug(
        {
          giveawayId: params.giveaway.id,
          sourceChatId: params.giveaway.sourceChatId,
          err: accessLossError instanceof Error ? accessLossError.message : String(accessLossError),
        },
        'Failed to record managed giveaway MAX access loss',
      );
    }
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/([\\_*[\]()`~+])/g, '\\$1');
  }

  private assertGiveawayOpenForEntry(giveaway: PersistedGiveawayWithRelations): void {
    const now = Date.now();
    if (giveaway.status !== ManagedGiveawayStatus.ACTIVE) {
      throw new BadRequestException(
        giveaway.status === ManagedGiveawayStatus.SCHEDULED
          ? 'Розыгрыш ещё не стартовал.'
          : 'Участие в этом розыгрыше уже закрыто.',
      );
    }
    if (giveaway.startsAt && giveaway.startsAt.getTime() > now) {
      throw new BadRequestException('Розыгрыш ещё не стартовал.');
    }
    if (giveaway.endsAt.getTime() <= now) {
      throw new BadRequestException('Розыгрыш уже завершён.');
    }
  }

  private async evaluateGiveawayEligibility(
    giveaway: PersistedGiveawayWithRelations,
    userId: string,
    options: GiveawayEligibilityCheckOptions = {},
  ): Promise<GiveawayEligibilityResult> {
    const additionalRequiredChannels = this.readRequiredChannelIds(
      giveaway.requiredChannelIds,
    ).filter((channelId) => channelId !== giveaway.sourceChatId);
    const mandatoryChannelIds = [giveaway.sourceChatId, ...additionalRequiredChannels];
    const lookupBotIdByChannelId =
      await this.resolveGiveawayMembershipLookupBotIds(mandatoryChannelIds);
    const missingChannelIds: string[] = [];

    if (this.membershipLookupService) {
      const lookupPolicy = this.resolveGiveawayLookupPolicy(options);

      for (const channelId of mandatoryChannelIds) {
        const botId = lookupBotIdByChannelId.get(channelId) ?? null;
        const membership = await this.membershipLookupService.getMembership(
          channelId,
          userId,
          lookupPolicy,
          {
            forceRefresh: options.forceFreshMembership,
            allowStaleOnError: options.allowStaleMembershipOnError,
            ...(botId ? { botId } : {}),
          },
        );
        if (membership === null) {
          return this.resolveGiveawayEligibilityLookupFailure(giveaway, userId, {
            ...options,
            failedChannelId: channelId,
          });
        }
        if (!membership) {
          missingChannelIds.push(channelId);
        }
      }

      return this.buildGiveawayEligibilityResult(giveaway, missingChannelIds, options);
    }

    try {
      const sourceBotId = lookupBotIdByChannelId.get(giveaway.sourceChatId) ?? null;
      const isMember = await this.maxClient.hasChatMember(giveaway.sourceChatId, userId, {
        ...(sourceBotId ? { botId: sourceBotId } : {}),
      });
      if (!isMember) {
        missingChannelIds.push(giveaway.sourceChatId);
      }

      for (const channelId of additionalRequiredChannels) {
        const botId = lookupBotIdByChannelId.get(channelId) ?? null;
        const hasAdditionalSubscription = await this.maxClient.hasChatMember(channelId, userId, {
          ...(botId ? { botId } : {}),
        });
        if (!hasAdditionalSubscription) {
          missingChannelIds.push(channelId);
        }
      }

      return this.buildGiveawayEligibilityResult(giveaway, missingChannelIds, options);
    } catch (error: unknown) {
      return this.resolveGiveawayEligibilityLookupFailure(giveaway, userId, options, error);
    }
  }

  private resolveGiveawayLookupPolicy(
    options: GiveawayEligibilityCheckOptions,
  ): MaxMembershipLookupPolicy {
    if (options.lookupPolicy) {
      return options.lookupPolicy;
    }

    if (options.strictChannelCheck) {
      return 'giveaway_strict';
    }

    if (options.forceFreshMembership) {
      return 'giveaway_draw_interactive';
    }

    return 'giveaway_interactive';
  }

  private buildGiveawayEligibilityResult(
    giveaway: PersistedGiveawayWithRelations,
    missingChannelIds: string[],
    options: GiveawayEligibilityCheckOptions = {},
  ): GiveawayEligibilityResult {
    const entityType = this.fromPrismaEntityType(giveaway.entityType);
    if (missingChannelIds.length === 0) {
      return {
        state: GiveawayEligibilityState.VERIFIED,
        reason: null,
        missingChannelIds: [],
      };
    }

    if (missingChannelIds.includes(giveaway.sourceChatId)) {
      if (entityType === 'chat' || options.strictChannelCheck) {
        return {
          state: GiveawayEligibilityState.REJECTED,
          reason: 'Участник не найден в исходном чате/канале.',
          missingChannelIds,
        };
      }

      return {
        state: GiveawayEligibilityState.REJECTED,
        reason:
          missingChannelIds.length > 1
            ? 'Подписка на источник и обязательные чаты/каналы не подтверждена.'
            : 'Подписка на источник не подтверждена.',
        missingChannelIds,
      };
    }

    return {
      state: GiveawayEligibilityState.REJECTED,
      reason:
        missingChannelIds.length > 1
          ? 'Подписка на обязательные чаты/каналы не подтверждена.'
          : 'Подписка на обязательный чат/канал не подтверждена.',
      missingChannelIds,
    };
  }

  private resolveGiveawayEligibilityLookupFailure(
    giveaway: PersistedGiveawayWithRelations,
    userId: string,
    options: GiveawayEligibilityCheckOptions = {},
    error?: unknown,
  ): GiveawayEligibilityResult {
    const entityType = this.fromPrismaEntityType(giveaway.entityType);
    if (entityType === 'chat' || options.strictChannelCheck) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          sourceChatId: giveaway.sourceChatId,
          userId,
          failedChannelId: options.failedChannelId ?? giveaway.sourceChatId,
          lookupPolicy: options.lookupPolicy ?? null,
          lookupIssueKind:
            options.failedChannelId && options.lookupPolicy && this.membershipLookupService
              ? (this.membershipLookupService.getLookupIssue(
                  options.failedChannelId,
                  options.lookupPolicy,
                )?.kind ?? null)
              : null,
          err:
            error instanceof Error
              ? error.message
              : error
                ? String(error)
                : 'membership lookup unavailable',
        },
        'Failed to verify giveaway participant strictly',
      );
      const lookupIssue =
        options.failedChannelId && options.lookupPolicy && this.membershipLookupService
          ? this.membershipLookupService.getLookupIssue(
              options.failedChannelId,
              options.lookupPolicy,
            )
          : null;
      if (options.lookupPolicy !== 'giveaway_draw_background') {
        throw new BadRequestException(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
      }
      throw new ManagedGiveawayMembershipLookupUnavailableError(
        lookupIssue?.kind ?? 'transient',
        options.failedChannelId ?? giveaway.sourceChatId,
        lookupIssue?.retryAfterMs ?? null,
      );
    }

    return {
      state: GiveawayEligibilityState.PENDING,
      reason: 'MAX пока не подтвердил участие. Проверим ещё раз при подведении итогов.',
      missingChannelIds: [],
    };
  }

  private readRequiredChannelIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);

    return Array.from(new Set(normalized));
  }

  private readMissingChannelIds(value: Prisma.JsonValue | null | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    );
  }

  private areSameStringSets(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
  }

  private resolveGiveawayEntryAuditAction(
    existing: PersistedManagedGiveawayEntry | null,
    saved: PersistedManagedGiveawayEntry,
  ): GiveawayEntryAuditAction | null {
    if (!existing) {
      return 'ENTER_GIVEAWAY';
    }

    const existingMissingChannelIds = this.readMissingChannelIds(existing.missingChannelIds);
    const savedMissingChannelIds = this.readMissingChannelIds(saved.missingChannelIds);

    if (
      existing.eligibilityState === saved.eligibilityState &&
      (existing.eligibilityReason ?? null) === (saved.eligibilityReason ?? null) &&
      this.areSameStringSets(existingMissingChannelIds, savedMissingChannelIds)
    ) {
      return null;
    }

    return 'RECHECK_GIVEAWAY_ENTRY';
  }

  private resolveDrawEligibilityResult(
    entry: PersistedManagedGiveawayEntry,
    result: GiveawayEligibilityResult,
  ): GiveawayEligibilityResult {
    if (
      entry.eligibilityState === GiveawayEligibilityState.VERIFIED &&
      result.state === GiveawayEligibilityState.PENDING
    ) {
      return {
        state: GiveawayEligibilityState.VERIFIED,
        reason: null,
        missingChannelIds: [],
      };
    }

    return result;
  }

  private buildGiveawayMandatoryChannelIds(row: PersistedGiveawayWithRelations): string[] {
    return Array.from(
      new Set([row.sourceChatId, ...this.readRequiredChannelIds(row.requiredChannelIds)]),
    );
  }

  private async evaluateGiveawayEligibilityForDraw(
    giveaway: PersistedGiveawayWithRelations,
    entries: PersistedManagedGiveawayEntry[],
    source: GiveawayActionSource,
  ): Promise<Map<string, GiveawayEligibilityResult>> {
    if (!this.membershipLookupService) {
      const results: Array<[string, GiveawayEligibilityResult]> = await Promise.all(
        entries.map(async (entry) => [
          entry.userId,
          await this.evaluateGiveawayEligibility(giveaway, entry.userId),
        ]),
      );
      return new Map<string, GiveawayEligibilityResult>(results);
    }

    const userIds = Array.from(new Set(entries.map((entry) => entry.userId)));
    const mandatoryChannelIds = this.buildGiveawayMandatoryChannelIds(giveaway);
    const lookupPolicy: MaxMembershipLookupPolicy =
      source === 'runner' ? 'giveaway_draw_background' : 'giveaway_draw_interactive';
    const membershipByChannelId = new Map<string, Map<string, boolean | null>>();
    const allowStaleOnError = source === 'runner';
    const lookupBotIdByChannelId =
      await this.resolveGiveawayMembershipLookupBotIds(mandatoryChannelIds);

    for (const channelId of mandatoryChannelIds) {
      const botId = lookupBotIdByChannelId.get(channelId) ?? null;
      membershipByChannelId.set(
        channelId,
        await this.membershipLookupService.getMemberships(channelId, userIds, lookupPolicy, {
          forceRefresh: true,
          allowStaleOnError,
          ...(botId ? { botId } : {}),
        }),
      );
    }

    const results = new Map<string, GiveawayEligibilityResult>();
    for (const entry of entries) {
      const missingChannelIds: string[] = [];
      let lookupFailed = false;
      let failedChannelId: string | null = null;

      for (const channelId of mandatoryChannelIds) {
        const membership = membershipByChannelId.get(channelId)?.get(entry.userId) ?? null;
        if (membership === null) {
          lookupFailed = true;
          failedChannelId = channelId;
          break;
        }
        if (!membership) {
          missingChannelIds.push(channelId);
        }
      }

      if (lookupFailed) {
        results.set(
          entry.userId,
          this.resolveGiveawayEligibilityLookupFailure(giveaway, entry.userId, {
            forceFreshMembership: true,
            lookupPolicy,
            allowStaleMembershipOnError: allowStaleOnError,
            failedChannelId: failedChannelId ?? giveaway.sourceChatId,
          }),
        );
        continue;
      }

      results.set(entry.userId, this.buildGiveawayEligibilityResult(giveaway, missingChannelIds));
    }

    return results;
  }

  private async activateScheduledGiveawayIfDue(
    giveaway: PersistedGiveawayWithRelations,
  ): Promise<void> {
    if (
      giveaway.status !== ManagedGiveawayStatus.SCHEDULED ||
      !giveaway.startsAt ||
      giveaway.startsAt.getTime() > Date.now()
    ) {
      return;
    }

    const updated = await this.prisma.managedGiveaway.update({
      where: { id: giveaway.id },
      data: {
        status: ManagedGiveawayStatus.ACTIVE,
      },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.ACTIVE);
  }

  private async processDueManagedGiveaway(
    giveawayId: string,
    reason: 'startup' | 'scheduled',
    staleLockBefore: Date,
  ): Promise<void> {
    try {
      const giveaway = await this.findGiveawayById(giveawayId);
      if (
        giveaway.status === ManagedGiveawayStatus.DRAWING ||
        giveaway.endsAt.getTime() <= Date.now()
      ) {
        await this.drawGiveaway(giveaway.id, 'runner');
        await this.clearManagedGiveawayRunnerRetryState(giveaway.id);
        return;
      }

      if (
        giveaway.status === ManagedGiveawayStatus.SCHEDULED &&
        giveaway.startsAt &&
        giveaway.startsAt.getTime() <= Date.now()
      ) {
        const claim = await this.prisma.managedGiveaway.updateMany({
          where: {
            id: giveaway.id,
            status: ManagedGiveawayStatus.SCHEDULED,
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
          },
          data: {
            status: ManagedGiveawayStatus.ACTIVE,
            lockedAt: null,
          },
        });
        if (claim.count === 0) {
          return;
        }
        const updated = await this.findGiveawayById(giveaway.id);
        await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.ACTIVE);
        await this.clearManagedGiveawayRunnerRetryState(giveaway.id);
        return;
      }
    } catch (error: unknown) {
      if (error instanceof ManagedGiveawayMembershipLookupUnavailableError) {
        if (error.kind === 'terminal') {
          const deferMs = await this.activateManagedGiveawayRunnerTerminalDefer(
            giveawayId,
            error.retryAfterMs,
          );
          this.logger.warn(
            {
              giveawayId,
              reason,
              chatId: error.chatId,
              deferMs,
              err: error.message,
            },
            'Deferred managed giveaway runner after terminal membership lookup failure',
          );
        } else {
          const { backoffMs, deferMs, failureCount } =
            await this.activateManagedGiveawayRunnerRetryBackoff(giveawayId);
          if (deferMs > 0) {
            this.logger.warn(
              {
                giveawayId,
                reason,
                failureCount,
                deferMs,
                chatId: error.chatId,
                err: error.message,
              },
              'Deferred managed giveaway runner after repeated membership lookup failures',
            );
          } else {
            this.logger.warn(
              {
                giveawayId,
                reason,
                failureCount,
                backoffMs,
                chatId: error.chatId,
                err: error.message,
              },
              'Deferred managed giveaway retry after membership lookup failure',
            );
          }
        }
      } else if (this.isManagedGiveawayRunnerRetryableError(error)) {
        const { backoffMs, deferMs, failureCount } =
          await this.activateManagedGiveawayRunnerRetryBackoff(giveawayId);
        if (deferMs > 0) {
          this.logger.warn(
            {
              giveawayId,
              reason,
              failureCount,
              deferMs,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred managed giveaway runner after repeated membership lookup failures',
          );
        } else {
          this.logger.warn(
            {
              giveawayId,
              reason,
              failureCount,
              backoffMs,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred managed giveaway retry after membership lookup failure',
          );
        }
      } else {
        this.logger.warn(
          {
            giveawayId,
            reason,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to process managed giveaway',
        );
      }
      await this.releaseManagedGiveawayRunnerLockAfterFailure(giveawayId);
    }
  }

  private async releaseManagedGiveawayRunnerLockAfterFailure(giveawayId: string): Promise<void> {
    const recoveredDrawing = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveawayId,
        status: ManagedGiveawayStatus.DRAWING,
      },
      data: {
        status: ManagedGiveawayStatus.ACTIVE,
        lockedAt: null,
      },
    });

    if (recoveredDrawing.count > 0) {
      return;
    }

    await this.prisma.managedGiveaway.updateMany({
      where: { id: giveawayId },
      data: { lockedAt: null },
    });
  }

  private isManagedGiveawayRunnerRetryableError(error: unknown): boolean {
    if (!(error instanceof BadRequestException)) {
      return false;
    }

    const response = error.getResponse();
    if (typeof response === 'string') {
      return response.includes(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
    }
    if (!response || typeof response !== 'object') {
      return false;
    }

    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message.includes(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
    }
    if (Array.isArray(message)) {
      return message.some(
        (item) => typeof item === 'string' && item.includes(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE),
      );
    }

    return false;
  }

  private async getManagedGiveawayRunnerDeferRemainingMs(giveawayId: string): Promise<number> {
    const memoryUntilMs = this.giveawayRunnerDeferredUntilMs.get(giveawayId) ?? 0;
    const memoryRemainingMs = Math.max(0, memoryUntilMs - Date.now());
    if (memoryRemainingMs === 0 && memoryUntilMs > 0) {
      this.giveawayRunnerDeferredUntilMs.delete(giveawayId);
    }

    try {
      const persistedRemainingMs =
        (await this.chatContextCache.getManagedGiveawayRunnerDeferRemainingMs?.(giveawayId)) ?? 0;
      return Math.max(memoryRemainingMs, persistedRemainingMs);
    } catch {
      return memoryRemainingMs;
    }
  }

  private async getManagedGiveawayRunnerBackoffRemainingMs(giveawayId: string): Promise<number> {
    const memoryUntilMs = this.giveawayRunnerBackoffUntilMs.get(giveawayId) ?? 0;
    const memoryRemainingMs = Math.max(0, memoryUntilMs - Date.now());
    if (memoryRemainingMs === 0 && memoryUntilMs > 0) {
      this.giveawayRunnerBackoffUntilMs.delete(giveawayId);
    }

    try {
      const persistedRemainingMs =
        (await this.chatContextCache.getManagedGiveawayRunnerBackoffRemainingMs?.(giveawayId)) ?? 0;
      return Math.max(memoryRemainingMs, persistedRemainingMs);
    } catch {
      return memoryRemainingMs;
    }
  }

  private async activateManagedGiveawayRunnerRetryBackoff(
    giveawayId: string,
  ): Promise<{ failureCount: number; backoffMs: number; deferMs: number }> {
    const failureCount = await this.incrementManagedGiveawayRunnerFailureCount(giveawayId);
    if (failureCount >= GIVEAWAY_RUNNER_LOOKUP_DEFER_AFTER_FAILURE_COUNT) {
      const deferMs = await this.activateManagedGiveawayRunnerRetryDefer(giveawayId);
      await this.clearManagedGiveawayRunnerShortRetryState(giveawayId);
      return { failureCount, backoffMs: 0, deferMs };
    }

    const backoffMs = Math.min(
      GIVEAWAY_RUNNER_LOOKUP_BACKOFF_MAX_MS,
      GIVEAWAY_RUNNER_LOOKUP_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1),
    );
    this.giveawayRunnerBackoffUntilMs.set(giveawayId, Date.now() + backoffMs);

    try {
      await this.chatContextCache.activateManagedGiveawayRunnerBackoff?.(
        giveawayId,
        Math.max(1, Math.ceil(backoffMs / 1000)),
      );
    } catch {
      return { failureCount, backoffMs, deferMs: 0 };
    }

    return { failureCount, backoffMs, deferMs: 0 };
  }

  private async activateManagedGiveawayRunnerRetryDefer(giveawayId: string): Promise<number> {
    this.giveawayRunnerDeferredUntilMs.set(
      giveawayId,
      Date.now() + GIVEAWAY_RUNNER_LOOKUP_DEFER_MS,
    );

    try {
      await this.chatContextCache.activateManagedGiveawayRunnerDefer?.(
        giveawayId,
        Math.max(1, Math.ceil(GIVEAWAY_RUNNER_LOOKUP_DEFER_MS / 1000)),
      );
    } catch {
      return GIVEAWAY_RUNNER_LOOKUP_DEFER_MS;
    }

    return GIVEAWAY_RUNNER_LOOKUP_DEFER_MS;
  }

  private async activateManagedGiveawayRunnerTerminalDefer(
    giveawayId: string,
    retryAfterMs: number | null,
  ): Promise<number> {
    const deferMs = Math.max(
      GIVEAWAY_RUNNER_LOOKUP_TERMINAL_DEFER_MS,
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.ceil(retryAfterMs)
        : 0,
    );
    this.giveawayRunnerDeferredUntilMs.set(giveawayId, Date.now() + deferMs);

    try {
      await this.chatContextCache.activateManagedGiveawayRunnerDefer?.(
        giveawayId,
        Math.max(1, Math.ceil(deferMs / 1000)),
      );
    } catch {
      await this.clearManagedGiveawayRunnerShortRetryState(giveawayId);
      return deferMs;
    }

    await this.clearManagedGiveawayRunnerShortRetryState(giveawayId);
    return deferMs;
  }

  private async incrementManagedGiveawayRunnerFailureCount(giveawayId: string): Promise<number> {
    const now = Date.now();
    const memoryEntry = this.giveawayRunnerFailureCounts.get(giveawayId);
    const memoryCount = memoryEntry && memoryEntry.expiresAtMs > now ? memoryEntry.count + 1 : 1;
    this.giveawayRunnerFailureCounts.set(giveawayId, {
      count: memoryCount,
      expiresAtMs: now + GIVEAWAY_RUNNER_LOOKUP_FAILURE_COUNT_TTL_SEC * 1000,
    });

    try {
      const persistedCount =
        (await this.chatContextCache.incrementManagedGiveawayRunnerFailureCount?.(
          giveawayId,
          GIVEAWAY_RUNNER_LOOKUP_FAILURE_COUNT_TTL_SEC,
        )) ?? memoryCount;
      return Math.max(memoryCount, persistedCount);
    } catch {
      return memoryCount;
    }
  }

  private async clearManagedGiveawayRunnerRetryState(giveawayId: string): Promise<void> {
    this.giveawayRunnerFailureCounts.delete(giveawayId);
    this.giveawayRunnerBackoffUntilMs.delete(giveawayId);
    this.giveawayRunnerDeferredUntilMs.delete(giveawayId);

    try {
      await this.chatContextCache.clearManagedGiveawayRunnerFailureState?.(giveawayId);
    } catch {
      return;
    }
  }

  private async clearManagedGiveawayRunnerShortRetryState(giveawayId: string): Promise<void> {
    this.giveawayRunnerFailureCounts.delete(giveawayId);
    this.giveawayRunnerBackoffUntilMs.delete(giveawayId);

    try {
      await this.chatContextCache.clearManagedGiveawayRunnerRetryCounters?.(giveawayId);
    } catch {
      return;
    }
  }

  private async expireDueGiveawayClaims(now: Date): Promise<void> {
    const dueWinners = await this.prisma.managedGiveawayWinner.findMany({
      where: {
        status: ManagedGiveawayWinnerStatus.SELECTED,
        claimDeadlineAt: {
          lte: now,
        },
      },
      select: {
        id: true,
        giveawayId: true,
      },
      take: 100,
    });

    if (dueWinners.length === 0) {
      return;
    }

    const winnerIds = dueWinners.map((winner) => winner.id);
    await this.prisma.managedGiveawayWinner.updateMany({
      where: {
        id: { in: winnerIds },
        status: ManagedGiveawayWinnerStatus.SELECTED,
      },
      data: {
        status: ManagedGiveawayWinnerStatus.EXPIRED,
        expiredAt: now,
      },
    });

    const giveawayIds = Array.from(new Set(dueWinners.map((winner) => winner.giveawayId)));
    const giveawaySourceRows = await this.prisma.managedGiveaway.findMany({
      where: { id: { in: giveawayIds } },
      select: { id: true, sourceChatId: true },
    });
    const sourceChatIdByGiveawayId = new Map(
      giveawaySourceRows.map((row) => [row.id, this.normalizeNonEmptyString(row.sourceChatId)]),
    );
    const accessBlockedSourceChatIds = await this.findAccessBlockedGiveawaySourceChatIds(
      giveawaySourceRows.map((row) => row.sourceChatId),
    );

    for (const giveawayId of giveawayIds) {
      const sourceChatId = sourceChatIdByGiveawayId.get(giveawayId) ?? null;
      if (sourceChatId && accessBlockedSourceChatIds.has(sourceChatId)) {
        continue;
      }
      try {
        const giveaway = await this.findGiveawayById(giveawayId);
        await this.editGiveawayPublicationIfNeeded(giveaway, ManagedGiveawayStatus.COMPLETED);
        await this.republishGiveawayResults(giveaway);
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to refresh giveaway after winner claim expiry',
        );
      }
    }
  }

  private async claimGiveawayForDraw(
    giveaway: PersistedGiveawayWithRelations,
    drawSeed: string,
    now: Date,
  ): Promise<GiveawayDrawClaimResult> {
    if (giveaway.status === ManagedGiveawayStatus.COMPLETED) {
      return { status: 'completed', giveaway };
    }

    const staleLockBefore = new Date(now.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const claim = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveaway.id,
        status: {
          in: [ManagedGiveawayStatus.ACTIVE, ManagedGiveawayStatus.SCHEDULED],
        },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        status: ManagedGiveawayStatus.DRAWING,
        drawSeed,
        drawnAt: now,
        lockedAt: now,
      },
    });

    if (claim.count > 0) {
      return {
        status: 'claimed',
        giveaway: await this.findGiveawayById(giveaway.id),
        drawSeed,
      };
    }

    const current = await this.findGiveawayById(giveaway.id);
    if (current.status === ManagedGiveawayStatus.COMPLETED) {
      return { status: 'completed', giveaway: current };
    }

    if (
      current.status === ManagedGiveawayStatus.DRAWING &&
      (!current.lockedAt || current.lockedAt.getTime() < staleLockBefore.getTime())
    ) {
      const resumedSeed = current.drawSeed?.trim() || drawSeed;
      const resumed = await this.prisma.managedGiveaway.updateMany({
        where: {
          id: current.id,
          status: ManagedGiveawayStatus.DRAWING,
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        data: {
          drawSeed: resumedSeed,
          drawnAt: current.drawnAt ?? now,
          lockedAt: now,
        },
      });

      if (resumed.count > 0) {
        return {
          status: 'claimed',
          giveaway: await this.findGiveawayById(current.id),
          drawSeed: resumedSeed,
        };
      }
    }

    if (current.status === ManagedGiveawayStatus.DRAWING) {
      throw new BadRequestException('Итоги уже подводятся.');
    }

    throw new BadRequestException('Завершить можно только активный или запланированный розыгрыш.');
  }

  private async drawGiveaway(
    giveawayId: string,
    source: GiveawayActionSource,
    actorUserId?: string,
  ): Promise<PersistedGiveawayWithRelations> {
    const now = new Date();
    const initial = await this.findGiveawayById(giveawayId);
    const initialDrawSeed = initial.drawSeed?.trim() || randomBytes(32).toString('hex');
    const drawClaim = await this.claimGiveawayForDraw(initial, initialDrawSeed, now);
    if (drawClaim.status === 'completed') {
      return drawClaim.giveaway;
    }

    const giveaway = drawClaim.giveaway;
    const drawSeed = drawClaim.drawSeed;
    let winnersToCreate: Array<{
      prize: PersistedManagedGiveawayPrize;
      rankedEntry: { entry: PersistedManagedGiveawayEntry; drawRank: string };
      rank: number;
    }> = [];
    let completed: PersistedGiveawayWithRelations;

    try {
      const entriesToRecheck = giveaway.entries;
      const eligibilityByUserId = await this.evaluateGiveawayEligibilityForDraw(
        giveaway,
        entriesToRecheck,
        source,
      );

      const refreshedEntries = await Promise.all(
        giveaway.entries.map(async (entry) => {
          const result = this.resolveDrawEligibilityResult(
            entry,
            eligibilityByUserId.get(entry.userId) ??
              this.resolveGiveawayEligibilityLookupFailure(giveaway, entry.userId),
          );

          return this.prisma.managedGiveawayEntry.update({
            where: { id: entry.id },
            data: {
              eligibilityState: result.state,
              eligibilityReason: result.reason,
              missingChannelIds: result.missingChannelIds,
              checkedAt: now,
            },
          });
        }),
      );

      const rankedEntries = refreshedEntries
        .filter((entry) => entry.eligibilityState === GiveawayEligibilityState.VERIFIED)
        .map((entry) => ({
          entry,
          drawRank: entry.drawRank ?? buildManagedGiveawayDrawRank(drawSeed, entry.userId),
        }))
        .sort(
          (left, right) =>
            left.drawRank.localeCompare(right.drawRank) ||
            left.entry.userId.localeCompare(right.entry.userId),
        );

      const claimDeadlineAt = this.buildGiveawayClaimDeadlineAt(giveaway, now);
      winnersToCreate = giveaway.prizes
        .slice()
        .sort((left, right) => left.position - right.position)
        .map((prize, index) => ({
          prize,
          rankedEntry: rankedEntries[index] ?? null,
          rank: index + 1,
        }))
        .filter(
          (
            item,
          ): item is {
            prize: PersistedManagedGiveawayPrize;
            rankedEntry: { entry: PersistedManagedGiveawayEntry; drawRank: string };
            rank: number;
          } => item.rankedEntry !== null,
        );

      completed = await this.prisma.$transaction(async (tx) => {
        for (const row of rankedEntries) {
          await tx.managedGiveawayEntry.update({
            where: { id: row.entry.id },
            data: {
              drawRank: row.drawRank,
              checkedAt: now,
            },
          });
        }

        await tx.managedGiveawayWinner.deleteMany({
          where: {
            giveawayId: giveaway.id,
            status: ManagedGiveawayWinnerStatus.SELECTED,
          },
        });

        if (winnersToCreate.length > 0) {
          await tx.managedGiveawayWinner.createMany({
            data: winnersToCreate.map((row) => ({
              giveawayId: giveaway.id,
              prizeId: row.prize.id,
              entryId: row.rankedEntry.entry.id,
              rank: row.rank,
              status: ManagedGiveawayWinnerStatus.SELECTED,
              selectedAt: now,
              claimDeadlineAt,
            })),
          });
        }

        await tx.managedGiveaway.update({
          where: { id: giveaway.id },
          data: {
            status: ManagedGiveawayStatus.COMPLETED,
            completedAt: now,
            lockedAt: null,
          },
        });

        return tx.managedGiveaway.findUniqueOrThrow({
          where: { id: giveaway.id },
          include: MANAGED_GIVEAWAY_INCLUDE,
        });
      });
    } catch (error: unknown) {
      if (source !== 'runner') {
        await this.prisma.managedGiveaway.updateMany({
          where: {
            id: giveaway.id,
            status: ManagedGiveawayStatus.DRAWING,
            OR: [{ lockedAt: null }, { lockedAt: { lte: now } }],
          },
          data: {
            status: initial.status,
            lockedAt: null,
          },
        });
      }
      throw error;
    }

    await this.editGiveawayPublicationIfNeeded(completed, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(completed);
    const refreshed = await this.findGiveawayById(completed.id);
    await this.sendWinnerDirectMessages(
      refreshed,
      winnersToCreate.map((row) =>
        this.buildWinnerNotificationKey(row.rankedEntry.entry.id, row.prize.id),
      ),
    );
    await this.writeAuditLog(
      giveaway.sourceChatId,
      actorUserId ?? giveaway.actorUserId,
      'DRAW_GIVEAWAY',
      {
        giveawayId: giveaway.id,
        entityType: this.fromPrismaEntityType(giveaway.entityType),
        winners: winnersToCreate.length,
        source,
      },
    );

    return refreshed;
  }

  private async upsertParticipantChatAccess(
    giveaway: PersistedGiveawayWithRelations,
  ): Promise<void> {
    const resolvedBotId = await this.resolveReadBotAssignment(giveaway.sourceChatId);

    await this.prisma.chat.upsert({
      where: { id: giveaway.sourceChatId },
      create: {
        id: giveaway.sourceChatId,
        title: await this.resolveSourceTitle(giveaway.sourceChatId),
        entityType: giveaway.entityType,
        ...(resolvedBotId ? { botId: resolvedBotId, primaryBotId: resolvedBotId } : {}),
      },
      update: resolvedBotId
        ? {
            botId: resolvedBotId,
            primaryBotId: resolvedBotId,
          }
        : {},
    });
  }

  private async resolveSourceTitle(chatId: string): Promise<string> {
    const local = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    if (local?.title?.trim()) {
      return local.title.trim();
    }

    try {
      const remote = await this.maxClient.getChatTitle(chatId);
      if (remote?.trim()) {
        return remote.trim();
      }
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to resolve giveaway source title',
      );
    }

    return `Chat ${chatId}`;
  }

  private async resolveChatLink(chatId: string): Promise<string | null> {
    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId);
      return snapshot.link ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to resolve giveaway source link',
      );
      return null;
    }
  }

  private resolveUserDisplayName(user: AuthUser): string {
    return user.displayName?.trim() || user.username?.trim() || `user:${user.userId}`;
  }

  private buildGiveawayLaunchUrl(giveawayId: string): string | null {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'giveaway',
        g: giveawayId,
      }),
      'utf8',
    ).toString('base64url');

    const startParam = `${GIVEAWAY_START_PARAM_PREFIX}${payload}`;
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildEntryMiniappStartUrlSync?.(startParam) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(
            startParam,
          )}`
        : null)
    );
  }

  private buildGiveawayDirectWebAppUrl(giveawayId: string): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/giveaways/${encodeURIComponent(giveawayId)}`;
  }

  private buildGiveawayClaimSignature(
    giveawayId: string,
    winnerId: string,
    botToken = this.getCurrentBotToken(),
  ): string {
    return createHmac('sha256', botToken)
      .update(`giveaway-claim:${giveawayId}:${winnerId}`)
      .digest('hex');
  }

  private isValidGiveawayClaimSignature(
    providedHex: string,
    giveawayId: string,
    winnerId: string,
  ): boolean {
    return this.maxBotTokenValidationSecrets.some((botToken) =>
      this.isSafeEqualHex(
        providedHex,
        this.buildGiveawayClaimSignature(giveawayId, winnerId, botToken),
      ),
    );
  }

  private isSafeEqualHex(providedHex: string, expectedHex: string): boolean {
    if (providedHex.length !== expectedHex.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  }

  private decodeImageBase64(value: string): Buffer {
    try {
      return Buffer.from(value, 'base64');
    } catch {
      throw new BadRequestException('Некорректное изображение розыгрыша.');
    }
  }

  private resolveImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    const extension = mimeType.split('/')[1]?.trim() || 'jpg';
    return `giveaway-image.${extension}`;
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): ManagedEntityType {
    return managedEntityTypeSchema.parse(
      entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
    );
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/u, '');
    return /^https?:\/\//iu.test(normalized) ? normalized : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return /^\d+$/u.test(normalized) ? normalized : null;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeNonEmptyString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async resolveReadBotRoute(chatId: string): Promise<MaxBotRoute | null> {
    if (!this.maxBotLinkService) {
      return null;
    }

    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (typeof routeResolver.resolveBotRoute !== 'function') {
      return null;
    }

    return routeResolver.resolveBotRoute({
      purpose: 'read',
      chatId,
    });
  }

  private async resolveReadBotAssignment(chatId: string): Promise<string | undefined> {
    const route = await this.resolveReadBotRoute(chatId);
    if (route?.botId) {
      return route.botId;
    }

    return (
      (await this.maxBotLinkService?.resolveBotIdForRead?.({
        chatId,
      })) ??
      (await this.maxBotLinkService?.resolveBotId({ chatId })) ??
      undefined
    );
  }

  private async resolveGiveawayMembershipLookupBotIds(
    chatIds: readonly string[],
  ): Promise<Map<string, string>> {
    const normalizedChatIds = Array.from(
      new Set(
        chatIds
          .map((chatId) => this.normalizeNonEmptyString(chatId))
          .filter((chatId): chatId is string => Boolean(chatId)),
      ),
    );
    const botIdByChatId = new Map<string, string>();

    await Promise.all(
      normalizedChatIds.map(async (chatId) => {
        const botId = await this.resolveGiveawayMembershipLookupBotId(chatId);
        if (botId) {
          botIdByChatId.set(chatId, botId);
        }
      }),
    );

    return botIdByChatId;
  }

  private async resolveGiveawayMembershipLookupBotId(chatId: string): Promise<string | null> {
    try {
      const assignedBotId = await this.resolveReadBotAssignment(chatId);
      if (assignedBotId?.trim()) {
        return assignedBotId.trim();
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway membership lookup bot route',
      );
    }

    let persisted: { primaryBotId?: string | null; botId?: string | null } | null = null;
    try {
      persisted = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { primaryBotId: true, botId: true },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway membership lookup bot from persisted chat',
      );
      return null;
    }
    const primaryBotId =
      typeof persisted?.primaryBotId === 'string' ? persisted.primaryBotId.trim() : '';
    if (primaryBotId) {
      return primaryBotId;
    }

    const botId = typeof persisted?.botId === 'string' ? persisted.botId.trim() : '';
    return botId || null;
  }

  private async resolveGiveawayButtonBotId(sourceChatId: string): Promise<string | null> {
    const normalizedSourceChatId = sourceChatId.trim();
    if (!normalizedSourceChatId || !this.maxBotLinkService) {
      return null;
    }

    try {
      return (await this.resolveReadBotAssignment(normalizedSourceChatId)) ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          sourceChatId: normalizedSourceChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway button bot id',
      );
      return null;
    }
  }

  private async resolveGiveawayPublicationBotId(sourceChatId: string): Promise<string | undefined> {
    const resolvedBotId = await this.resolveGiveawayButtonBotId(sourceChatId);
    if (resolvedBotId) {
      return resolvedBotId;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: sourceChatId },
      select: { primaryBotId: true, botId: true },
    });
    const normalizedBotId =
      typeof persisted?.primaryBotId === 'string' && persisted.primaryBotId.trim()
        ? persisted.primaryBotId.trim()
        : typeof persisted?.botId === 'string' && persisted.botId.trim()
          ? persisted.botId.trim()
          : null;
    return normalizedBotId ?? undefined;
  }

  private resolveBotContactId(botId?: string | null): string | null {
    const contextAwareContactId = this.maxBotLinkService?.resolveContactIdSync(botId);
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (!botId && this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    const fallbackBotUserId =
      typeof botId === 'string' && botId.trim().length > 0 ? botId.trim() : this.ownBotUserId;
    if (!fallbackBotUserId) {
      return null;
    }

    const [candidate] = fallbackBotUserId.split('_');
    return /^\d+$/u.test(candidate) ? candidate : null;
  }

  private getCurrentBotToken(botId?: string | null): string {
    return this.maxBotLinkService?.getBotTokenSync(botId) ?? this.maxBotToken;
  }
}
