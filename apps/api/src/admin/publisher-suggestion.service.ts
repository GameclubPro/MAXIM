import {
  publisherSuggestionSchema,
  publisherSuggestionsQuerySchema,
  publisherSuggestionsResponseSchema,
  reviewPublisherSuggestionRequestSchema,
  reviewPublisherSuggestionResponseSchema,
  type PublisherSuggestion,
  type PublisherSuggestionsResponse,
  type ReviewPublisherSuggestionResponse,
} from '@maxim/contracts/publisher';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationDispatchProfile, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST } from './admin.service.support';
import { PublicationService } from './publication.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';
import {
  buildPublisherSuggestionPublicationRequestId,
  isPublisherSuggestionReviewProtocol,
  PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
  PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS,
  PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
  readLegacyPublisherSuggestionInlineClaim,
  readPublisherSuggestionReviewClaim,
  type PublisherSuggestionReviewClaim,
} from './publisher-suggestion-review-protocol';

type PublisherSuggestionRow = {
  id: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

type PublisherSuggestionStoredRow = PublisherSuggestionRow & {
  chatId: string;
};

type LegacyPublisherSuggestion = Omit<PublisherSuggestion, 'textFormat' | 'reviewError'>;
type LegacyPublisherSuggestionsResponse = { items: LegacyPublisherSuggestion[] };
type LegacyReviewPublisherSuggestionResponse = { suggestion: LegacyPublisherSuggestion };

type PublisherSuggestionListCursor = {
  entityId: string;
  view: 'pending' | 'history';
  createdAt: string;
  id: string;
};

@Injectable()
export class PublisherSuggestionService {
  private readonly logger = new Logger(PublisherSuggestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PublisherPolicyService,
    private readonly publications: PublicationService,
    private readonly publicationQueue: PublisherSuggestionPublicationQueueService,
  ) {}

  async list(
    entityId: string,
    user: AuthUser,
    query?: unknown,
  ): Promise<PublisherSuggestionsResponse | LegacyPublisherSuggestionsResponse> {
    await this.policy.getEntity('channel', entityId, user);
    if (!this.isPaginatedListQuery(query)) {
      const rows = await this.prisma.auditLog.findMany({
        where: { chatId: entityId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, payload: true, createdAt: true },
      });
      return { items: rows.map((row) => this.presentLegacy(row)) };
    }
    const parsed = publisherSuggestionsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const { view, limit } = parsed.data;
    const cursor = parsed.data.cursor
      ? this.decodeListCursor(parsed.data.cursor, entityId, view)
      : null;
    const statusPredicate =
      view === 'pending'
        ? Prisma.sql`COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') NOT IN ('published', 'cancelled')`
        : Prisma.sql`COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') IN ('published', 'cancelled')`;
    const cursorPredicate = cursor
      ? Prisma.sql`AND (
          created_at < ${new Date(cursor.createdAt)}
          OR (created_at = ${new Date(cursor.createdAt)} AND id < ${cursor.id}::text)
        )`
      : Prisma.empty;

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<PublisherSuggestionRow[]>(Prisma.sql`
        SELECT id, payload, created_at AS "createdAt"
        FROM audit_logs
        WHERE chat_id = ${entityId}::text
          AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND jsonb_typeof(payload::jsonb) = 'object'
          AND ${statusPredicate}
          ${cursorPredicate}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS total
        FROM audit_logs
        WHERE chat_id = ${entityId}::text
          AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND jsonb_typeof(payload::jsonb) = 'object'
          AND ${statusPredicate}
      `),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return publisherSuggestionsResponseSchema.parse({
      items: page.map((row) => this.present(row)),
      total: totals[0]?.total ?? 0,
      nextCursor:
        hasMore && last
          ? this.encodeListCursor({
              entityId,
              view,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    });
  }

  async review(
    entityId: string,
    suggestionId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ReviewPublisherSuggestionResponse | LegacyReviewPublisherSuggestionResponse> {
    await this.policy.getEntity('channel', entityId, user);
    const parsed = reviewPublisherSuggestionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const responseVersion = parsed.data.responseVersion === 2 ? 2 : 1;
    let row = await this.findRow(suggestionId.trim(), entityId);
    if (!row) {
      throw new BadRequestException('Предложка не найдена.');
    }
    let payload = this.readPayload(row.payload);
    let currentStatus = this.readStatus(payload.reviewStatus);
    if (currentStatus === 'publishing' && payload.reviewPublicationProtocol == null) {
      row =
        (await this.migrateLegacyInlineClaim(row, payload, user)) ??
        (await this.requireRow(row.id, entityId));
      payload = this.readPayload(row.payload);
      currentStatus = this.readStatus(payload.reviewStatus);
    }
    const durableClaim = readPublisherSuggestionReviewClaim(payload, row.id, {
      allowPending: true,
    });
    if (currentStatus === 'pending' && durableClaim) {
      currentStatus = 'publishing';
    }
    if (currentStatus === 'published' || currentStatus === 'cancelled') {
      const expectedStatus = parsed.data.action === 'publish' ? 'published' : 'cancelled';
      if (currentStatus === expectedStatus) {
        return this.reviewResponse(row, responseVersion);
      }
      throw new ConflictException(
        currentStatus === 'published'
          ? 'Предложка уже принята в публикацию.'
          : 'Предложка уже отклонена.',
      );
    }

    if (parsed.data.action === 'cancel') {
      if (currentStatus === 'publishing') {
        throw new ConflictException('Предложка уже публикуется и не может быть отклонена.');
      }
      const cancelled = await this.cancelPending(row.id, entityId, user);
      if (cancelled) {
        return this.reviewResponse(cancelled, responseVersion);
      }
      const latest = await this.requireRow(row.id, entityId);
      if (this.readStatus(this.readPayload(latest.payload).reviewStatus) !== 'cancelled') {
        throw new ConflictException('Состояние предложки изменилось до отмены.');
      }
      return this.reviewResponse(latest, responseVersion);
    }

    if (currentStatus === 'publishing') {
      if (durableClaim) {
        await this.enqueueClaim(row.id, durableClaim.claimToken);
      }
      return this.reviewResponse(row, responseVersion);
    }

    const text = this.readString(payload.text);
    if (!text) {
      throw new BadRequestException('В предложке нет текста.');
    }
    const claimed = await this.claimPending(row.id, entityId, user);
    if (!claimed) {
      const latest = await this.requireRow(row.id, entityId);
      const latestStatus = this.readStatus(this.readPayload(latest.payload).reviewStatus);
      if (latestStatus === 'cancelled') {
        throw new ConflictException('Предложка уже отклонена.');
      }
      if (latestStatus === 'pending') {
        throw new ConflictException('Не удалось зафиксировать заявку на публикацию.');
      }
      return this.reviewResponse(latest, responseVersion);
    }
    const claim = readPublisherSuggestionReviewClaim(this.readPayload(claimed.payload), row.id);
    if (!claim) {
      throw new ConflictException('Не удалось подтвердить заявку на публикацию.');
    }
    await this.enqueueClaim(row.id, claim.claimToken);
    return this.reviewResponse(claimed, responseVersion);
  }

  /** Returns false only for a legacy claim owned by the old channel-dialog pipeline. */
  async processPublicationJob(suggestionId: string, expectedClaimToken: string): Promise<boolean> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: suggestionId.trim(),
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: { id: true, chatId: true, payload: true, createdAt: true },
    });
    if (!row) return false;

    const payload = this.readPayload(row.payload);
    if (!isPublisherSuggestionReviewProtocol(payload)) return false;
    const claim = readPublisherSuggestionReviewClaim(payload, row.id, { allowPending: true });
    if (!claim || claim.claimToken !== expectedClaimToken.trim()) return true;

    const text = this.readString(payload.text);
    if (!text) {
      await this.releaseTerminalClaim(row, claim, 'В предложке нет текста.');
      return true;
    }

    try {
      const publication = await this.publications.create(
        claim.user,
        {
          requestId: claim.requestId,
          title: 'Предложка',
          content: {
            text,
            textFormat: this.readString(payload.textFormat) === 'markdown' ? 'markdown' : 'plain',
            buttons: [],
            media: [],
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: row.chatId, entityType: 'channel' }],
          },
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
        PublicationDispatchProfile.PUBLIK_V1,
      );
      await this.finalizeClaimOrThrow(row, claim, publication.id);
      return true;
    } catch (error: unknown) {
      // A failed lookup throws and keeps the claim until exact mutation absence is proven.
      const mutationExists = await this.hasClaimMutationRecord(claim);
      if (mutationExists) {
        // PublicationService owns request-hash validation. Retrying it is the only safe way
        // to distinguish an exact replay from a colliding request id.
        throw error;
      }
      if (this.isTerminalPublicationError(error)) {
        await this.releaseTerminalClaim(
          row,
          claim,
          error instanceof Error ? error.message.slice(0, 300) : 'Ошибка публикации',
        );
        return true;
      }
      throw error;
    }
  }

  private async migrateLegacyInlineClaim(
    row: PublisherSuggestionStoredRow,
    payload: Record<string, unknown>,
    currentUser: AuthUser,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const legacyClaim = readLegacyPublisherSuggestionInlineClaim(payload, row.id);
    if (!legacyClaim) {
      return null;
    }
    const { claimedAt, claimedByUserId, requestId } = legacyClaim;
    const staleBefore = new Date(
      Date.now() - PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS,
    ).toISOString();
    const claimToken = randomUUID();
    const sameReviewer = currentUser.userId === claimedByUserId;
    const patch = {
      reviewAction: 'publish',
      reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
      reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
      reviewPublicationRequestId: requestId,
      reviewClaimToken: claimToken,
      reviewClaimedAt: claimedAt,
      reviewClaimedByUserId: claimedByUserId,
      reviewClaimedByUsername: sameReviewer ? currentUser.username?.trim() || null : null,
      reviewClaimedByDisplayName: sameReviewer ? currentUser.displayName?.trim() || null : null,
      reviewClaimedByAvatarUrl: sameReviewer ? currentUser.avatarUrl?.trim() || null : null,
      reviewClaimedByProfileUrl: sameReviewer ? currentUser.profileUrl?.trim() || null : null,
      reviewClaimMigratedFrom: 'inline_v0',
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || ${JSON.stringify(patch)}::jsonb
      WHERE id = ${row.id}::text
        AND chat_id = ${row.chatId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND payload->>'reviewStatus' = 'publishing'
        AND payload->>'reviewPublicationProtocol' IS NULL
        AND payload->>'reviewedByUserId' = ${claimedByUserId}::text
        AND payload->>'reviewedAt' = ${claimedAt}::text
        AND payload->>'reviewedAt' <= ${staleBefore}::text
      RETURNING id, chat_id AS "chatId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async claimPending(
    suggestionId: string,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const claimToken = randomUUID();
    const claimPatch = {
      reviewStatus: 'publishing',
      reviewAction: 'publish',
      reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
      reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
      reviewPublicationRequestId: buildPublisherSuggestionPublicationRequestId(
        suggestionId,
        claimToken,
      ),
      reviewClaimToken: claimToken,
      reviewClaimedAt: new Date().toISOString(),
      reviewClaimedByUserId: user.userId,
      reviewClaimedByUsername: user.username?.trim() || null,
      reviewClaimedByDisplayName: user.displayName?.trim() || null,
      reviewClaimedByAvatarUrl: user.avatarUrl?.trim() || null,
      reviewClaimedByProfileUrl: user.profileUrl?.trim() || null,
      reviewedByUserId: user.userId,
      reviewClaimMigratedFrom: null,
      reviewError: null,
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || ${JSON.stringify(claimPatch)}::jsonb
      WHERE id = ${suggestionId}::text
        AND chat_id = ${entityId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') = 'pending'
        AND payload->>'reviewClaimToken' IS NULL
      RETURNING id, chat_id AS "chatId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async cancelPending(
    suggestionId: string,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const patch = {
      reviewStatus: 'cancelled',
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: user.userId,
      reviewError: null,
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb || ${JSON.stringify(patch)}::jsonb
      )
        - 'reviewAction'
        - 'reviewDispatchProfile'
        - 'reviewPublicationProtocol'
        - 'reviewPublicationRequestId'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUserId'
        - 'reviewClaimedByUsername'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimedByAvatarUrl'
        - 'reviewClaimedByProfileUrl'
      WHERE id = ${suggestionId}::text
        AND chat_id = ${entityId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') = 'pending'
        AND payload->>'reviewClaimToken' IS NULL
      RETURNING id, chat_id AS "chatId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async finalizeClaim(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    publicationId: string,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const patch = {
      reviewStatus: 'published',
      publicationId,
      publishedAt: new Date().toISOString(),
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: claim.user.userId,
      reviewError: null,
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb || ${JSON.stringify(patch)}::jsonb
      )
        - 'reviewAction'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUsername'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimedByAvatarUrl'
        - 'reviewClaimedByProfileUrl'
      WHERE id = ${row.id}::text
        AND chat_id = ${row.chatId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'reviewStatus' IN ('publishing', 'pending')
        AND payload->>'reviewPublicationProtocol' = ${PUBLISHER_SUGGESTION_REVIEW_PROTOCOL}::text
        AND payload->>'reviewPublicationRequestId' = ${claim.requestId}::text
        AND payload->>'reviewClaimToken' = ${claim.claimToken}::text
        AND payload->>'reviewClaimedByUserId' = ${claim.user.userId}::text
      RETURNING id, chat_id AS "chatId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async finalizeClaimOrThrow(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    publicationId: string,
  ): Promise<void> {
    if (await this.finalizeClaim(row, claim, publicationId)) {
      return;
    }
    const latest = await this.requireRow(row.id, row.chatId);
    const latestPayload = this.readPayload(latest.payload);
    if (
      this.readStatus(latestPayload.reviewStatus) === 'published' &&
      this.readString(latestPayload.publicationId) === publicationId
    ) {
      return;
    }
    throw new ConflictException(
      'Состояние предложки изменилось после создания публикации. Требуется повторная проверка.',
    );
  }

  private async releaseTerminalClaim(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    error: string,
  ): Promise<void> {
    const patch = {
      reviewStatus: 'pending',
      reviewError: error.slice(0, 300),
      reviewClaimReleasedAt: new Date().toISOString(),
    } satisfies Prisma.InputJsonObject;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb || ${JSON.stringify(patch)}::jsonb
      )
        - 'reviewAction'
        - 'reviewDispatchProfile'
        - 'reviewPublicationProtocol'
        - 'reviewPublicationRequestId'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUserId'
        - 'reviewClaimedByUsername'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimedByAvatarUrl'
        - 'reviewClaimedByProfileUrl'
      WHERE id = ${row.id}::text
        AND chat_id = ${row.chatId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'reviewStatus' IN ('publishing', 'pending')
        AND payload->>'reviewPublicationProtocol' = ${PUBLISHER_SUGGESTION_REVIEW_PROTOCOL}::text
        AND payload->>'reviewPublicationRequestId' = ${claim.requestId}::text
        AND payload->>'reviewClaimToken' = ${claim.claimToken}::text
        AND payload->>'reviewClaimedByUserId' = ${claim.user.userId}::text
    `);
  }

  private async hasClaimMutationRecord(claim: PublisherSuggestionReviewClaim): Promise<boolean> {
    const record = await this.prisma.publicationMutationRecord.findUnique({
      where: {
        actorUserId_requestId: {
          actorUserId: claim.user.userId,
          requestId: claim.requestId,
        },
      },
      select: { publicationId: true },
    });
    return Boolean(record);
  }

  private async enqueueClaim(suggestionId: string, claimToken: string): Promise<void> {
    try {
      await this.publicationQueue.enqueue(suggestionId, claimToken, { recycleCompleted: true });
    } catch (error: unknown) {
      this.logger.warn(
        {
          suggestionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publik suggestion claim persisted but immediate queue enqueue failed; recovery will retry',
      );
    }
  }

  private requireRow(id: string, chatId: string): Promise<PublisherSuggestionStoredRow> {
    return this.prisma.auditLog.findFirstOrThrow({
      where: { id, chatId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, chatId: true, payload: true, createdAt: true },
    });
  }

  private findRow(id: string, chatId: string): Promise<PublisherSuggestionStoredRow | null> {
    return this.prisma.auditLog.findFirst({
      where: { id, chatId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, chatId: true, payload: true, createdAt: true },
    });
  }

  private reviewResponse(
    row: PublisherSuggestionRow,
    responseVersion: 1 | 2,
  ): ReviewPublisherSuggestionResponse | LegacyReviewPublisherSuggestionResponse {
    if (responseVersion === 2) {
      return reviewPublisherSuggestionResponseSchema.parse({ suggestion: this.present(row) });
    }
    return { suggestion: this.presentLegacy(row) };
  }

  private present(row: PublisherSuggestionRow): PublisherSuggestion {
    const payload = this.readPayload(row.payload);
    return publisherSuggestionSchema.parse({
      id: row.id,
      text: this.readString(payload.text) ?? '',
      textFormat: this.readString(payload.textFormat) === 'markdown' ? 'markdown' : 'plain',
      authorDisplayName: this.readString(payload.authorDisplayName),
      createdAt: row.createdAt.toISOString(),
      reviewStatus: this.readStatus(payload.reviewStatus),
      publicationId: this.readString(payload.publicationId),
      reviewError: this.readString(payload.reviewError),
    });
  }

  private presentLegacy(row: PublisherSuggestionRow): LegacyPublisherSuggestion {
    const suggestion = this.present(row);
    return {
      id: suggestion.id,
      text: suggestion.text,
      authorDisplayName: suggestion.authorDisplayName,
      createdAt: suggestion.createdAt,
      reviewStatus: suggestion.reviewStatus,
      publicationId: suggestion.publicationId,
    };
  }

  private isPaginatedListQuery(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const query = value as Record<string, unknown>;
    return 'view' in query || 'limit' in query || 'cursor' in query;
  }

  private encodeListCursor(cursor: PublisherSuggestionListCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeListCursor(
    value: string,
    entityId: string,
    view: 'pending' | 'history',
  ): PublisherSuggestionListCursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<PublisherSuggestionListCursor>;
      if (
        parsed.entityId !== entityId ||
        parsed.view !== view ||
        typeof parsed.createdAt !== 'string' ||
        !Number.isFinite(new Date(parsed.createdAt).getTime()) ||
        typeof parsed.id !== 'string' ||
        !parsed.id.trim() ||
        parsed.id.length > 256
      ) {
        throw new Error('cursor mismatch');
      }
      return {
        entityId,
        view,
        createdAt: new Date(parsed.createdAt).toISOString(),
        id: parsed.id,
      };
    } catch {
      throw new BadRequestException('Курсор предложек устарел или повреждён.');
    }
  }

  private readPayload(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readStatus(value: unknown): PublisherSuggestion['reviewStatus'] {
    return value === 'publishing' || value === 'published' || value === 'cancelled'
      ? value
      : 'pending';
  }

  private isTerminalPublicationError(error: unknown): boolean {
    if (!(error instanceof HttpException)) return false;
    const status = error.getStatus();
    return (
      status >= 400 &&
      status < 500 &&
      status !== HttpStatus.REQUEST_TIMEOUT &&
      status !== HttpStatus.TOO_MANY_REQUESTS
    );
  }
}
