import {
  MAX_PUBLICATION_SERVER_DRAFTS,
  MAX_PUBLICATION_DRAFT_STORAGE_BYTES,
  publicationDraftResponseSchema,
  publicationDraftStateSchema,
  savePublicationDraftRequestSchema,
} from '@maxim/contracts/publication-draft';
import { publicationActionRequestSchema } from '@maxim/contracts/publication';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma, type PublicationScheduleMode } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PublicationContentService,
  type PreparedPublicationContentRevision,
} from './publication-content.service';
import { PublicationPresenterService } from './publication-presenter.service';
import { PUBLICATION_ASSET_METADATA_SELECT } from './publication-media-limits';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherPolicyService } from './publisher-policy.service';

const draftWhere = (actorUserId: string) => ({
  actorUserId,
  lifecycle: 'DRAFT' as const,
  dispatchProfile: 'PUBLIK_V1' as const,
  occurrences: { none: {} },
});

@Injectable()
export class PublicationDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: PublicationContentService,
    private readonly presenter: PublicationPresenterService,
    private readonly routing: PublicationPublisherRoutingService,
    private readonly policy: PublisherPolicyService,
  ) {}

  async get(id: string, user: AuthUser) {
    if (!id || id.length > 256) throw new NotFoundException('Черновик не найден.');
    const row = await this.prisma.publication.findFirst({
      where: { id, ...draftWhere(user.userId) },
      include: {
        schedule: true,
        targets: { orderBy: { position: 'asc' } },
        canonicalContentRevision: {
          include: {
            assets: {
              orderBy: { position: 'asc' },
              include: { asset: { select: PUBLICATION_ASSET_METADATA_SELECT } },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Черновик не найден или уже опубликован.');
    const state = publicationDraftStateSchema.safeParse(row.schedule?.rule);
    const deliveryStats = { total: 0, sent: 0, pending: 0, failed: 0, ambiguous: 0, canceled: 0 };
    const targets = await this.presenter.loadPublisherTargetPresentations(
      row.targets,
      this.routing.requireNewRoute().requiredBotId,
    );
    const publication = await this.presenter.mapPublicationDetails(
      {
        ...row,
        occurrences: [],
        deliveryStats,
        actionableDeliveryStats: deliveryStats,
        nextOccurrenceAt: null,
        dispatchIssue: null,
      },
      targets,
    );
    return publicationDraftResponseSchema.parse({
      publication,
      state: state.success ? state.data : null,
    });
  }

  async byRequest(requestId: string, user: AuthUser) {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId))
      throw new NotFoundException('Черновик не найден.');
    const row = await this.prisma.publication.findFirst({
      where: { requestId, ...draftWhere(user.userId) },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Черновик не найден.');
    return this.get(row.id, user);
  }

  async save(id: string | null, user: AuthUser, body: unknown) {
    const parsed = savePublicationDraftRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const request = parsed.data;
    if (id && id.length > 256) throw new NotFoundException('Черновик не найден.');
    if (id && request.expectedRevision === undefined)
      throw new BadRequestException('Укажите версию черновика.');
    const hash = createHash('sha256')
      .update(JSON.stringify({ operation: 'save_draft', id, request }))
      .digest('hex');
    const replayWhere = {
      actorUserId_requestId: { actorUserId: user.userId, requestId: request.requestId },
    };
    const replay = await this.prisma.publicationMutationRecord.findUnique({ where: replayWhere });
    if (replay) {
      if (replay.requestHash !== hash || (id && replay.publicationId !== id))
        throw new ConflictException('Идентификатор запроса уже использован.');
      return this.getSavedVersion(replay.publicationId, replay.resultingVersion, user);
    }
    const route = this.routing.requireNewRoute();
    const targets = await this.policy.resolveDraftTargets(user, request.targets);
    const prepared = await this.content.prepareContentRevision(request.content);
    await this.content.assertPublisherCompatibleContent(prepared, user.userId);
    let saved: { id: string; version: number };
    try {
      saved = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`publication-drafts:${user.userId}`}))`,
          );
          const current = id
            ? await tx.publication.findFirst({
                where: { id, ...draftWhere(user.userId) },
                include: { canonicalContentRevision: { select: { revision: true } } },
              })
            : null;
          if (id && !current)
            throw new NotFoundException('Черновик не найден или уже опубликован.');
          if (current && current.version !== request.expectedRevision)
            throw new ConflictException('Черновик изменён на другом устройстве. Обновите его.');
          await this.assertQuota(tx, user.userId, id, prepared);
          const row =
            current ??
            (await tx.publication.create({
              data: {
                actorUserId: user.userId,
                requestId: request.requestId,
                title: request.title,
                lifecycle: 'DRAFT',
                audienceSelection: 'SELECTED',
                audienceMode: 'SNAPSHOT',
                ...route,
              },
            }));
          if (current) {
            const claim = await tx.publication.updateMany({
              where: { id: row.id, ...draftWhere(user.userId), version: request.expectedRevision },
              data: { version: { increment: 1 }, title: request.title },
            });
            if (!claim.count) throw new ConflictException('Черновик уже изменён. Обновите его.');
          }
          const revision = await this.content.persistPreparedContentRevision(
            tx,
            row.id,
            (current?.canonicalContentRevision?.revision ?? 0) + 1,
            prepared,
            user.userId,
          );
          await tx.publication.update({
            where: { id: row.id },
            data: { canonicalContentRevisionId: revision.id },
          });
          await tx.publicationTarget.deleteMany({ where: { publicationId: row.id } });
          await tx.publicationTarget.createMany({
            data: targets.map((target, position) => ({
              publicationId: row.id,
              targetChatId: target.chatId,
              entityType:
                target.entityType === 'channel' ? ('CHANNEL' as const) : ('CHAT' as const),
              position,
            })),
          });
          const state = request.state;
          const mode: PublicationScheduleMode =
            state.timingMode === 'now'
              ? 'NOW'
              : state.timingMode === 'once'
                ? 'ONCE'
                : state.scheduleKind === 'slots'
                  ? 'SLOTS'
                  : 'RECURRENCE';
          const schedule = {
            mode,
            timezone: state.scheduleTimezone,
            rule: state as Prisma.InputJsonValue,
            status: 'DRAFT' as const,
            nextMaterializeAt: null,
          };
          await tx.publicationSchedule.upsert({
            where: { publicationId: row.id },
            create: { publicationId: row.id, ...schedule },
            update: schedule,
          });
          await tx.publicationMutationRecord.create({
            data: {
              actorUserId: user.userId,
              requestId: request.requestId,
              requestHash: hash,
              publicationId: row.id,
              resultingVersion: current ? current.version + 1 : 1,
            },
          });
          await this.pruneUnusedRevisions(tx, row.id, revision.id, user.userId);
          return { id: row.id, version: current ? current.version + 1 : 1 };
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      const completed = await this.prisma.publicationMutationRecord.findUnique({
        where: replayWhere,
      });
      if (!completed || completed.requestHash !== hash) throw error;
      saved = { id: completed.publicationId, version: completed.resultingVersion };
    }
    return this.getSavedVersion(saved.id, saved.version, user);
  }

  private async getSavedVersion(id: string, version: number, user: AuthUser) {
    const saved = await this.get(id, user);
    if (saved.publication.version !== version)
      throw new ConflictException('Черновик изменён на другом устройстве. Обновите его.');
    return saved;
  }

  async remove(id: string, user: AuthUser, body: unknown): Promise<void> {
    if (!id || id.length > 256) throw new NotFoundException('Черновик не найден.');
    const request = publicationActionRequestSchema.safeParse(body);
    if (!request.success) throw new BadRequestException(request.error.format());
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`publication-drafts:${user.userId}`}))`,
      );
      const row = await tx.publication.findFirst({
        where: { id, actorUserId: user.userId, dispatchProfile: 'PUBLIK_V1' },
        select: { lifecycle: true, version: true },
      });
      if (!row) return;
      if (row.lifecycle !== 'DRAFT' || row.version !== request.data.expectedRevision)
        throw new ConflictException('Черновик уже изменён или опубликован.');
      const links = await tx.publicationContentAsset.findMany({
        where: { contentRevision: { publicationId: id } },
        select: { assetId: true },
        take: 1001,
      });
      if (links.length > 1000)
        throw new ConflictException('Слишком много версий черновика для одной операции.');
      await tx.publisherPostImportSession.updateMany({
        where: { publicationId: id, actorUserId: user.userId, status: 'READY' },
        data: { status: 'CANCELED', notificationPending: false, notificationKind: null },
      });
      // FLAG: Only a never-dispatched owned draft may be removed; shared/sent assets survive.
      const deleted = await tx.publication.deleteMany({
        where: { id, ...draftWhere(user.userId), version: request.data.expectedRevision },
      });
      if (!deleted.count) throw new ConflictException('Черновик уже изменён или отправляется.');
      await tx.publicationAsset.deleteMany({
        where: {
          id: { in: links.map((link) => link.assetId) },
          actorUserId: user.userId,
          contentLinks: { none: {} },
        },
      });
    });
  }

  private async assertQuota(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    excludeId: string | null,
    content: PreparedPublicationContentRevision,
  ) {
    const drafts = await tx.publication.findMany({
      where: {
        actorUserId,
        dispatchProfile: 'PUBLIK_V1',
        lifecycle: 'DRAFT',
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      take: MAX_PUBLICATION_SERVER_DRAFTS + 1,
      select: {
        canonicalContentRevision: {
          select: { assets: { select: { asset: { select: { sizeBytes: true } } } } },
        },
      },
    });
    if (drafts.length >= MAX_PUBLICATION_SERVER_DRAFTS)
      throw new BadRequestException(
        `Можно сохранить до ${MAX_PUBLICATION_SERVER_DRAFTS} черновиков.`,
      );
    const referenceIds = content.assets.flatMap((asset) =>
      asset.kind === 'reference' ? [asset.assetId] : [],
    );
    const references = referenceIds.length
      ? await tx.publicationAsset.findMany({
          where: { id: { in: referenceIds }, actorUserId },
          select: { id: true, sizeBytes: true },
        })
      : [];
    if (references.length !== new Set(referenceIds).size)
      throw new BadRequestException('Медиа черновика недоступно.');
    const bytes =
      drafts.reduce(
        (total, draft) =>
          total +
          (draft.canonicalContentRevision?.assets.reduce(
            (sum, link) => sum + link.asset.sizeBytes,
            0,
          ) ?? 0),
        0,
      ) +
      content.assets.reduce(
        (total, asset) =>
          total +
          (asset.kind === 'prepared'
            ? asset.sizeBytes
            : references.find((ref) => ref.id === asset.assetId)!.sizeBytes),
        0,
      );
    if (bytes > MAX_PUBLICATION_DRAFT_STORAGE_BYTES)
      throw new BadRequestException(
        'Медиа черновиков превышают 128 МБ. Удалите ненужные черновики.',
      );
  }

  private async pruneUnusedRevisions(
    tx: Prisma.TransactionClient,
    publicationId: string,
    currentId: string,
    actorUserId: string,
  ) {
    const where = {
      publicationId,
      id: { not: currentId },
      canonicalForPublication: { is: null },
      deliveries: { none: {} },
      occurrences: { none: {} },
      executionBroadcasts: { none: {} },
    };
    const rows = await tx.publicationContentRevision.findMany({
      where,
      take: 100,
      select: { id: true, assets: { select: { assetId: true } } },
    });
    if (!rows.length) return;
    // FLAG: Do not prune any revision attributed to a send, occurrence, or execution envelope.
    await tx.publicationContentRevision.deleteMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
    });
    await tx.publicationAsset.deleteMany({
      where: {
        id: { in: rows.flatMap((row) => row.assets.map((asset) => asset.assetId)) },
        actorUserId,
        contentLinks: { none: {} },
      },
    });
  }
}
