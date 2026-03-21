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
  rerollManagedGiveawayWinnerRequestSchema,
  type ClaimManagedGiveawayResponse,
  type ManagedEntityType,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
  type ManagedGiveawayWinner,
  type UpdateManagedGiveawayRequest,
  updateManagedGiveawayRequestSchema,
} from '@maxim/contracts';
import {
  ChatEntityType,
  GiveawayEligibilityState,
  ManagedGiveawayStatus,
  ManagedGiveawayWinnerStatus,
  Prisma,
} from '@prisma/client';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import {
  buildManagedGiveawayDrawRank,
  normalizeManagedGiveawayDraft,
} from '../common/managed-giveaway.util';
import {
  MaxClientService,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

type GiveawayActionSource = 'miniapp' | 'private_bot' | 'runner' | 'private_claim';

const GIVEAWAY_IMAGE_MAX_BYTES = 1_000_000;
const GIVEAWAY_LOCK_STALE_MS = 60_000;
const GIVEAWAY_DUE_BATCH_SIZE = 20;
const GIVEAWAY_START_PARAM_PREFIX = 'gg-';
const GIVEAWAY_CLAIM_START_PREFIX = 'ggc-';
const MANAGED_GIVEAWAY_INCLUDE = Prisma.validator<Prisma.ManagedGiveawayInclude>()({
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
});

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
type GiveawayEligibilityResult = {
  state: GiveawayEligibilityState;
  reason: string | null;
  missingChannelIds: string[];
};

@Injectable()
export class ManagedGiveawayService {
  private readonly logger = new Logger(ManagedGiveawayService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly maxBotToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly adminService: AdminService,
    configService: ConfigService,
  ) {
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
    this.maxBotToken = configService.getOrThrow<string>('MAX_BOT_TOKEN');
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
    const publicationButton = this.buildGiveawayEntryButton(giveaway.id);
    const imagePayload = await this.uploadGiveawayImage(giveaway);
    const publicationText = this.buildGiveawayPublicationText(giveaway);
    const publicationTextFormat = this.resolveGiveawayPublicationTextFormat(giveaway);
    const publication = await this.maxClient.sendMessageImmediateWithResolvedLink(
      sourceChatId,
      publicationText,
      {
        ...(publicationTextFormat ? { textFormat: publicationTextFormat } : {}),
        ...(publicationButton ? { buttons: [[publicationButton]] } : {}),
        ...(imagePayload ? { imagePayload } : {}),
      },
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
      winner.status !== ManagedGiveawayWinnerStatus.EXPIRED
    ) {
      throw new BadRequestException(
        'Реролл доступен только для непринятого или просроченного места.',
      );
    }

    const nextEntry = this.pickNextRerollCandidate(giveaway, giveaway.drawSeed);

    if (!nextEntry) {
      throw new BadRequestException('Больше подходящих участников для реролла нет.');
    }

    const now = new Date();
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
          claimDeadlineAt: new Date(now.getTime() + giveaway.claimHours * 60 * 60 * 1000),
        },
      });

      return tx.managedGiveaway.findUniqueOrThrow({
        where: { id: giveaway.id },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });
    });

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(updated);
    await this.writeAuditLog(sourceChatId, user.userId, 'REROLL_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: winner.id,
      nextEntryId: nextEntry.entry.id,
      entityType,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
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
    if (
      winner.status !== ManagedGiveawayWinnerStatus.CLAIMED &&
      winner.status !== ManagedGiveawayWinnerStatus.SELECTED
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

  async getPublicGiveaway(giveawayId: string, user: AuthUser): Promise<ManagedGiveawayPublic> {
    const giveaway = await this.findGiveawayById(giveawayId);
    if (giveaway.status === ManagedGiveawayStatus.SCHEDULED) {
      await this.activateScheduledGiveawayIfDue(giveaway);
    }

    const refreshed = await this.findGiveawayById(giveawayId);
    await this.upsertParticipantChatAccess(refreshed);

    return managedGiveawayPublicSchema.parse(await this.mapPublicGiveaway(refreshed));
  }

  async getGiveawayParticipantState(
    giveawayId: string,
    user: AuthUser,
  ): Promise<ManagedGiveawayParticipantState> {
    const giveaway = await this.findGiveawayById(giveawayId);
    if (giveaway.status === ManagedGiveawayStatus.SCHEDULED) {
      await this.activateScheduledGiveawayIfDue(giveaway);
    }

    const refreshed = await this.findGiveawayById(giveawayId);
    await this.upsertParticipantChatAccess(refreshed);

    return managedGiveawayParticipantStateSchema.parse(
      this.mapParticipantState(refreshed, user.userId),
    );
  }

  async enterGiveaway(
    giveawayId: string,
    user: AuthUser,
  ): Promise<ManagedGiveawayParticipantState> {
    const giveaway = await this.findGiveawayById(giveawayId);
    if (giveaway.status === ManagedGiveawayStatus.SCHEDULED) {
      await this.activateScheduledGiveawayIfDue(giveaway);
    }

    const refreshed = await this.findGiveawayById(giveawayId);
    this.assertGiveawayOpenForEntry(refreshed);
    await this.upsertParticipantChatAccess(refreshed);

    const eligibility = await this.evaluateGiveawayEligibility(refreshed, user.userId);
    const displayName = this.resolveUserDisplayName(user);
    const existing = refreshed.entries.find((entry) => entry.userId === user.userId) ?? null;
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
        checkedAt: new Date(),
      },
      update: {
        displayName,
        eligibilityState: eligibility.state,
        eligibilityReason: eligibility.reason,
        missingChannelIds: eligibility.missingChannelIds,
        checkedAt: new Date(),
      },
    });

    await this.writeAuditLog(refreshed.sourceChatId, user.userId, 'ENTER_GIVEAWAY', {
      giveawayId: refreshed.id,
      entityType: this.fromPrismaEntityType(refreshed.entityType),
      previousEntryId: existing?.id ?? null,
      entryId: saved.id,
      eligibilityState: saved.eligibilityState,
      eligibilityReason: saved.eligibilityReason,
      missingChannelIds: this.readMissingChannelIds(saved.missingChannelIds),
    });

    const latest = await this.findGiveawayById(refreshed.id);
    return managedGiveawayParticipantStateSchema.parse(
      this.mapParticipantState(latest, user.userId),
    );
  }

  async claimGiveaway(
    giveawayId: string,
    user: AuthUser,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ClaimManagedGiveawayResponse> {
    const giveaway = await this.findGiveawayById(giveawayId);
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
      return claimManagedGiveawayResponseSchema.parse({
        ok: true,
        winner: this.mapGiveawayWinner(winner),
      });
    }
    if (
      winner.status !== ManagedGiveawayWinnerStatus.SELECTED &&
      winner.status !== ManagedGiveawayWinnerStatus.EXPIRED
    ) {
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

    return claimManagedGiveawayResponseSchema.parse({
      ok: true,
      winner: this.mapGiveawayWinner(updated),
    });
  }

  async processDueManagedGiveaways(reason: 'startup' | 'scheduled'): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const rows = await this.prisma.managedGiveaway.findMany({
      where: {
        status: {
          in: [ManagedGiveawayStatus.SCHEDULED, ManagedGiveawayStatus.ACTIVE],
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
      take: GIVEAWAY_DUE_BATCH_SIZE,
      select: { id: true },
    });

    for (const row of rows) {
      await this.processDueManagedGiveaway(row.id, reason, staleLockBefore);
    }

    const expiredWinners = await this.expireDueClaimWinners();
    await this.processAutoRerollForExpiredWinners(expiredWinners);
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
      const expectedSignature = this.buildGiveawayClaimSignature(parsed.g, parsed.w);
      if (!this.isSafeEqualHex(parsed.s, expectedSignature)) {
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
      winner: managedGiveawayWinnerSchema.parse(this.mapGiveawayWinner(winner)),
    };
  }

  buildGiveawayClaimBotStartUrl(giveawayId: string, winnerId: string): string | null {
    if (!this.ownBotUserId) {
      return null;
    }

    const signature = this.buildGiveawayClaimSignature(giveawayId, winnerId);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'giveaway-claim',
        g: giveawayId,
        w: winnerId,
        s: signature,
      }),
      'utf8',
    ).toString('base64url');

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?start=${encodeURIComponent(
      `${GIVEAWAY_CLAIM_START_PREFIX}${payload}`,
    )}`;
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
        throw new BadRequestException('Изображение розыгрыша слишком большое. Максимум 1 MB.');
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
      })),
      winners: row.winners
        .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
        .sort((left, right) => left.prize.position - right.prize.position)
        .map((winner) => this.mapGiveawayWinner(winner)),
    };
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
      entriesCount: row.entries.length,
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
      })),
      winners:
        row.status === ManagedGiveawayStatus.COMPLETED
          ? row.winners
              .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
              .sort((left, right) => left.prize.position - right.prize.position)
              .map((winner) => ({
                prizePosition: winner.prize.position,
                prizeTitle: winner.prize.title,
                displayName: this.resolvePublicWinnerDisplayName(winner),
                status: winner.status,
              }))
          : [],
    };
  }

  private mapParticipantState(
    row: PersistedGiveawayWithRelations,
    userId: string,
  ): ManagedGiveawayParticipantState {
    const entry = row.entries.find((item) => item.userId === userId) ?? null;
    const winner = entry
      ? (row.winners.find(
          (item) =>
            item.entryId === entry.id && item.status !== ManagedGiveawayWinnerStatus.REROLLED,
        ) ?? null)
      : null;
    const claimBotUrl =
      winner &&
      winner.status === ManagedGiveawayWinnerStatus.SELECTED &&
      (!winner.claimDeadlineAt || winner.claimDeadlineAt.getTime() > Date.now())
        ? this.buildGiveawayClaimBotStartUrl(row.id, winner.id)
        : null;

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
      winnerStatus: winner ? winner.status : null,
      claimDeadlineAt: winner?.claimDeadlineAt?.toISOString() ?? null,
      prizePosition: winner?.prize.position ?? null,
      prizeTitle: winner?.prize.title ?? null,
      canClaim:
        winner?.status === ManagedGiveawayWinnerStatus.SELECTED &&
        (!winner.claimDeadlineAt || winner.claimDeadlineAt.getTime() > Date.now()),
      claimBotUrl,
    };
  }

  private mapGiveawayWinner(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
  ): ManagedGiveawayWinner {
    return {
      id: winner.id,
      prizeId: winner.prizeId,
      prizePosition: winner.prize.position,
      prizeTitle: winner.prize.title,
      entryId: winner.entryId,
      userId: winner.entry.userId,
      displayName: winner.entry.displayName ?? null,
      status: winner.status,
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
    return winner.status === ManagedGiveawayWinnerStatus.CLAIMED ||
      winner.status === ManagedGiveawayWinnerStatus.DELIVERED
      ? (winner.entry.displayName ?? null)
      : null;
  }

  private formatPublicWinnerName(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
  ): string {
    return this.resolvePublicWinnerDisplayName(winner) ?? 'победитель подтверждает приз';
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
  ): Promise<Record<string, unknown> | undefined> {
    if (!giveaway.imageEnabled) {
      return undefined;
    }

    try {
      const imageBuffer = this.decodeImageBase64(giveaway.imageBase64);
      return await this.maxClient.uploadImage(
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

  private buildGiveawayEntryButton(giveawayId: string): MaxMessageButton | null {
    return this.buildGiveawayMiniappButton(giveawayId, 'Участвовать');
  }

  private buildGiveawayOpenButton(giveawayId: string): MaxMessageButton | null {
    return this.buildGiveawayMiniappButton(giveawayId, 'Открыть розыгрыш');
  }

  private buildGiveawayResultsButton(giveawayId: string): MaxMessageButton | null {
    return this.buildGiveawayMiniappButton(giveawayId, 'Проверить результаты');
  }

  private buildGiveawayMiniappButton(giveawayId: string, text: string): MaxMessageButton | null {
    const launchUrl = this.buildGiveawayLaunchUrl(giveawayId);
    const webAppUrl = this.buildGiveawayDirectWebAppUrl(giveawayId);
    const botContactId = this.resolveBotContactId();

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
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

  private resolveGiveawayPublicationTextFormat(
    giveaway: Pick<PersistedGiveawayWithRelations, 'description'>,
  ): MaxSendMessageOptions['textFormat'] | undefined {
    return this.shouldUseMarkdownForPublication(giveaway.description) ? 'markdown' : undefined;
  }

  private shouldUseMarkdownForPublication(text: string): boolean {
    return /(?:\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_|~~[^~\n]+?~~|\+\+[^+\n]+?\+\+|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|max:\/\/)[^)]+\))/u.test(
      text,
    );
  }

  private buildGiveawayResultsText(giveaway: PersistedGiveawayWithRelations): string {
    const lines: string[] = ['🎉 Результаты розыгрыша:'];
    const currentWinners = giveaway.winners
      .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
      .sort((left, right) => left.prize.position - right.prize.position);
    const hasPublicationReference = Boolean(giveaway.publicationMessageId?.trim());
    const shouldShowPrizeTitle =
      currentWinners.length > 1 &&
      currentWinners.some((winner) => {
        const title = winner.prize.title.trim();
        return title.length > 0 && title !== `${winner.prize.position} место`;
      });

    if (!hasPublicationReference && giveaway.title.trim()) {
      lines.push('', giveaway.title.trim());
    }

    if (currentWinners.length === 0) {
      lines.push('', 'Подходящих участников не нашлось.');
      return lines.join('\n');
    }

    lines.push('', currentWinners.length === 1 ? '🏆 Победитель:' : '🏆 Победители:');
    for (const winner of currentWinners) {
      const publicName = this.resolvePublicWinnerDisplayName(winner);
      if (!publicName) {
        lines.push(
          winner.status === ManagedGiveawayWinnerStatus.EXPIRED
            ? `${winner.prize.position}. Подтверждение истекло, запускаем перевыбор`
            : `${winner.prize.position}. Победитель подтверждает приз`,
        );
        continue;
      }

      const prizeSuffix = shouldShowPrizeTitle ? ` — ${winner.prize.title}` : '';
      const statusSuffix =
        winner.status === ManagedGiveawayWinnerStatus.DELIVERED ? ' (приз выдан)' : '';
      lines.push(`${winner.prize.position}. ${publicName}${prizeSuffix}${statusSuffix}`);
    }

    return lines.join('\n');
  }

  private buildGiveawayResultsMessageOptions(
    giveaway: PersistedGiveawayWithRelations,
  ): MaxSendMessageOptions | undefined {
    const button = this.buildGiveawayResultsButton(giveaway.id);
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

  private async editGiveawayPublicationIfNeeded(
    giveaway: PersistedGiveawayWithRelations,
    status: ManagedGiveawayStatus,
  ): Promise<void> {
    const messageId = giveaway.publicationMessageId?.trim() ?? '';
    if (!messageId) {
      return;
    }

    try {
      const publicationText = this.buildGiveawayPublicationText(giveaway);
      if (status === ManagedGiveawayStatus.CANCELED) {
        const button = this.buildGiveawayOpenButton(giveaway.id);
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          messageId,
          publicationText,
          button ? { buttons: [[button]] } : undefined,
        );
        return;
      }

      if (status === ManagedGiveawayStatus.ACTIVE) {
        const button = this.buildGiveawayEntryButton(giveaway.id);
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          messageId,
          publicationText,
          button ? { buttons: [[button]] } : undefined,
        );
        return;
      }

      const button = this.buildGiveawayOpenButton(giveaway.id);
      await this.maxClient.editMessageInlineKeyboard(
        giveaway.sourceChatId,
        messageId,
        publicationText,
        button ? { buttons: [[button]] } : undefined,
      );
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
    }
  }

  private async republishGiveawayResults(giveaway: PersistedGiveawayWithRelations): Promise<void> {
    const resultOptions = this.buildGiveawayResultsMessageOptions(giveaway);
    if (!giveaway.resultsMessageId?.trim()) {
      try {
        const result = await this.maxClient.sendMessageImmediateWithResolvedLink(
          giveaway.sourceChatId,
          this.buildGiveawayResultsText(giveaway),
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
      }
      return;
    }

    try {
      await this.maxClient.editMessageInlineKeyboard(
        giveaway.sourceChatId,
        giveaway.resultsMessageId,
        this.buildGiveawayResultsText(giveaway),
        resultOptions,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh giveaway results message',
      );
    }
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
    options: {
      strictChannelCheck?: boolean;
    } = {},
  ): Promise<GiveawayEligibilityResult> {
    const entityType = this.fromPrismaEntityType(giveaway.entityType);
    const additionalRequiredChannels = this.readRequiredChannelIds(
      giveaway.requiredChannelIds,
    ).filter((channelId) => channelId !== giveaway.sourceChatId);
    const missingChannelIds: string[] = [];

    try {
      const isMember = await this.maxClient.hasChatMember(giveaway.sourceChatId, userId);
      if (!isMember) {
        missingChannelIds.push(giveaway.sourceChatId);
      }

      for (const channelId of additionalRequiredChannels) {
        const hasAdditionalSubscription = await this.maxClient.hasChatMember(channelId, userId);
        if (!hasAdditionalSubscription) {
          missingChannelIds.push(channelId);
        }
      }

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
              ? 'Подписка на источник и обязательные каналы не подтверждена.'
              : 'Подписка на источник не подтверждена.',
          missingChannelIds,
        };
      }

      return {
        state: GiveawayEligibilityState.REJECTED,
        reason:
          missingChannelIds.length > 1
            ? 'Подписка на обязательные каналы не подтверждена.'
            : 'Подписка на обязательный канал не подтверждена.',
        missingChannelIds,
      };
    } catch (error: unknown) {
      if (entityType === 'chat' || options.strictChannelCheck) {
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            sourceChatId: giveaway.sourceChatId,
            userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to verify giveaway participant strictly',
        );
        throw new BadRequestException(
          'Не удалось проверить участие в исходном чате. Повторите позже.',
        );
      }

      return {
        state: GiveawayEligibilityState.PENDING,
        reason: 'MAX пока не подтвердил участие. Проверим ещё раз при подведении итогов.',
        missingChannelIds: [],
      };
    }
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

  private buildGiveawayMandatoryChannelIds(row: PersistedGiveawayWithRelations): string[] {
    return Array.from(
      new Set([row.sourceChatId, ...this.readRequiredChannelIds(row.requiredChannelIds)]),
    );
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
    const claimedAt = new Date();
    const claim = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveawayId,
        status: {
          in: [ManagedGiveawayStatus.SCHEDULED, ManagedGiveawayStatus.ACTIVE],
        },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt: claimedAt,
      },
    });

    if (claim.count === 0) {
      return;
    }

    try {
      const giveaway = await this.findGiveawayById(giveawayId);
      if (giveaway.endsAt.getTime() <= Date.now()) {
        await this.drawGiveaway(giveaway.id, 'runner');
        return;
      }

      if (
        giveaway.status === ManagedGiveawayStatus.SCHEDULED &&
        giveaway.startsAt &&
        giveaway.startsAt.getTime() <= Date.now()
      ) {
        const updated = await this.prisma.managedGiveaway.update({
          where: { id: giveaway.id },
          data: {
            status: ManagedGiveawayStatus.ACTIVE,
            lockedAt: null,
          },
          include: MANAGED_GIVEAWAY_INCLUDE,
        });
        await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.ACTIVE);
        return;
      }

      await this.prisma.managedGiveaway.update({
        where: { id: giveaway.id },
        data: { lockedAt: null },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to process managed giveaway',
      );
      await this.prisma.managedGiveaway.updateMany({
        where: { id: giveawayId },
        data: { lockedAt: null },
      });
    }
  }

  private async drawGiveaway(
    giveawayId: string,
    source: GiveawayActionSource,
    actorUserId?: string,
  ): Promise<PersistedGiveawayWithRelations> {
    const giveaway = await this.findGiveawayById(giveawayId);
    const now = new Date();
    const drawSeed = giveaway.drawSeed?.trim() || randomBytes(32).toString('hex');

    const refreshedEntries = await Promise.all(
      giveaway.entries.map(async (entry) => {
        if (entry.eligibilityState === GiveawayEligibilityState.REJECTED) {
          return entry;
        }

        if (entry.eligibilityState === GiveawayEligibilityState.PENDING) {
          const result = await this.evaluateGiveawayEligibility(giveaway, entry.userId);
          return this.prisma.managedGiveawayEntry.update({
            where: { id: entry.id },
            data: {
              eligibilityState: result.state,
              eligibilityReason: result.reason,
              missingChannelIds: result.missingChannelIds,
              checkedAt: now,
            },
          });
        }

        return entry;
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

    const winnersToCreate = giveaway.prizes
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

    const completed = await this.prisma.$transaction(async (tx) => {
      await tx.managedGiveaway.update({
        where: { id: giveaway.id },
        data: {
          status: ManagedGiveawayStatus.DRAWING,
          drawSeed,
          drawnAt: now,
        },
      });

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
            claimDeadlineAt: new Date(now.getTime() + giveaway.claimHours * 60 * 60 * 1000),
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

    await this.editGiveawayPublicationIfNeeded(completed, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(completed);
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

    return completed;
  }

  private async expireDueClaimWinners(): Promise<Array<{ id: string; giveawayId: string }>> {
    const dueWinners = await this.prisma.managedGiveawayWinner.findMany({
      where: {
        status: ManagedGiveawayWinnerStatus.SELECTED,
        claimDeadlineAt: {
          lte: new Date(),
        },
      },
      select: {
        id: true,
        giveawayId: true,
      },
      orderBy: [{ claimDeadlineAt: 'asc' }, { selectedAt: 'asc' }],
      take: GIVEAWAY_DUE_BATCH_SIZE,
    });

    const expiredWinners: Array<{ id: string; giveawayId: string }> = [];
    for (const winner of dueWinners) {
      const updated = await this.prisma.managedGiveawayWinner.updateMany({
        where: {
          id: winner.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
        },
        data: {
          status: ManagedGiveawayWinnerStatus.EXPIRED,
          expiredAt: new Date(),
        },
      });
      if (updated.count > 0) {
        expiredWinners.push(winner);
      }
    }

    return expiredWinners;
  }

  private async processAutoRerollForExpiredWinners(
    expiredWinners: Array<{ id: string; giveawayId: string }>,
  ): Promise<void> {
    if (expiredWinners.length === 0) {
      return;
    }

    const byGiveaway = new Map<string, string[]>();
    for (const winner of expiredWinners) {
      const ids = byGiveaway.get(winner.giveawayId) ?? [];
      ids.push(winner.id);
      byGiveaway.set(winner.giveawayId, ids);
    }

    for (const [giveawayId, winnerIds] of byGiveaway.entries()) {
      for (const winnerId of winnerIds) {
        await this.autoRerollExpiredWinner(giveawayId, winnerId);
      }
    }
  }

  private async autoRerollExpiredWinner(giveawayId: string, winnerId: string): Promise<void> {
    const giveaway = await this.findGiveawayById(giveawayId);
    if (giveaway.status !== ManagedGiveawayStatus.COMPLETED || !giveaway.drawSeed) {
      return;
    }

    const winner = giveaway.winners.find((row) => row.id === winnerId);
    if (!winner || winner.status !== ManagedGiveawayWinnerStatus.EXPIRED) {
      return;
    }

    const nextEntry = this.pickNextRerollCandidate(giveaway, giveaway.drawSeed);
    if (!nextEntry) {
      return;
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.managedGiveawayEntry.update({
        where: { id: nextEntry.entry.id },
        data: { drawRank: nextEntry.drawRank, checkedAt: now },
      });

      const markWinnerAsRerolled = await tx.managedGiveawayWinner.updateMany({
        where: {
          id: winner.id,
          status: ManagedGiveawayWinnerStatus.EXPIRED,
        },
        data: {
          status: ManagedGiveawayWinnerStatus.REROLLED,
          rerolledAt: now,
        },
      });
      if (markWinnerAsRerolled.count === 0) {
        return null;
      }

      await tx.managedGiveawayWinner.create({
        data: {
          giveawayId: giveaway.id,
          prizeId: winner.prizeId,
          entryId: nextEntry.entry.id,
          rank: winner.rank,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          claimDeadlineAt: new Date(now.getTime() + giveaway.claimHours * 60 * 60 * 1000),
        },
      });

      return tx.managedGiveaway.findUniqueOrThrow({
        where: { id: giveaway.id },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });
    });

    if (!updated) {
      return;
    }

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.COMPLETED);
    await this.republishGiveawayResults(updated);
    await this.writeAuditLog(
      updated.sourceChatId,
      updated.actorUserId,
      'AUTO_REROLL_GIVEAWAY_WINNER',
      {
        giveawayId: updated.id,
        winnerId,
        nextEntryId: nextEntry.entry.id,
        source: 'runner',
      },
    );
  }

  private async upsertParticipantChatAccess(
    giveaway: PersistedGiveawayWithRelations,
  ): Promise<void> {
    await this.prisma.chat.upsert({
      where: { id: giveaway.sourceChatId },
      create: {
        id: giveaway.sourceChatId,
        title: await this.resolveSourceTitle(giveaway.sourceChatId),
        entityType: giveaway.entityType,
      },
      update: {},
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
    if (!this.ownBotUserId) {
      return null;
    }

    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'giveaway',
        g: giveawayId,
      }),
      'utf8',
    ).toString('base64url');

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(
      `${GIVEAWAY_START_PARAM_PREFIX}${payload}`,
    )}`;
  }

  private buildGiveawayDirectWebAppUrl(giveawayId: string): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/giveaways/${encodeURIComponent(giveawayId)}`;
  }

  private buildGiveawayClaimSignature(giveawayId: string, winnerId: string): string {
    return createHmac('sha256', this.maxBotToken)
      .update(`giveaway-claim:${giveawayId}:${winnerId}`)
      .digest('hex');
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

  private resolveBotContactId(): string | null {
    if (this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    if (!this.ownBotUserId) {
      return null;
    }

    const [candidate] = this.ownBotUserId.split('_');
    return /^\d+$/u.test(candidate) ? candidate : null;
  }
}
