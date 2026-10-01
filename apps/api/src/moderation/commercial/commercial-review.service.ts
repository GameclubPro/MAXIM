import { createHash } from 'node:crypto';
import {
  commercialReviewDecisionRequestSchema,
  commercialReviewItemSchema,
  commercialReviewQueueQuerySchema,
  type CommercialReviewItem,
  type CommercialReviewQueueResponse,
} from '@maxim/contracts/safety-desk';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import {
  sanitizeCommercialCorpusText,
  hasResidualCommercialContactCandidate,
} from '../../scripts/commercial-corpus-sanitization.util';

const REVIEW_TTL_DAYS = 14;
type ReviewEvidence = Omit<
  CommercialReviewItem,
  'id' | 'chatId' | 'chatTitle' | 'observedAt' | 'expiresAt' | 'updatedAt'
>;
type Candidate = {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  score: number;
  actionBand: string;
  source: 'TEXT' | 'OCR';
  decisionFingerprint: string;
  detectorVersion: string;
  messageDisposition: 'KEEP' | 'DELETE';
  requiredPolicyCohorts: readonly string[];
  reviewPriority?: number;
  reasons?: readonly string[];
};
type ReviewRow = Prisma.CommercialReviewSampleGetPayload<{
  include: { chat: { select: { title: true } } };
}>;

function boundedCodes(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => /^[a-z0-9_.:-]{1,120}$/iu.test(value)))].slice(0, 32);
}
function redact(value: string, limit: number): string {
  const sanitized = sanitizeCommercialCorpusText(value);
  return hasResidualCommercialContactCandidate(sanitized)
    ? '[контактные данные скрыты]'
    : sanitized.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
}

@Injectable()
export class CommercialReviewService {
  private readonly logger = new Logger(CommercialReviewService.name);
  constructor(private readonly prisma: PrismaService) {}

  // FLAG: Feedback samples never enter reputation aggregation or change sanctions.
  // Capture is best-effort; neither persistence failures nor review labels authorize a MAX call.
  async recordCandidate(input: Candidate): Promise<void> {
    try {
      if (!input.chatId || !input.userId || !input.messageId) return;
      const now = new Date();
      const evidence: ReviewEvidence = {
        source: input.source,
        excerpt: redact(input.text, 2500),
        score: Number.isFinite(input.score) ? Math.max(0, Math.min(100, input.score)) : 0,
        actionBand: boundedCodes([input.actionBand])[0] ?? 'UNKNOWN',
        messageDisposition: input.messageDisposition,
        requiredPolicyCohorts: boundedCodes(input.requiredPolicyCohorts),
        detectorVersion: boundedCodes([input.detectorVersion])[0] ?? 'unknown',
        decisionFingerprint: boundedCodes([input.decisionFingerprint])[0] ?? 'unknown',
        reviewPriority: Number.isFinite(input.reviewPriority)
          ? Math.max(0, Math.min(100, Math.round(input.reviewPriority!)))
          : input.messageDisposition === 'DELETE'
            ? 90
            : 50,
        reasons: boundedCodes(input.reasons ?? []),
        label: null,
        reviewReason: '',
        reviewedAt: null,
      };
      const evidenceHash = createHash('sha256')
        .update(
          JSON.stringify([
            input.chatId,
            input.messageId,
            input.source,
            input.decisionFingerprint,
            input.messageDisposition,
          ]),
        )
        .digest('hex');
      await this.prisma.commercialReviewSample.upsert({
        where: { evidenceHash },
        create: {
          userId: input.userId,
          chatId: input.chatId,
          messageId: input.messageId,
          source: input.source,
          score: evidence.score / 100,
          evidenceHash,
          evidence: evidence as Prisma.InputJsonValue,
          reviewPriority: evidence.reviewPriority,
          observedAt: now,
          expiresAt: new Date(now.getTime() + REVIEW_TTL_DAYS * 86400_000),
        },
        update: {},
      });
    } catch {
      this.logger.warn(
        { stage: 'commercial-review-record' },
        'Commercial review capture unavailable',
      );
    }
  }

