import {
  archivePublisherAutoReplyRequestSchema,
  archivePublisherAutoReplyResponseSchema,
  createPublisherAutoReplyV2RequestSchema,
  createPublisherAutoReplyRequestSchema,
  MAX_PUBLISHER_AUTO_REPLY_BUTTONS,
  MAX_PUBLISHER_AUTO_REPLY_IMAGES,
  MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH,
  normalizePublisherAutoReplyPhrase,
  publisherAutoReplyListResponseV2Schema,
  publisherAutoReplyButtonSchema,
  publisherAutoReplyListResponseSchema,
  publisherAutoReplyPhrasesSchema,
  publisherAutoReplyPreviewRequestSchema,
  publisherAutoReplyPreviewResponseSchema,
  publisherAutoReplyRequestIdSchema,
  publisherAutoReplyRuleV2Schema,
  publisherAutoReplyRuleSchema,
  updatePublisherAutoReplyV2RequestSchema,
  updatePublisherAutoReplyRequestSchema,
  type ArchivePublisherAutoReplyResponse,
  type PublisherAutoReplyButton,
  type PublisherAutoReplyContentInput,
  type PublisherAutoReplyListResponse,
  type PublisherAutoReplyListResponseV2,
  type PublisherAutoReplyPreviewResponse,
  type PublisherAutoReplyRule,
  type PublisherAutoReplyRuleV2,
} from '@maxim/contracts/publisher-auto-replies';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxClientService } from '../max/max-client.service';
import { MaxMediaUploadValidationError } from '../max/max-media-upload-validation';
import { Prisma, PublicationContentFormat } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalizeAdminMaxMediaFileName } from './admin-max-media-file-name';
import { isPrismaKnownError } from './admin-legacy-utils';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import { readStoredPublicationButtons } from './publication-buttons';
import { PublisherPolicyService } from './publisher-policy.service';
import {
  matchPublisherAutoReply,
  PUBLISHER_AUTO_REPLY_MATCHER_LIMITS,
  type PublisherAutoReplyTriggerCandidate,
} from '../publisher/publisher-auto-reply-matcher';

const AUTO_REPLY_RULE_INCLUDE = {
  currentContentRevision: {
    include: {
      assets: {
        orderBy: { position: 'asc' as const },
        include: { asset: true },
      },
    },
  },
  triggers: {
    where: { archivedAt: null },
    orderBy: { position: 'asc' as const },
  },
} satisfies Prisma.PublisherAutoReplyRuleInclude;

type AutoReplyRuleRow = Prisma.PublisherAutoReplyRuleGetPayload<{
  include: typeof AUTO_REPLY_RULE_INCLUDE;
}>;

export type PreparedPublisherAutoReplyImage =
  | { kind: 'reference'; assetId: string }
  | {
      kind: 'prepared';
      sha256: string;
      mimeType: string;
      fileName: string;
      sizeBytes: number;
      bytes: Buffer;
    };

export type PreparedPublisherAutoReplyContent = {
  text: string;
  textFormat: 'plain' | 'markdown';
  images: PreparedPublisherAutoReplyImage[];
  buttons: PublisherAutoReplyButton[];
};

export type PersistPublisherAutoReplyContentParams = {
  ruleId: string;
  chatId: string;
  revision: number;
  actorUserId: string;
  content: PreparedPublisherAutoReplyContent;
};

export type CreatePublisherAutoReplyFromPreparedContentParams = {
  chatId: string;
  actorUserId: string;
  requestId: string;
  sessionId: string;
  phrase: string;
  normalizedPhrase: string;
  phrases?: string[];
  matchInContext?: boolean;
  fuzzyMatch?: boolean;
  content: PreparedPublisherAutoReplyContent;
};

type AutoReplyContractVersion = 1 | 2;
type AutoReplyRuleResponse = PublisherAutoReplyRule | PublisherAutoReplyRuleV2;
type AutoReplyListResponse = PublisherAutoReplyListResponse | PublisherAutoReplyListResponseV2;
const AUTO_REPLY_PREVIEW_DRAFT_RULE_ID = '__publisher_auto_reply_preview_draft__';

type PersistedContentSummary = {
  id: string;
  revision: number;
  textLength: number;
  textSha256: string;
  textFormat: 'plain' | 'markdown';
  buttonCount: number;
  images: Array<{
    position: number;
    assetId: string;
    sha256: string;
    mimeType: string;
    sizeBytes: number;
  }>;
};