  async pruneExpired(limit = 1000): Promise<number> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(5000, Math.floor(limit)))
      : 1000;
    const now = new Date();
    const expired = await this.prisma.commercialReviewSample.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit,
      select: { id: true },
    });
    if (!expired.length) return 0;
    const deleted = await this.prisma.commercialReviewSample.deleteMany({
      where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lte: now } },
    });
    return deleted.count;
  }

  async getQueue(query: unknown): Promise<CommercialReviewQueueResponse> {
    const parsed = commercialReviewQueueQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Некорректные параметры очереди.');
    const { limit, cursor, status } = parsed.data;
    let after: { observedAt: Date; id: string; reviewPriority: number } | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          observedAt: unknown;
          id: unknown;
          reviewPriority: unknown;
        };
        if (
          typeof decoded.observedAt !== 'string' ||
          typeof decoded.id !== 'string' ||
          !/^[a-z0-9_-]{1,100}$/iu.test(decoded.id) ||
          !Number.isFinite(Date.parse(decoded.observedAt)) ||
          typeof decoded.reviewPriority !== 'number' ||
          !Number.isInteger(decoded.reviewPriority) ||
          decoded.reviewPriority < 0 ||
          decoded.reviewPriority > 100
        )
          throw new Error();
        after = {
          observedAt: new Date(decoded.observedAt),
          id: decoded.id,
          reviewPriority: decoded.reviewPriority,
        };
      } catch {
        throw new BadRequestException('Некорректная страница очереди.');
      }
    }
    const rows = await this.prisma.commercialReviewSample.findMany({
      where: {
        ...(status === 'PENDING'
          ? { label: null }
          : status === 'REVIEWED'
            ? { label: { not: null } }
            : {}),
        expiresAt: { gt: new Date() },
        ...(after
          ? {
              OR: [
                { reviewPriority: { lt: after.reviewPriority } },
                { reviewPriority: after.reviewPriority, observedAt: { lt: after.observedAt } },
                {
                  reviewPriority: after.reviewPriority,
                  observedAt: after.observedAt,
                  id: { lt: after.id },
                },
              ],
            }
          : {}),
      },
      include: { chat: { select: { title: true } } },
      orderBy: [{ reviewPriority: 'desc' }, { observedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      generatedAt: new Date().toISOString(),
      items: page.flatMap((row) => {
        const item = this.mapItem(row);
        return item ? [item] : [];
      }),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                observedAt: last.observedAt.toISOString(),
                id: last.id,
                reviewPriority: last.reviewPriority,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async labelItem(id: string, actor: string | null, body: unknown): Promise<CommercialReviewItem> {
    const parsed = commercialReviewDecisionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некорректная оценка.');
    const current = await this.prisma.commercialReviewSample.findUnique({
      where: { id },
      include: { chat: { select: { title: true } } },
    });
    if (!current || !current.chatId || current.expiresAt <= new Date())
      throw new NotFoundException('Материал недоступен.');
    const item = this.mapItem(current);
    if (!item) throw new NotFoundException('Материал недоступен.');
    const expected = new Date(parsed.data.expectedUpdatedAt);
    if (current.updatedAt.getTime() !== expected.getTime())
      throw new ConflictException('Оценка уже изменена. Обновите очередь.');
    const reviewedAt = new Date(Math.max(Date.now(), expected.getTime() + 1));
    const evidence = {
      ...(current.evidence as Record<string, unknown>),
      label: parsed.data.label,
      reviewReason: redact(parsed.data.reason, 500),
      reviewedAt: reviewedAt.toISOString(),
    };
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercialReviewSample.updateMany({
        where: { id, updatedAt: expected, expiresAt: { gt: reviewedAt } },
        data: {
          evidence: evidence as Prisma.InputJsonValue,
          label: parsed.data.label,
          updatedAt: reviewedAt,
        },
      });
      if (changed.count !== 1)
        throw new ConflictException('Оценка уже изменена. Обновите очередь.');
      await tx.auditLog.create({
        data: {
          chatId: current.chatId!,
          actorUserId: actor?.trim() || 'safety-desk-owner',
          action: 'SAFETY_DESK_COMMERCIAL_LABEL',
          payload: {
            observationId: id,
            label: parsed.data.label,
            reason: evidence.reviewReason,
            previousLabel: item.label,
            detectorVersion: item.detectorVersion,
            decisionFingerprint: item.decisionFingerprint,
          },
        },
      });
    });
    return {
      ...item,
      label: parsed.data.label,
      reviewReason: evidence.reviewReason,
      reviewedAt: reviewedAt.toISOString(),
      updatedAt: reviewedAt.toISOString(),
    };
  }

  private mapItem(row: ReviewRow): CommercialReviewItem | null {
    const evidence =
      row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence)
        ? row.evidence
        : {};
    const parsed = commercialReviewItemSchema.safeParse({
      ...evidence,
      label: row.label,
      id: row.id,
      chatId: row.chatId,
      chatTitle: row.chat?.title ?? 'Чат недоступен',
      observedAt: row.observedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    return parsed.success
      ? {
          ...parsed.data,
          excerpt: redact(parsed.data.excerpt, 2500),
          reviewReason: redact(parsed.data.reviewReason, 500),
        }
      : null;
  }
}