@Injectable()
export class PublisherAutoReplyService {
  private readonly extendedMatchingMode: 'off' | 'shadow' | 'on';

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PublisherPolicyService,
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
  ) {
    this.extendedMatchingMode = configService.get<'off' | 'shadow' | 'on'>(
      'PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE',
      'on',
    );
  }

  async list(
    chatId: string,
    user: AuthUser,
    contractVersion: AutoReplyContractVersion = 1,
  ): Promise<AutoReplyListResponse> {
    await this.policy.getEntity('chat', chatId, user);
    const where = { chatId, archivedAt: null, currentContentRevisionId: { not: null } };
    const [rows, total] = await Promise.all([
      this.prisma.publisherAutoReplyRule.findMany({
        where,
        include: AUTO_REPLY_RULE_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.publisherAutoReplyRule.count({ where }),
    ]);
    const response = { items: rows.map((row) => this.presentRule(row, contractVersion)), total };
    return contractVersion === 2
      ? publisherAutoReplyListResponseV2Schema.parse(response)
      : publisherAutoReplyListResponseSchema.parse(response);
  }

  async get(
    chatId: string,
    ruleId: string,
    user: AuthUser,
    contractVersion: AutoReplyContractVersion = 1,
  ): Promise<AutoReplyRuleResponse> {
    await this.policy.getEntity('chat', chatId, user);
    return this.presentRule(await this.requireRule(chatId, ruleId), contractVersion);
  }

  async create(
    chatId: string,
    user: AuthUser,
    body: unknown,
    contractVersion: AutoReplyContractVersion = 1,
  ): Promise<AutoReplyRuleResponse> {
    const parsed =
      contractVersion === 2
        ? createPublisherAutoReplyV2RequestSchema.safeParse(body)
        : createPublisherAutoReplyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const entity = await this.policy.getEntity('chat', chatId, user);
    const request = parsed.data;
    const phrases = 'phrases' in request ? request.phrases : [request.phrase];
    const matchInContext = 'matchInContext' in request ? request.matchInContext : false;
    const fuzzyMatch = 'fuzzyMatch' in request ? request.fuzzyMatch : false;
    this.assertFuzzyPhrases(phrases, fuzzyMatch);
    const requestHash = this.hashMutationRequest({
      operation: 'CREATE',
      ...(contractVersion === 2 ? { contractVersion } : {}),
      chatId,
      request,
    });
    const replay = await this.findMutationReplay(user.userId, request.requestId, requestHash);
    if (replay) {
      return this.presentRule(
        await this.requireRuleById(replay.ruleId, chatId, true),
        contractVersion,
      );
    }

    if (request.enabled) {
      await this.policy.assertBotCapabilityForFeatureEnablement(
        'chat',
        chatId,
        entity.moduleSettings.autoRepliesEnabled === true
          ? ['enabled']
          : ['enabled', 'autoRepliesEnabled'],
      );
    }

    const content = await this.prepareContent(request.content);
    const primaryPhrase = phrases[0]!;
    const normalizedPhrase = normalizePublisherAutoReplyPhrase(primaryPhrase);
    let createdRuleId: string;
    try {
      createdRuleId = await this.prisma.$transaction(async (tx) => {
        await this.assertTriggerCapacity(tx, chatId, null, phrases.length, fuzzyMatch);
        const rule = await tx.publisherAutoReplyRule.create({
          data: {
            chatId,
            phrase: primaryPhrase,
            normalizedPhrase,
            matchInContext,
            fuzzyMatch,
            enabled: request.enabled,
            cooldownSeconds: request.cooldownSeconds,
            createdByUserId: user.userId,
            updatedByUserId: user.userId,
          },
          select: { id: true, version: true },
        });
        await this.replaceAdditionalTriggers(tx, rule.id, chatId, phrases, null);
        const persistedContent = await this.persistPreparedContentRevision(tx, {
          ruleId: rule.id,
          chatId,
          revision: 1,
          actorUserId: user.userId,
          content,
        });
        await tx.publisherAutoReplyRule.update({
          where: { id: rule.id },
          data: { currentContentRevisionId: persistedContent.id },
        });
        const moduleEnable = await this.enableModuleIfNeeded(
          tx,
          chatId,
          user.userId,
          request.enabled && entity.moduleSettings.autoRepliesEnabled !== true,
        );
        if (moduleEnable) {
          await this.auditModuleEnable(tx, chatId, user.userId, moduleEnable.revision);
        }
        await this.bumpAutoReplyConfigRevision(tx, chatId, user.userId);
        await tx.publisherAutoReplyMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            requestHash,
            operation: 'CREATE',
            ruleId: rule.id,
            resultingVersion: rule.version,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: 'CREATE_PUBLISHER_AUTO_REPLY',
            payload: {
              ruleId: rule.id,
              version: rule.version,
              enabled: request.enabled,
              cooldownSeconds: request.cooldownSeconds,
              ...(contractVersion === 2
                ? {
                    phrases: phrases.map((phrase) => this.auditText(phrase)),
                    matchInContext,
                    fuzzyMatch,
                  }
                : { phrase: this.auditText(primaryPhrase) }),
              content: persistedContent,
              ...(moduleEnable
                ? { autoRepliesModuleEnabled: true, moduleSettingsRevision: moduleEnable.revision }
                : {}),
            } satisfies Prisma.InputJsonValue,
          },
        });
        return rule.id;
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002')) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          request.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          return this.presentRule(
            await this.requireRuleById(concurrentReplay.ruleId, chatId, true),
            contractVersion,
          );
        }
        if (this.isPhraseConflict(error)) throw this.phraseConflict();
      }
      throw error;
    }
    return this.presentRule(await this.requireRule(chatId, createdRuleId), contractVersion);
  }

  async update(
    chatId: string,
    ruleId: string,
    user: AuthUser,
    body: unknown,
    contractVersion: AutoReplyContractVersion = 1,
  ): Promise<AutoReplyRuleResponse> {
    const parsed =
      contractVersion === 2
        ? updatePublisherAutoReplyV2RequestSchema.safeParse(body)
        : updatePublisherAutoReplyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const entity = await this.policy.getEntity('chat', chatId, user);
    const request = parsed.data;
    const requestHash = this.hashMutationRequest({
      operation: 'UPDATE',
      ...(contractVersion === 2 ? { contractVersion } : {}),
      chatId,
      ruleId,
      request,
    });
    const replay = await this.findMutationReplay(user.userId, request.requestId, requestHash);
    if (replay) {
      this.assertReplayRule(replay.ruleId, ruleId);
      return this.presentRule(await this.requireRuleById(ruleId, chatId, true), contractVersion);
    }

    const existing = await this.requireRule(chatId, ruleId);
    let requestedPhrases =
      'phrases' in request
        ? request.phrases
        : 'phrase' in request && request.phrase !== undefined
          ? [request.phrase]
          : undefined;
    if (
      contractVersion === 1 &&
      requestedPhrases &&
      (existing.matchInContext || existing.fuzzyMatch || existing.triggers.length > 1)
    ) {
      if (normalizePublisherAutoReplyPhrase(requestedPhrases[0]!) !== existing.normalizedPhrase) {
        throw this.clientUpgradeRequired();
      }
      requestedPhrases = undefined;
    }
    const fuzzyMatch =
      'fuzzyMatch' in request && request.fuzzyMatch !== undefined
        ? request.fuzzyMatch
        : existing.fuzzyMatch;
    this.assertFuzzyPhrases(
      requestedPhrases ?? existing.triggers.map((trigger) => trigger.phrase),
      fuzzyMatch,
    );
    if (
      request.enabled === true &&
      (existing.enabled !== true || entity.moduleSettings.autoRepliesEnabled !== true)
    ) {
      await this.policy.assertBotCapabilityForFeatureEnablement('chat', chatId, [
        ...(existing.enabled !== true ? ['enabled'] : []),
        ...(entity.moduleSettings.autoRepliesEnabled !== true ? ['autoRepliesEnabled'] : []),
      ]);
    }
    const content = request.content ? await this.prepareContent(request.content) : null;
    const nextVersion = request.expectedVersion + 1;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (
          requestedPhrases ||
          ('fuzzyMatch' in request && request.fuzzyMatch !== undefined) ||
          (request.enabled === true && !existing.enabled)
        ) {
          await this.assertTriggerCapacity(
            tx,
            chatId,
            ruleId,
            requestedPhrases?.length ?? Math.max(1, existing.triggers.length),
            fuzzyMatch,
            {
              phraseCount: Math.max(1, existing.triggers.length),
              fuzzyMatch: existing.fuzzyMatch,
            },
          );
        }
        const changed = await tx.publisherAutoReplyRule.updateMany({
          where: { id: ruleId, chatId, archivedAt: null, version: request.expectedVersion },
          data: {
            ...('matchInContext' in request && request.matchInContext !== undefined
              ? { matchInContext: request.matchInContext }
              : {}),
            ...('fuzzyMatch' in request && request.fuzzyMatch !== undefined
              ? { fuzzyMatch: request.fuzzyMatch }
              : {}),
            ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
            ...(request.cooldownSeconds !== undefined
              ? { cooldownSeconds: request.cooldownSeconds }
              : {}),
            updatedByUserId: user.userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw this.versionConflict();
        }
        if (requestedPhrases) {
          await this.replaceRulePhrases(tx, ruleId, chatId, requestedPhrases, null);
        }

        let persistedContent: PersistedContentSummary | null = null;
        if (content) {
          persistedContent = await this.persistPreparedContentRevision(tx, {
            ruleId,
            chatId,
            revision: existing.currentContentRevision!.revision + 1,
            actorUserId: user.userId,
            content,
          });
          await tx.publisherAutoReplyRule.update({
            where: { id: ruleId },
            data: { currentContentRevisionId: persistedContent.id },
          });
        }
        const moduleEnable = await this.enableModuleIfNeeded(
          tx,
          chatId,
          user.userId,
          request.enabled === true && entity.moduleSettings.autoRepliesEnabled !== true,
        );
        if (moduleEnable) {
          await this.auditModuleEnable(tx, chatId, user.userId, moduleEnable.revision);
        }
        if (
          requestedPhrases ||
          ('matchInContext' in request && request.matchInContext !== undefined) ||
          ('fuzzyMatch' in request && request.fuzzyMatch !== undefined) ||
          request.enabled !== undefined
        ) {
          await this.bumpAutoReplyConfigRevision(tx, chatId, user.userId);
        }
        await tx.publisherAutoReplyMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            requestHash,
            operation: 'UPDATE',
            ruleId,
            resultingVersion: nextVersion,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: 'UPDATE_PUBLISHER_AUTO_REPLY',
            payload: {
              ruleId,
              version: nextVersion,
              changed: {
                ...(requestedPhrases
                  ? contractVersion === 2
                    ? { phrases: requestedPhrases.map((phrase) => this.auditText(phrase)) }
                    : { phrase: this.auditText(requestedPhrases[0]!) }
                  : {}),
                ...('matchInContext' in request && request.matchInContext !== undefined
                  ? { matchInContext: request.matchInContext }
                  : {}),
                ...('fuzzyMatch' in request && request.fuzzyMatch !== undefined
                  ? { fuzzyMatch: request.fuzzyMatch }
                  : {}),
                ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
                ...(request.cooldownSeconds !== undefined
                  ? { cooldownSeconds: request.cooldownSeconds }
                  : {}),
                ...(persistedContent ? { content: persistedContent } : {}),
              },
              ...(moduleEnable
                ? { autoRepliesModuleEnabled: true, moduleSettingsRevision: moduleEnable.revision }
                : {}),
            } satisfies Prisma.InputJsonValue,
          },
        });
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002')) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          request.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          this.assertReplayRule(concurrentReplay.ruleId, ruleId);
          return this.presentRule(
            await this.requireRuleById(ruleId, chatId, true),
            contractVersion,
          );
        }
        if (this.isPhraseConflict(error)) throw this.phraseConflict();
      }
      throw error;
    }
    return this.presentRule(await this.requireRule(chatId, ruleId), contractVersion);
  }

  async archive(
    chatId: string,
    ruleId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ArchivePublisherAutoReplyResponse> {
    const parsed = archivePublisherAutoReplyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    await this.policy.getEntity('chat', chatId, user);
    const request = parsed.data;
    const requestHash = this.hashMutationRequest({ operation: 'ARCHIVE', chatId, ruleId, request });
    const replay = await this.findMutationReplay(user.userId, request.requestId, requestHash);
    if (replay) {
      this.assertReplayRule(replay.ruleId, ruleId);
      return this.presentArchive(await this.requireRuleById(ruleId, chatId, true));
    }

    const archivedAt = new Date();
    const nextVersion = request.expectedVersion + 1;
    try {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.publisherAutoReplyRule.updateMany({
          where: { id: ruleId, chatId, archivedAt: null, version: request.expectedVersion },
          data: {
            archivedAt,
            enabled: false,
            updatedByUserId: user.userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          const exists = await tx.publisherAutoReplyRule.findFirst({
            where: { id: ruleId, chatId },
            select: { id: true },
          });
          if (!exists) {
            throw new NotFoundException('Автоответ не найден.');
          }
          throw this.versionConflict();
        }
        await this.bumpAutoReplyConfigRevision(tx, chatId, user.userId);
        await tx.publisherAutoReplyMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            requestHash,
            operation: 'ARCHIVE',
            ruleId,
            resultingVersion: nextVersion,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: 'ARCHIVE_PUBLISHER_AUTO_REPLY',
            payload: { ruleId, version: nextVersion } satisfies Prisma.InputJsonValue,
          },
        });
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002')) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          request.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          this.assertReplayRule(concurrentReplay.ruleId, ruleId);
          return this.presentArchive(await this.requireRuleById(ruleId, chatId, true));
        }
      }
      throw error;
    }
    return archivePublisherAutoReplyResponseSchema.parse({
      id: ruleId,
      archived: true,
      version: nextVersion,
      archivedAt: archivedAt.toISOString(),
    });
  }

  async getAsset(
    chatId: string,
    ruleId: string,
    assetId: string,
    user: AuthUser,
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    await this.policy.getEntity('chat', chatId, user);
    const asset = await this.prisma.publisherAutoReplyAsset.findFirst({
      where: {
        id: assetId,
        chatId,
        contentLinks: { some: { contentRevision: { ruleId } } },
      },
      select: { bytes: true, mimeType: true },
    });
    if (!asset) {
      throw new NotFoundException('Фото автоответа не найдено.');
    }
    return { bytes: Buffer.from(asset.bytes), mimeType: asset.mimeType };
  }

  async previewMatch(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublisherAutoReplyPreviewResponse> {
    const parsed = publisherAutoReplyPreviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    await this.policy.getEntity('chat', chatId, user);
    const storedTriggers = await this.prisma.publisherAutoReplyTrigger.findMany({
      where: {
        chatId,
        archivedAt: null,
        ...(parsed.data.draft?.ruleId ? { ruleId: { not: parsed.data.draft.ruleId } } : {}),
        rule: {
          is: {
            enabled: true,
            archivedAt: null,
            currentContentRevisionId: { not: null },
          },
        },
      },
      orderBy: [{ ruleId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
      take: PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.candidates + 1,
      select: {
        id: true,
        ruleId: true,
        position: true,
        phrase: true,
        normalizedPhrase: true,
        rule: {
          select: {
            matchInContext: true,
            fuzzyMatch: true,
          },
        },
      },
    });
    const draftRuleId = AUTO_REPLY_PREVIEW_DRAFT_RULE_ID;
    const candidates: PublisherAutoReplyTriggerCandidate[] = storedTriggers.map((trigger) => ({
      ruleId: trigger.ruleId,
      triggerId: trigger.id,
      position: trigger.position,
      phrase: trigger.phrase,
      normalizedPhrase: trigger.normalizedPhrase,
      matchInContext: trigger.rule.matchInContext,
      fuzzyMatch: trigger.rule.fuzzyMatch,
    }));
    if (parsed.data.draft) {
      this.assertFuzzyPhrases(parsed.data.draft.phrases, parsed.data.draft.fuzzyMatch);
    }
    if (parsed.data.draft?.enabled) {
      candidates.push(
        ...parsed.data.draft.phrases.map((phrase, position) => ({
          ruleId: draftRuleId,
          triggerId: `${draftRuleId}:${position}`,
          position,
          phrase,
          normalizedPhrase: normalizePublisherAutoReplyPhrase(phrase),
          matchInContext: parsed.data.draft!.matchInContext,
          fuzzyMatch: parsed.data.draft!.fuzzyMatch,
        })),
      );
    }
    const enforcedCandidates = this.enforceMatchingMode(candidates);
    let match = matchPublisherAutoReply(parsed.data.message, enforcedCandidates);
    if (match.kind === 'no_match' && match.reason === 'budget_exceeded') {
      match = await this.previewExactFallback(chatId, parsed.data, enforcedCandidates);
    }
    if (match.kind !== 'matched') {
      return publisherAutoReplyPreviewResponseSchema.parse({
        outcome: match.kind === 'ambiguous' ? 'ambiguous' : 'no_match',
        selected: null,
      });
    }
    return publisherAutoReplyPreviewResponseSchema.parse({
      outcome: 'matched',
      selected: {
        ruleId: match.winner.ruleId === draftRuleId ? null : match.winner.ruleId,
        phrase: match.winner.phrase,
        matchKind: match.winner.matchKind,
        distance: match.winner.distance,
        matchedDraft: match.winner.ruleId === draftRuleId,
      },
    });
  }

  private enforceMatchingMode(
    candidates: readonly PublisherAutoReplyTriggerCandidate[],
  ): PublisherAutoReplyTriggerCandidate[] {
    return this.extendedMatchingMode === 'on'
      ? [...candidates]
      : candidates.map((candidate) => ({
          ...candidate,
          matchInContext: false,
          fuzzyMatch: false,
        }));
  }

  private async previewExactFallback(
    chatId: string,
    request: ReturnType<typeof publisherAutoReplyPreviewRequestSchema.parse>,
    candidates: readonly PublisherAutoReplyTriggerCandidate[],
  ) {
    const normalizedMessage = normalizePublisherAutoReplyPhrase(request.message);
    const stored = await this.prisma.publisherAutoReplyTrigger.findFirst({
      where: {
        chatId,
        normalizedPhrase: normalizedMessage,
        archivedAt: null,
        ...(request.draft?.ruleId ? { ruleId: { not: request.draft.ruleId } } : {}),
        rule: {
          is: {
            enabled: true,
            archivedAt: null,
            currentContentRevisionId: { not: null },
          },
        },
      },
      select: {
        id: true,
        ruleId: true,
        position: true,
        phrase: true,
        normalizedPhrase: true,
        rule: { select: { matchInContext: true, fuzzyMatch: true } },
      },
    });
    const exactCandidates = candidates.filter(
      (candidate) =>
        candidate.ruleId === AUTO_REPLY_PREVIEW_DRAFT_RULE_ID &&
        candidate.normalizedPhrase === normalizedMessage,
    );
    if (stored) {
      exactCandidates.push({
        ruleId: stored.ruleId,
        triggerId: stored.id,
        position: stored.position,
        phrase: stored.phrase,
        normalizedPhrase: stored.normalizedPhrase,
        matchInContext: false,
        fuzzyMatch: false,
      });
    }
    return matchPublisherAutoReply(request.message, exactCandidates);
  }

  /** Persists an archived bot-authoring draft after the caller has fenced its authoring session. */
  async createFromPreparedContent(
    params: CreatePublisherAutoReplyFromPreparedContentParams,
  ): Promise<{ ruleId: string; contentRevisionId: string; version: number }> {
    const requestId = publisherAutoReplyRequestIdSchema.parse(params.requestId);
    const phrases = publisherAutoReplyPhrasesSchema.parse(params.phrases ?? [params.phrase]);
    const phrase = phrases[0]!;
    const normalizedPhrase = normalizePublisherAutoReplyPhrase(phrase);
    if (params.normalizedPhrase !== normalizedPhrase) {
      throw new BadRequestException('Нормализованная кодовая фраза не совпадает с исходной.');
    }
    if (!params.chatId.trim() || !params.actorUserId.trim() || !params.sessionId.trim()) {
      throw new BadRequestException('Сценарий создания автоответа повреждён.');
    }
    this.assertFuzzyPhrases(phrases, params.fuzzyMatch ?? false);
    this.assertPreparedContent(params.content);
    const requestHash = this.hashMutationRequest({
      operation: 'CREATE_DRAFT',
      chatId: params.chatId,
      sessionId: params.sessionId,
      phrases,
      normalizedPhrase,
      matchInContext: params.matchInContext ?? false,
      fuzzyMatch: params.fuzzyMatch ?? false,
      content: this.preparedContentFingerprint(params.content),
    });
    const replay = await this.findMutationReplay(params.actorUserId, requestId, requestHash);
    if (replay) {
      const rule = await this.requireRuleById(replay.ruleId, params.chatId, true);
      return {
        ruleId: rule.id,
        contentRevisionId: rule.currentContentRevision!.id,
        version: rule.version,
      };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const archivedAt = new Date();
        const rule = await tx.publisherAutoReplyRule.create({
          data: {
            chatId: params.chatId,
            phrase,
            normalizedPhrase,
            matchInContext: params.matchInContext ?? false,
            fuzzyMatch: params.fuzzyMatch ?? false,
            enabled: false,
            archivedAt,
            authoringSessionId: params.sessionId,
            createdByUserId: params.actorUserId,
            updatedByUserId: params.actorUserId,
          },
          select: { id: true, version: true },
        });
        await this.replaceAdditionalTriggers(tx, rule.id, params.chatId, phrases, archivedAt);
        const persistedContent = await this.persistPreparedContentRevision(tx, {
          ruleId: rule.id,
          chatId: params.chatId,
          revision: 1,
          actorUserId: params.actorUserId,
          content: params.content,
        });
        await tx.publisherAutoReplyRule.update({
          where: { id: rule.id },
          data: { currentContentRevisionId: persistedContent.id },
        });
        await tx.publisherAutoReplyMutationRecord.create({
          data: {
            actorUserId: params.actorUserId,
            requestId,
            requestHash,
            operation: 'CREATE',
            ruleId: rule.id,
            resultingVersion: rule.version,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: params.chatId,
            actorUserId: params.actorUserId,
            action: 'CREATE_PUBLISHER_AUTO_REPLY_DRAFT',
            payload: {
              ruleId: rule.id,
              sessionId: params.sessionId,
              version: rule.version,
              phrases: phrases.map((item) => this.auditText(item)),
              matchInContext: params.matchInContext ?? false,
              fuzzyMatch: params.fuzzyMatch ?? false,
              content: persistedContent,
            } satisfies Prisma.InputJsonValue,
          },
        });
        return {
          ruleId: rule.id,
          contentRevisionId: persistedContent.id,
          version: rule.version,
        };
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002')) {
        const concurrentReplay = await this.findMutationReplay(
          params.actorUserId,
          requestId,
          requestHash,
        );
        if (concurrentReplay) {
          const rule = await this.requireRuleById(concurrentReplay.ruleId, params.chatId, true);
          return {
            ruleId: rule.id,
            contentRevisionId: rule.currentContentRevision!.id,
            version: rule.version,
          };
        }
      }
      throw error;
    }
  }

  async prepareContent(
    content: PublisherAutoReplyContentInput,
  ): Promise<PreparedPublisherAutoReplyContent> {
    const images: PreparedPublisherAutoReplyImage[] = [];
    let totalBytes = 0;
    for (const image of content.images) {
      if (image.type === 'image-ref') {
        images.push({ kind: 'reference', assetId: image.assetId });
        continue;
      }
      const bytes = this.decodeImageBase64(image.base64);
      if (bytes.length > PUBLICATION_MAX_IMAGE_BYTES) {
        throw new BadRequestException('Фото слишком большое. Максимум 8 МБ.');
      }
      const validated = await this.validateImage(bytes);
      totalBytes += bytes.length;
      images.push({
        kind: 'prepared',
        sha256: this.sha256(bytes),
        mimeType: validated.mimeType,
        fileName: canonicalizeAdminMaxMediaFileName(
          image.fileName,
          validated.extension,
          'auto-reply-image',
        ),
        sizeBytes: bytes.length,
        bytes,
      });
    }
    if (totalBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }
    return {
      text: content.text,
      textFormat: content.textFormat,
      images,
      buttons: content.buttons,
    };
  }

  async persistPreparedContentRevision(
    tx: Prisma.TransactionClient,
    params: PersistPublisherAutoReplyContentParams,
  ): Promise<PersistedContentSummary> {
    const contentRevision = await tx.publisherAutoReplyContentRevision.create({
      data: {
        ruleId: params.ruleId,
        revision: params.revision,
        text: params.content.text,
        textFormat:
          params.content.textFormat === 'markdown'
            ? PublicationContentFormat.MARKDOWN
            : PublicationContentFormat.PLAIN,
        buttons: params.content.buttons as Prisma.InputJsonValue,
        createdByUserId: params.actorUserId,
      },
      select: { id: true },
    });
    const linkedAssetIds = new Set<string>();
    let totalBytes = 0;
    const images: PersistedContentSummary['images'] = [];
    for (const [position, image] of params.content.images.entries()) {
      let asset: {
        id: string;
        sha256: string;
        mimeType: string;
        sizeBytes: number;
      };
      if (image.kind === 'reference') {
        const retained = await tx.publisherAutoReplyAsset.findFirst({
          where: { id: image.assetId, chatId: params.chatId },
          select: { id: true, sha256: true, mimeType: true, sizeBytes: true },
        });
        if (!retained) {
          throw new BadRequestException('Сохранённое фото автоответа больше недоступно.');
        }
        asset = retained;
      } else {
        asset = await tx.publisherAutoReplyAsset.upsert({
          where: { chatId_sha256: { chatId: params.chatId, sha256: image.sha256 } },
          create: {
            chatId: params.chatId,
            sha256: image.sha256,
            mimeType: image.mimeType,
            fileName: image.fileName,
            sizeBytes: image.sizeBytes,
            bytes: Uint8Array.from(image.bytes),
            createdByUserId: params.actorUserId,
          },
          update: {},
          select: { id: true, sha256: true, mimeType: true, sizeBytes: true },
        });
      }
      if (linkedAssetIds.has(asset.id)) {
        throw new BadRequestException('Одно и то же фото добавлено несколько раз.');
      }
      linkedAssetIds.add(asset.id);
      totalBytes += asset.sizeBytes;
      if (totalBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
        throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
      }
      await tx.publisherAutoReplyContentAsset.create({
        data: { contentRevisionId: contentRevision.id, assetId: asset.id, position },
      });
      images.push({ position, assetId: asset.id, ...asset });
    }
    return {
      id: contentRevision.id,
      revision: params.revision,
      textLength: params.content.text.length,
      textSha256: this.sha256(params.content.text),
      textFormat: params.content.textFormat,
      buttonCount: params.content.buttons.length,
      images,
    };
  }

  async assertTriggerActivationCapacity(
    tx: Prisma.TransactionClient,
    params: { chatId: string; ruleId: string; phraseCount: number; fuzzyMatch: boolean },
  ): Promise<void> {
    await this.assertTriggerCapacity(
      tx,
      params.chatId,
      params.ruleId,
      params.phraseCount,
      params.fuzzyMatch,
    );
  }

  private async requireRule(chatId: string, ruleId: string): Promise<AutoReplyRuleRow> {
    return this.requireRuleById(ruleId, chatId, false);
  }

  private async requireRuleById(
    ruleId: string,
    chatId: string,
    includeArchived: boolean,
  ): Promise<AutoReplyRuleRow> {
    const rule = await this.prisma.publisherAutoReplyRule.findFirst({
      where: { id: ruleId, chatId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: AUTO_REPLY_RULE_INCLUDE,
    });
    if (!rule || !rule.currentContentRevision) {
      throw new NotFoundException('Автоответ не найден.');
    }
    return rule;
  }

  private presentRule(
    rule: AutoReplyRuleRow,
    contractVersion: AutoReplyContractVersion = 1,
  ): AutoReplyRuleResponse {
    const content = rule.currentContentRevision;
    if (!content) {
      throw new NotFoundException('Контент автоответа не найден.');
    }
    const common = {
      id: rule.id,
      chatId: rule.chatId,
      enabled: rule.enabled,
      cooldownSeconds: rule.cooldownSeconds,
      version: rule.version,
      currentContentRevisionId: content.id,
      content: {
        id: content.id,
        revision: content.revision,
        text: content.text,
        textFormat: content.textFormat === PublicationContentFormat.MARKDOWN ? 'markdown' : 'plain',
        images: content.assets.map(({ asset }) => ({
          id: asset.id,
          mimeType: asset.mimeType,
          fileName: asset.fileName,
          sizeBytes: asset.sizeBytes,
          previewUrl: this.assetPreviewUrl(rule.chatId, rule.id, asset.id),
        })),
        buttons: readStoredPublicationButtons(content.buttons),
        createdAt: content.createdAt.toISOString(),
      },
      createdByUserId: rule.createdByUserId,
      updatedByUserId: rule.updatedByUserId,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
      archivedAt: rule.archivedAt?.toISOString() ?? null,
    };
    if (contractVersion === 2) {
      return publisherAutoReplyRuleV2Schema.parse({
        ...common,
        phrases:
          rule.triggers.length > 0 ? rule.triggers.map((trigger) => trigger.phrase) : [rule.phrase],
        matchInContext: rule.matchInContext,
        fuzzyMatch: rule.fuzzyMatch,
      });
    }
    return publisherAutoReplyRuleSchema.parse({ ...common, phrase: rule.phrase });
  }

  private presentArchive(rule: AutoReplyRuleRow): ArchivePublisherAutoReplyResponse {
    if (!rule.archivedAt) {
      throw this.versionConflict();
    }
    return archivePublisherAutoReplyResponseSchema.parse({
      id: rule.id,
      archived: true,
      version: rule.version,
      archivedAt: rule.archivedAt.toISOString(),
    });
  }

  private assetPreviewUrl(chatId: string, ruleId: string, assetId: string): string {
    return `/api/v1/publisher/entities/chat/${encodeURIComponent(chatId)}/auto-replies/${encodeURIComponent(ruleId)}/assets/${encodeURIComponent(assetId)}`;
  }

  private async findMutationReplay(actorUserId: string, requestId: string, requestHash: string) {
    const record = await this.prisma.publisherAutoReplyMutationRecord.findUnique({
      where: { actorUserId_requestId: { actorUserId, requestId } },
      select: { ruleId: true, requestHash: true },
    });
    if (!record) {
      return null;
    }
    if (record.requestHash !== requestHash) {
      throw new BadRequestException('Ключ повтора уже использован для другого изменения.');
    }
    return record;
  }

  private async enableModuleIfNeeded(
    tx: Prisma.TransactionClient,
    chatId: string,
    actorUserId: string,
    shouldEnable: boolean,
  ): Promise<{ revision: number } | null> {
    if (!shouldEnable) {
      return null;
    }
    return tx.publisherEntitySettings.upsert({
      where: { chatId },
      create: { chatId, autoRepliesEnabled: true, updatedByUserId: actorUserId },
      update: {
        autoRepliesEnabled: true,
        revision: { increment: 1 },
        updatedByUserId: actorUserId,
      },
      select: { revision: true },
    });
  }

  private async bumpAutoReplyConfigRevision(
    tx: Prisma.TransactionClient,
    chatId: string,
    actorUserId: string,
  ): Promise<number> {
    const settings = await tx.publisherEntitySettings.upsert({
      where: { chatId },
      create: {
        chatId,
        autoReplyConfigRevision: 1,
        updatedByUserId: actorUserId,
      },
      update: {
        autoReplyConfigRevision: { increment: 1 },
        updatedByUserId: actorUserId,
      },
      select: { autoReplyConfigRevision: true },
    });
    return settings.autoReplyConfigRevision;
  }

  private async assertTriggerCapacity(
    tx: Prisma.TransactionClient,
    chatId: string,
    excludedRuleId: string | null,
    nextPhraseCount: number,
    nextFuzzyMatch: boolean,
    current?: { phraseCount: number; fuzzyMatch: boolean },
  ): Promise<void> {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext(${`publisher-auto-reply-config:${chatId}`}))
    `);
    const exclusion = excludedRuleId ? { ruleId: { not: excludedRuleId } } : {};
    const [otherPhrases, otherFuzzyPhrases] = await Promise.all([
      tx.publisherAutoReplyTrigger.count({
        where: { chatId, archivedAt: null, ...exclusion },
      }),
      tx.publisherAutoReplyTrigger.count({
        where: {
          chatId,
          archivedAt: null,
          ...exclusion,
          rule: { is: { fuzzyMatch: true } },
        },
      }),
    ]);
    const currentPhraseCount = current?.phraseCount ?? 0;
    const currentFuzzyPhraseCount = current?.fuzzyMatch ? currentPhraseCount : 0;
    const nextFuzzyPhraseCount = nextFuzzyMatch ? nextPhraseCount : 0;
    const isHealingUpdate =
      current !== undefined &&
      (nextPhraseCount < currentPhraseCount || nextFuzzyPhraseCount < currentFuzzyPhraseCount);
    const doesNotWorsenTotal = isHealingUpdate && nextPhraseCount <= currentPhraseCount;
    const doesNotWorsenFuzzy = isHealingUpdate && nextFuzzyPhraseCount <= currentFuzzyPhraseCount;
    if (
      otherPhrases + nextPhraseCount > PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.candidates &&
      !doesNotWorsenTotal
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PUBLISHER_AUTO_REPLY_TRIGGER_LIMIT',
        message: 'В чате достигнут лимит фраз автоответов.',
      });
    }
    if (
      otherFuzzyPhrases + nextFuzzyPhraseCount >
        PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.fuzzyCandidates &&
      !doesNotWorsenFuzzy
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PUBLISHER_AUTO_REPLY_FUZZY_TRIGGER_LIMIT',
        message: 'В чате достигнут лимит фраз с учётом опечаток.',
      });
    }
  }

  private async replaceAdditionalTriggers(
    tx: Prisma.TransactionClient,
    ruleId: string,
    chatId: string,
    phrases: readonly string[],
    archivedAt: Date | null,
  ): Promise<void> {
    if (phrases.length <= 1) return;
    await tx.publisherAutoReplyTrigger.createMany({
      data: phrases.slice(1).map((phrase, index) => ({
        ruleId,
        chatId,
        position: index + 1,
        phrase,
        normalizedPhrase: normalizePublisherAutoReplyPhrase(phrase),
        archivedAt,
      })),
    });
  }

  private async replaceRulePhrases(
    tx: Prisma.TransactionClient,
    ruleId: string,
    chatId: string,
    phrases: readonly string[],
    archivedAt: Date | null,
  ): Promise<void> {
    await tx.publisherAutoReplyTrigger.deleteMany({
      where: { ruleId, position: { gt: 0 } },
    });
    const primary = phrases[0]!;
    await tx.publisherAutoReplyRule.update({
      where: { id: ruleId },
      data: {
        phrase: primary,
        normalizedPhrase: normalizePublisherAutoReplyPhrase(primary),
      },
    });
    await this.replaceAdditionalTriggers(tx, ruleId, chatId, phrases, archivedAt);
  }

  private assertFuzzyPhrases(phrases: readonly string[], fuzzyMatch: boolean): void {
    if (!fuzzyMatch) return;
    const invalid = phrases.find((phrase) => {
      const characters = normalizePublisherAutoReplyPhrase(phrase).match(/[\p{L}\p{M}\p{N}]/gu);
      return (characters?.length ?? 0) < 5;
    });
    if (!invalid) return;
    throw new BadRequestException({
      statusCode: 400,
      code: 'PUBLISHER_AUTO_REPLY_FUZZY_PHRASE_TOO_SHORT',
      message: 'Для учёта опечаток каждая фраза должна содержать не меньше 5 символов.',
    });
  }

  private async auditModuleEnable(
    tx: Prisma.TransactionClient,
    chatId: string,
    actorUserId: string,
    revision: number,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action: 'UPDATE_PUBLISHER_MODULE_SETTINGS',
        payload: {
          changed: { autoRepliesEnabled: true },
          revision,
          source: 'publisher_auto_reply_rule',
        } satisfies Prisma.InputJsonValue,
      },
    });
  }

  private assertReplayRule(actualRuleId: string, expectedRuleId: string): void {
    if (actualRuleId !== expectedRuleId) {
      throw new BadRequestException('Ключ повтора относится к другому автоответу.');
    }
  }

  private phraseConflict(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT',
      message: 'Автоответ с такой кодовой фразой уже существует.',
    });
  }

  private clientUpgradeRequired(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED',
      message: 'Обновите мини-приложение, чтобы изменить расширенное правило.',
    });
  }

  private isPhraseConflict(error: unknown): boolean {
    if (!isPrismaKnownError(error, 'P2002')) return false;
    const metadata = JSON.stringify((error as { meta?: unknown }).meta ?? '').toLowerCase();
    return (
      metadata.includes('publisher_auto_reply_rules_active_phrase_key') ||
      metadata.includes('publisher_auto_reply_triggers_active_phrase_key') ||
      metadata.includes('publisher_auto_reply_triggers_rule_normalized_phrase_key') ||
      (metadata.includes('chat_id') && metadata.includes('normalized_phrase'))
    );
  }

  private versionConflict(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'PUBLISHER_AUTO_REPLY_VERSION_CONFLICT',
      message: 'Автоответ изменился. Обновите данные и повторите действие.',
    });
  }

  private decodeImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
      throw new BadRequestException('Фото повреждено. Добавьте файл заново.');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('Фото пустое.');
    }
    return bytes;
  }

  private async validateImage(bytes: Buffer) {
    try {
      return await this.maxClient.validateMediaUploadPayload('image', bytes);
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw new BadRequestException(error.publicMessage);
      }
      throw error;
    }
  }

  private assertPreparedContent(content: PreparedPublisherAutoReplyContent): void {
    if (content.text.length > MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH) {
      throw new BadRequestException('Текст автоответа слишком длинный.');
    }
    if (content.text.trim().length === 0 && content.images.length === 0) {
      throw new BadRequestException('Введите текст или добавьте фото.');
    }
    if (content.images.length > MAX_PUBLISHER_AUTO_REPLY_IMAGES) {
      throw new BadRequestException('Можно добавить не больше 10 фото.');
    }
    if (
      !publisherAutoReplyButtonSchema
        .array()
        .max(MAX_PUBLISHER_AUTO_REPLY_BUTTONS)
        .safeParse(content.buttons).success
    ) {
      throw new BadRequestException('Кнопки автоответа повреждены.');
    }
    let totalBytes = 0;
    for (const image of content.images) {
      if (image.kind === 'reference') {
        if (!image.assetId.trim()) {
          throw new BadRequestException('Ссылка на сохранённое фото повреждена.');
        }
        continue;
      }
      if (
        image.bytes.length === 0 ||
        image.bytes.length !== image.sizeBytes ||
        image.sizeBytes > PUBLICATION_MAX_IMAGE_BYTES ||
        !image.mimeType.toLowerCase().startsWith('image/') ||
        image.sha256 !== this.sha256(image.bytes)
      ) {
        throw new BadRequestException('Подготовленное фото автоответа повреждено.');
      }
      totalBytes += image.sizeBytes;
    }
    if (totalBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }
  }

  private preparedContentFingerprint(content: PreparedPublisherAutoReplyContent) {
    return {
      text: content.text,
      textFormat: content.textFormat,
      buttons: content.buttons,
      images: content.images.map((image) =>
        image.kind === 'reference'
          ? { kind: image.kind, assetId: image.assetId }
          : {
              kind: image.kind,
              sha256: image.sha256,
              mimeType: image.mimeType,
              fileName: image.fileName,
              sizeBytes: image.sizeBytes,
            },
      ),
    };
  }

  private auditText(value: string): { length: number; sha256: string } {
    return { length: value.length, sha256: this.sha256(value) };
  }

  private sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private hashMutationRequest(value: unknown): string {
    return this.sha256(this.stableStringify(value));
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }
}
