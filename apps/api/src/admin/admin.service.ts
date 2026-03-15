import {
  applySectionToAllRequestSchema,
  applySectionToAllResponseSchema,
  addDomainRequestSchema,
  addAdminRequestSchema,
  stickerLabShareRequestSchema,
  stickerLabShareResponseSchema,
  chatSettingsScreenResponseSchema,
  chatRulesSchema,
  channelSettingsScreenResponseSchema,
  channelStatsQuerySchema,
  channelStatsResponseSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  channelSettingsSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  dateRangeQuerySchema,
  logsDashboardQuerySchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  publishChatRulesResultSchema,
  type ChannelDialogType,
  type ChannelStatsBucket,
  type ChannelStatsRange,
  type ChannelStatsResponse,
  type ChannelOverview,
  type ApplySectionToAllResponse,
  type ManagedBroadcastDetails,
  managedBroadcastDetailsSchema,
  type ManagedBroadcastSummary,
  managedBroadcastSummarySchema,
  type ChannelSettings,
  type ChatSettingsScreenResponse,
  type ChatRules,
  type ChatSettings,
  chatSettingsSchema,
  type ChannelSettingsScreenResponse,
  type DomainAllowlistEntry,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedEntityType,
  type ManualModerationActionResult,
  type Me,
  type ModerationEvent,
  type StickerLabShareResponse,
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  type UpdateChatRulesRequest,
  updateChatRulesRequestSchema,
  type PublishChatRulesResult,
  type BroadcastTextFormat,
  type SendBroadcastRequest,
  type SendBroadcastResult,
  type ChatSummary,
  type ManagedEntityHeader,
  managedPollSchema,
  updateManagedPollRequestSchema,
  type ManagedPoll,
  normalizeAllowlistLink,
  sendBroadcastRequestSchema,
  scheduleDomainRemovalRequestSchema,
} from '@maxim/contracts';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus as PrismaManagedBroadcastDeliveryStatus,
  EventType,
  ManagedBroadcastStatus as PrismaManagedBroadcastStatus,
  ManagedPollStatus as PrismaManagedPollStatus,
  Operator,
  Prisma,
  SanctionAction,
  type ManagedBroadcast as PersistedManagedBroadcast,
  type ManagedBroadcastDelivery as PersistedManagedBroadcastDelivery,
  type ChatRules as PersistedChatRules,
  type ManagedPoll as PersistedManagedPoll,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import {
  ChatContextCacheService,
  type ChatAdminAccessState,
} from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MaxClientService,
  type MaxMessageButton,
  type MaxPublishedMessage,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionSummaries,
  normalizeManagedPollDraft,
  validateManagedPollForPublish,
} from '../common/managed-poll.util';
import {
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from '../common/max-markdown.util';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';

type ApplySettingsToAllChatsResult = {
  sourceChatId: string;
  updatedChats: number;
  appliedChatIds: string[];
};

type ManagedEntityTypeFilter = ManagedEntityType | 'all';

type AdminAccessResolution =
  | {
      status: 'granted';
      source: 'cache' | 'remote' | 'allowlist_fallback';
    }
  | {
      status: 'denied';
      source: 'cache' | 'remote';
      reason: 'user_not_admin' | 'bot_not_admin';
    }
  | {
      status: 'unknown';
      error: unknown;
    };

export type AdminActionSource = 'miniapp' | 'private_bot';

type PreparedManagedBroadcastRequest = {
  payload: SendBroadcastRequest;
  targetChatIds: string[];
  normalizedSourceText: string;
};

type BroadcastOccurrenceResult = {
  status: PrismaManagedBroadcastStatus;
  currentOccurrence: number;
  sentChatIds: string[];
  failedChatIds: string[];
  pendingChatIds: string[];
  canRetry: boolean;
  firstSendError: unknown;
  nextSendAt: Date | null;
};

type ManagedBroadcastDeliverySnapshot = {
  currentOccurrence: number;
  deliveredChats: number;
  failedChats: number;
  pendingChats: number;
  canRetry: boolean;
};

type StickerLabDeliveryMode = 'sticker' | 'image_variant' | 'image_fallback';
type StickerLabDeliveryAttempt = {
  name: string;
  deliveryMode: StickerLabDeliveryMode;
  attachments: Record<string, unknown>[];
};
type StickerLabFailedAttempt = {
  attempt: number;
  name: string;
  attachmentType: string;
  error: string;
};
type StickerLabDeliveryResult = {
  sent: MaxPublishedMessage;
  deliveryMode: StickerLabDeliveryMode;
  attemptNumber: number;
  attemptName: string;
  failedAttempts: StickerLabFailedAttempt[];
};
type StickerLabUploadCandidate = {
  name: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
};

const RULES_IMAGE_MAX_BYTES = 1_000_000;
const BROADCAST_IMAGE_MAX_BYTES = 3_000_000;
const BROADCAST_MIN_DELAY_MS = 30_000;
const BROADCAST_MAX_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const BROADCAST_CYCLE_MAX_COUNT = 100;
const BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const STICKER_LAB_CANVAS_SIZE = 512;
const STICKER_LAB_TARGET_BYTES = 1_000_000;
const STICKER_LAB_QUALITY_LEVELS = [92, 84, 76, 68] as const;
const MANAGED_BROADCAST_DUE_BATCH_SIZE = 10;
const MANAGED_BROADCAST_LOCK_STALE_MS = 60_000;
const LOGS_DASHBOARD_VIOLATIONS_LIMIT = 30;
const ONE_HOUR_MS = 60 * 60 * 1000;
const LIST_CHATS_ADMIN_CHECK_CONCURRENCY = 5;
const CHANNEL_DIALOG_MESSAGES_LIMIT = 80;
const CHANNEL_DIALOG_ACTION_COMMENT = 'CHANNEL_DIALOG_COMMENT';
const CHANNEL_DIALOG_ACTION_SUGGEST = 'CHANNEL_DIALOG_SUGGESTION';
const CHANNEL_DIALOG_ACTION_PUBLISH = 'PUBLISH_CHANNEL_ENGAGEMENT';
const CHANNEL_DIALOG_ACTION_AUTO_ATTACH = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT';
const MANAGED_POLL_ACTION_UPDATE = 'UPDATE_MANAGED_POLL';
const MANAGED_POLL_ACTION_PUBLISH = 'PUBLISH_MANAGED_POLL';
const MANAGED_POLL_ACTION_CLOSE = 'CLOSE_MANAGED_POLL';
const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const CHANNEL_DIALOG_TOKEN_PREFIX = 'cdt-';
const DEFAULT_CHANNEL_SETTINGS = channelSettingsSchema.parse({});
const SETTINGS_SECTION_KEYS = {
  links: [
    'linkPolicy',
    'linkBotMessageEnabled',
    'linkBotMessageText',
    'linkWarnEnabled',
    'linkWarnMessageText',
    'linkBanEnabled',
    'linkKickEnabled',
    'linkBotButtonEnabled',
    'linkBotButtonUrl',
    'linkBotButtonText',
  ],
  greeting: [
    'greetingEnabled',
    'greetingBotMessageEnabled',
    'greetingBotMessageText',
    'greetingBotButtonEnabled',
    'greetingBotButtonUrl',
    'greetingBotButtonText',
  ],
  profanityFilter: [
    'russianProfanityFilterEnabled',
    'profanityBotMessageEnabled',
    'profanityWarnEnabled',
    'profanityBanEnabled',
    'profanityKickEnabled',
  ],
  commercialFilter: [
    'commercialAdsFilterEnabled',
    'commercialAdsSensitivity',
    'commercialAdsWarnThreshold',
    'commercialAdsDeleteThreshold',
    'textFiltersBotMessageEnabled',
    'textFiltersBotMessageText',
    'textFiltersWarnEnabled',
    'textFiltersWarnMessageText',
    'textFiltersBanEnabled',
    'textFiltersKickEnabled',
    'textFiltersBotButtonEnabled',
    'textFiltersBotButtonUrl',
    'textFiltersBotButtonText',
  ],
  thematicFilters: [
    'thematicCodewordEnabled',
    'thematicCodeword',
    'thematicFiltersBotMessageEnabled',
    'thematicFiltersWarnEnabled',
    'thematicFiltersBanEnabled',
    'thematicFiltersKickEnabled',
    'thematicFiltersBotButtonEnabled',
    'thematicFiltersBotButtonUrl',
    'thematicFiltersBotButtonText',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateWarnEnabled',
    'duplicateKickEnabled',
    'duplicateBanEnabled',
    'duplicateWarnWindowSec',
    'duplicateWarnMaxCount',
    'duplicateKickWindowSec',
    'duplicateKickMaxCount',
    'duplicateBanWindowSec',
    'duplicateBanMaxCount',
    'duplicateBotMessageEnabled',
    'duplicateBotMessageText',
    'duplicateBotButtonEnabled',
    'duplicateBotButtonUrl',
    'duplicateBotButtonText',
    'banDurationHours',
  ],
  limits: [
    'antiSpamEnabled',
    'maxMessageLengthEnabled',
    'maxMessageLength',
    'photoMessageCooldownEnabled',
    'photoMessageCooldownHours',
    'stickerMessageCooldownEnabled',
    'stickerMessageCooldownMinutes',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsBanEnabled',
    'messageLimitsKickEnabled',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
    'banDurationHours',
  ],
  night: [
    'nightModeEnabled',
    'nightModeStartTimeMinutes',
    'nightModeEndTimeMinutes',
    'nightModeTimezone',
    'nightModeBotMessageEnabled',
    'nightModeBotMessageText',
    'nightModeBotButtonEnabled',
    'nightModeBotButtonUrl',
    'nightModeBotButtonText',
  ],
  extra: [
    'deleteSpammersEnabled',
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
} as const satisfies Record<string, readonly (keyof ChatSettings)[]>;
const CHANNEL_STATS_POST_ACTIONS = [
  CHANNEL_DIALOG_ACTION_PUBLISH,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
] as const;
const CHANNEL_STATS_ACTIVITY_ACTIONS = [
  ...CHANNEL_STATS_POST_ACTIONS,
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
] as const;
const CHANNEL_STATS_MISSING_METRICS = ['reach', 'uniqueViews'] as const;
const CHANNEL_STATS_REFRESH_STALE_MS = 2 * 60 * 60 * 1000;
const CHANNEL_COMMENT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const CHANNEL_COMMENT_MAX_CONSECUTIVE = 2;
const CHANNEL_COMMENT_LINK_PATTERN = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/giu;
type ChannelDialogTokenPayload = {
  v: 1;
  d: string;
  s: string;
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly maxBotToken: string;
  private readonly adminAccessChecks = new Map<string, Promise<AdminAccessResolution>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    configService: ConfigService,
    @Optional()
    private readonly channelStatsCollector?: ChannelStatsCollectorService,
  ) {
    this.maxBotToken = configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
  }

  getMe(user: AuthUser): Me {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
    };
  }

  async shareStickerLabAsset(user: AuthUser, body: unknown): Promise<StickerLabShareResponse> {
    const parsed = stickerLabShareRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const imageMimeType = parsed.data.imageMimeType.trim().toLowerCase();
    if (!imageMimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }
    const deliveryType = parsed.data.deliveryType;

    const privateChatId = await this.resolvePrivateDialogChatId(user);
    if (!privateChatId) {
      throw new BadRequestException(
        'Сначала откройте личный чат с ботом и отправьте туда любое сообщение.',
      );
    }

    const imageBuffer = this.decodeBroadcastImageBase64(parsed.data.imageBase64);
    if (imageBuffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Изображение слишком большое. Выберите другое фото.');
    }

    const normalizedImageFileName = this.resolveBroadcastImageFileName(
      parsed.data.imageFileName,
      imageMimeType,
    );
    const uploadCandidates = await this.buildStickerLabUploadCandidates(
      imageBuffer,
      normalizedImageFileName,
      imageMimeType,
    );
    this.logger.log(
      {
        userId: user.userId,
        privateChatId,
        deliveryType,
        sourceMimeType: imageMimeType,
        sourceFileName: normalizedImageFileName,
        sourceBytes: imageBuffer.length,
        uploadCandidates: uploadCandidates.map((candidate) => ({
          name: candidate.name,
          mimeType: candidate.mimeType,
          fileName: candidate.fileName,
          bytes: candidate.buffer.length,
        })),
      },
      'Sticker lab share request received',
    );

    if (deliveryType === 'file') {
      const failedCandidateAttempts: Array<{
        candidateName: string;
        stage: 'upload' | 'send';
        maxApiMessage: string | null;
        error: string;
      }> = [];
      let lastMaxApiMessage = '';

      for (const [candidateIndex, candidate] of uploadCandidates.entries()) {
        let uploadPayload: Record<string, unknown>;
        try {
          uploadPayload = await this.maxClient.uploadFile(
            candidate.buffer,
            candidate.fileName,
            candidate.mimeType,
          );
          this.logger.log(
            {
              userId: user.userId,
              privateChatId,
              candidateIndex: candidateIndex + 1,
              candidateName: candidate.name,
              candidateMimeType: candidate.mimeType,
              candidateFileName: candidate.fileName,
              candidateBytes: candidate.buffer.length,
              uploadPayloadKeys: Object.keys(uploadPayload).sort(),
              uploadHasUrl: typeof uploadPayload.url === 'string',
              uploadHasToken: typeof uploadPayload.token === 'string',
            },
            'Sticker lab asset uploaded to MAX',
          );
        } catch (error: unknown) {
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          if (maxApiMessage) {
            lastMaxApiMessage = maxApiMessage;
          }
          failedCandidateAttempts.push({
            candidateName: candidate.name,
            stage: 'upload',
            maxApiMessage: maxApiMessage || null,
            error: error instanceof Error ? error.message : String(error),
          });
          this.logger.warn(
            {
              userId: user.userId,
              privateChatId,
              candidateIndex: candidateIndex + 1,
              candidateName: candidate.name,
              candidateMimeType: candidate.mimeType,
              candidateFileName: candidate.fileName,
              candidateBytes: candidate.buffer.length,
              maxApiMessage: maxApiMessage || null,
              err: error instanceof Error ? error.message : String(error),
            },
            'Sticker lab asset upload failed',
          );
          continue;
        }

        try {
          const sent = await this.sendStickerLabFileMessageWithRetry(privateChatId, uploadPayload);
          this.logger.log(
            {
              userId: user.userId,
              privateChatId,
              mid: sent.messageId,
              messageUrl: sent.url,
              attachmentType: 'file',
              deliveryMode: 'file',
              acceptedAttemptNumber: candidateIndex + 1,
              acceptedAttemptName: candidate.name,
              failedAttemptsCount: failedCandidateAttempts.length,
              imageMimeType: candidate.mimeType,
              imageFileName: candidate.fileName,
              source: 'sticker_lab',
            },
            'Sticker lab asset delivered to private chat',
          );
          return stickerLabShareResponseSchema.parse({
            mid: sent.messageId,
            messageUrl: sent.url,
            privateChatId,
          });
        } catch (error: unknown) {
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          if (maxApiMessage) {
            lastMaxApiMessage = maxApiMessage;
          }
          failedCandidateAttempts.push({
            candidateName: candidate.name,
            stage: 'send',
            maxApiMessage: maxApiMessage || null,
            error: error instanceof Error ? error.message : String(error),
          });
          this.logger.warn(
            {
              userId: user.userId,
              privateChatId,
              candidateIndex: candidateIndex + 1,
              candidateName: candidate.name,
              candidateMimeType: candidate.mimeType,
              candidateFileName: candidate.fileName,
              candidateBytes: candidate.buffer.length,
              maxApiMessage: maxApiMessage || null,
              err: error instanceof Error ? error.message : String(error),
            },
            'Sticker lab asset delivery failed',
          );
        }
      }

      throw new BadRequestException(
        lastMaxApiMessage || 'Не удалось отправить файл в личный чат бота. Попробуйте ещё раз.',
      );
    }

    const imageCandidate = this.selectPreferredStickerLabImageCandidate(uploadCandidates);
    let uploadPayload: Record<string, unknown>;
    try {
      uploadPayload = await this.maxClient.uploadImage(
        imageCandidate.buffer,
        imageCandidate.fileName,
        imageCandidate.mimeType,
      );
      const uploadPayloadKeys = Object.keys(uploadPayload).sort();
      this.logger.log(
        {
          userId: user.userId,
          privateChatId,
          candidateName: imageCandidate.name,
          candidateMimeType: imageCandidate.mimeType,
          candidateFileName: imageCandidate.fileName,
          candidateBytes: imageCandidate.buffer.length,
          uploadPayloadKeys,
          uploadHasUrl: typeof uploadPayload.url === 'string',
          uploadHasToken: typeof uploadPayload.token === 'string',
          uploadHasPhotoId:
            typeof uploadPayload.photo_id === 'string' ||
            typeof uploadPayload.photo_id === 'number',
        },
        'Sticker lab asset uploaded to MAX',
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: user.userId,
          privateChatId,
          candidateName: imageCandidate.name,
          candidateMimeType: imageCandidate.mimeType,
          candidateFileName: imageCandidate.fileName,
          candidateBytes: imageCandidate.buffer.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Sticker lab asset upload failed',
      );
      throw new BadRequestException(
        'Не удалось отправить файл в личный чат бота. Попробуйте ещё раз.',
      );
    }

    try {
      const delivery = await this.deliverStickerLabAsset(
        privateChatId,
        uploadPayload,
        imageCandidate.mimeType,
      );
      const attachmentType =
        delivery.deliveryMode === 'sticker'
          ? 'sticker'
          : delivery.deliveryMode === 'image_variant'
            ? 'image_variant'
            : 'image';
      this.logger.log(
        {
          userId: user.userId,
          privateChatId,
          mid: delivery.sent.messageId,
          messageUrl: delivery.sent.url,
          attachmentType,
          deliveryMode: delivery.deliveryMode,
          acceptedAttemptNumber: delivery.attemptNumber,
          acceptedAttemptName: delivery.attemptName,
          failedAttemptsCount: delivery.failedAttempts.length,
          imageMimeType: imageCandidate.mimeType,
          imageFileName: imageCandidate.fileName,
          source: 'sticker_lab',
        },
        'Sticker lab asset delivered to private chat',
      );

      return stickerLabShareResponseSchema.parse({
        mid: delivery.sent.messageId,
        messageUrl: delivery.sent.url,
        privateChatId,
      });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      this.logger.warn(
        {
          userId: user.userId,
          privateChatId,
          deliveryType,
          candidateName: imageCandidate.name,
          candidateMimeType: imageCandidate.mimeType,
          candidateFileName: imageCandidate.fileName,
          candidateBytes: imageCandidate.buffer.length,
          err: error instanceof Error ? error.message : String(error),
          maxApiMessage: maxApiMessage || null,
        },
        'Sticker lab asset delivery failed',
      );
      throw new BadRequestException(
        maxApiMessage || 'Не удалось отправить файл в личный чат бота. Попробуйте ещё раз.',
      );
    }
  }

  private async deliverStickerLabAsset(
    chatId: string,
    uploadPayload: Record<string, unknown>,
    preparedMimeType: string,
  ): Promise<StickerLabDeliveryResult> {
    const attempts = this.buildStickerLabDeliveryAttempts(uploadPayload, preparedMimeType);
    const failedAttempts: StickerLabFailedAttempt[] = [];
    this.logger.log(
      {
        chatId,
        preparedMimeType,
        attemptsCount: attempts.length,
        attempts: attempts.map((attempt, index) => {
          const attachment = attempt.attachments[0];
          const payload =
            attachment && typeof attachment === 'object'
              ? (attachment.payload as Record<string, unknown> | undefined)
              : undefined;
          return {
            attempt: index + 1,
            name: attempt.name,
            attachmentType: typeof attachment?.type === 'string' ? attachment.type : 'unknown',
            payloadKeys:
              payload && typeof payload === 'object' && !Array.isArray(payload)
                ? Object.keys(payload).sort()
                : [],
          };
        }),
      },
      'Sticker lab delivery experiment matrix prepared',
    );

    for (const [index, attempt] of attempts.entries()) {
      const attachmentType =
        typeof attempt.attachments[0]?.type === 'string' ? attempt.attachments[0].type : 'unknown';
      const payload = attempt.attachments[0]?.payload;
      const payloadKeys =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? Object.keys(payload as Record<string, unknown>).sort()
          : [];

      try {
        const sent = await this.maxClient.sendCustomMessageImmediateWithResolvedLink(chatId, {
          attachments: attempt.attachments,
        });
        if (attempt.deliveryMode === 'sticker') {
          this.logger.log(
            {
              chatId,
              attempt: index + 1,
              name: attempt.name,
              attachmentType,
              payloadKeys,
            },
            'MAX accepted sticker attachment from sticker lab',
          );
          return {
            sent,
            deliveryMode: 'sticker',
            attemptNumber: index + 1,
            attemptName: attempt.name,
            failedAttempts,
          };
        }

        this.logger.warn(
          {
            chatId,
            attempt: index + 1,
            name: attempt.name,
            attachmentType,
            payloadKeys,
          },
          'MAX accepted only image-based sticker variant from sticker lab',
        );
        return {
          sent,
          deliveryMode: 'image_variant',
          attemptNumber: index + 1,
          attemptName: attempt.name,
          failedAttempts,
        };
      } catch (error: unknown) {
        const errorMessage =
          this.extractMaxApiErrorMessage(error) ||
          (error instanceof Error ? error.message : String(error));
        failedAttempts.push({
          attempt: index + 1,
          name: attempt.name,
          attachmentType,
          error: errorMessage,
        });
        this.logger.warn(
          {
            chatId,
            attempt: index + 1,
            name: attempt.name,
            attachmentType,
            payloadKeys,
            error: errorMessage,
          },
          'Sticker lab attempt failed',
        );
      }
    }

    this.logger.warn(
      {
        chatId,
        attemptsCount: attempts.length,
        failedAttempts,
      },
      'MAX rejected all sticker attachment variants from sticker lab, falling back to image',
    );
    const fallbackAttemptNumber = attempts.length + 1;
    try {
      const sent = await this.maxClient.sendCustomMessageImmediateWithResolvedLink(chatId, {
        attachments: [
          {
            type: 'image',
            payload: uploadPayload,
          },
        ],
      });
      return {
        sent,
        deliveryMode: 'image_fallback',
        attemptNumber: fallbackAttemptNumber,
        attemptName: 'image_fallback_plain',
        failedAttempts,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          attempt: fallbackAttemptNumber,
          name: 'image_fallback_plain',
          attachmentType: 'image',
          error: this.extractMaxApiErrorMessage(error) || String(error),
          failedAttempts,
        },
        'Sticker lab fallback image delivery failed',
      );
      throw error;
    }
  }

  private buildStickerLabDeliveryAttempts(
    uploadPayload: Record<string, unknown>,
    preparedMimeType: string,
  ): StickerLabDeliveryAttempt[] {
    const attempts: StickerLabDeliveryAttempt[] = [];
    const fingerprints = new Set<string>();
    const normalizedMimeType = preparedMimeType.trim().toLowerCase();
    const uploadToken = this.readStickerLabPayloadString(uploadPayload.token);
    const uploadUrl = this.readStickerLabPayloadString(uploadPayload.url);
    const uploadPhotoId = this.readStickerLabPayloadString(uploadPayload.photo_id);
    const smileIdFromUrl = this.parseSmileIdFromStickerUrl(uploadUrl);
    const codeCandidates = this.readStickerLabPayloadCodeCandidates(uploadPayload, {
      smileIdFromUrl,
      uploadToken,
      uploadPhotoId,
    }).slice(0, 4);

    this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
      name: 'sticker_payload',
      deliveryMode: 'sticker',
      attachments: [
        {
          type: 'sticker',
          payload: uploadPayload,
        },
      ],
    });

    if (normalizedMimeType) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_with_mime',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              ...uploadPayload,
              mime_type: normalizedMimeType,
            },
          },
        ],
      });
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_with_mime_and_media_type',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              ...uploadPayload,
              mime_type: normalizedMimeType,
              media_type: 'sticker',
            },
          },
        ],
      });
    }

    this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
      name: 'sticker_payload_with_media_type',
      deliveryMode: 'sticker',
      attachments: [
        {
          type: 'sticker',
          payload: {
            ...uploadPayload,
            media_type: 'sticker',
          },
        },
      ],
    });

    if (uploadToken) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_token_only',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              token: uploadToken,
            },
          },
        ],
      });
    }

    if (uploadUrl) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_url_only',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              url: uploadUrl,
            },
          },
        ],
      });
    }

    if (uploadToken && uploadUrl) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_token_and_url',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              token: uploadToken,
              url: uploadUrl,
            },
          },
        ],
      });
    }

    if (uploadPhotoId) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_photo_id',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              photo_id: uploadPhotoId,
            },
          },
        ],
      });
    }

    if (smileIdFromUrl) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'sticker_payload_smile_id',
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              smile_id: smileIdFromUrl,
              smileId: smileIdFromUrl,
            },
          },
        ],
      });
    }

    for (const [index, code] of codeCandidates.entries()) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: `sticker_code_candidate_${index + 1}`,
        deliveryMode: 'sticker',
        attachments: [
          {
            type: 'sticker',
            payload: {
              code,
            },
          },
        ],
      });
    }

    this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
      name: 'image_payload_with_media_type_sticker',
      deliveryMode: 'image_variant',
      attachments: [
        {
          type: 'image',
          payload: {
            ...uploadPayload,
            media_type: 'sticker',
          },
        },
      ],
    });

    if (normalizedMimeType) {
      this.pushUniqueStickerLabAttempt(attempts, fingerprints, {
        name: 'image_payload_with_media_type_sticker_and_mime',
        deliveryMode: 'image_variant',
        attachments: [
          {
            type: 'image',
            payload: {
              ...uploadPayload,
              mime_type: normalizedMimeType,
              media_type: 'sticker',
            },
          },
        ],
      });
    }

    return attempts;
  }

  private pushUniqueStickerLabAttempt(
    attempts: StickerLabDeliveryAttempt[],
    fingerprints: Set<string>,
    attempt: StickerLabDeliveryAttempt,
  ): void {
    const fingerprint = JSON.stringify(attempt.attachments);
    if (fingerprints.has(fingerprint)) {
      return;
    }
    fingerprints.add(fingerprint);
    attempts.push(attempt);
  }

  private readStickerLabPayloadString(value: unknown): string | null {
    if (typeof value === 'string') {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return null;
  }

  private readStickerLabPayloadCodeCandidates(
    uploadPayload: Record<string, unknown>,
    options: {
      smileIdFromUrl: string | null;
      uploadToken: string | null;
      uploadPhotoId: string | null;
    },
  ): string[] {
    const candidates = [
      this.readStickerLabPayloadString(uploadPayload.code),
      this.readStickerLabPayloadString(uploadPayload.smile_id),
      this.readStickerLabPayloadString(uploadPayload.smileId),
      options.smileIdFromUrl,
      options.uploadToken,
      options.uploadPhotoId,
    ];
    const unique = new Set<string>();
    const normalized: string[] = [];
    for (const candidate of candidates) {
      if (!candidate || unique.has(candidate)) {
        continue;
      }
      unique.add(candidate);
      normalized.push(candidate);
    }
    return normalized;
  }

  private parseSmileIdFromStickerUrl(url: string | null): string | null {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      const smileId = parsed.searchParams.get('smileId');
      if (!smileId) {
        return null;
      }
      const normalized = smileId.trim();
      return normalized.length > 0 ? normalized : null;
    } catch {
      return null;
    }
  }

  private async buildStickerLabUploadCandidates(
    sourceBuffer: Buffer,
    sourceFileName: string,
    sourceMimeType: string,
  ): Promise<StickerLabUploadCandidate[]> {
    const candidates: StickerLabUploadCandidate[] = [];
    const fingerprints = new Set<string>();
    const sourceBaseName =
      sourceFileName.replace(/\.[^./\\]+$/u, '').trim() || `sticker-${Date.now()}`;

    this.pushStickerLabUploadCandidate(candidates, fingerprints, {
      name: 'original',
      buffer: sourceBuffer,
      mimeType: sourceMimeType,
      fileName: sourceFileName,
    });

    try {
      const pngBuffer = await sharp(sourceBuffer)
        .rotate()
        .resize(STICKER_LAB_CANVAS_SIZE, STICKER_LAB_CANVAS_SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          palette: true,
          quality: 100,
          effort: 10,
        })
        .toBuffer();
      this.pushStickerLabUploadCandidate(candidates, fingerprints, {
        name: 'square_png_512',
        buffer: Buffer.from(pngBuffer),
        mimeType: 'image/png',
        fileName: `${sourceBaseName}.png`,
      });

      let webpBuffer: Buffer<ArrayBufferLike> | null = null;
      for (const quality of STICKER_LAB_QUALITY_LEVELS) {
        const rendered = await sharp(sourceBuffer)
          .rotate()
          .resize(STICKER_LAB_CANVAS_SIZE, STICKER_LAB_CANVAS_SIZE, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .webp({
            quality,
            alphaQuality: 100,
            effort: 4,
            nearLossless: quality >= 84,
          })
          .toBuffer();
        webpBuffer = rendered;
        if (rendered.length <= STICKER_LAB_TARGET_BYTES) {
          break;
        }
      }
      if (webpBuffer) {
        this.pushStickerLabUploadCandidate(candidates, fingerprints, {
          name: 'square_webp_512',
          buffer: Buffer.from(webpBuffer),
          mimeType: 'image/webp',
          fileName: `${sourceBaseName}.webp`,
        });
      }

      let jpegBuffer: Buffer<ArrayBufferLike> | null = null;
      for (const quality of STICKER_LAB_QUALITY_LEVELS) {
        const rendered = await sharp(sourceBuffer)
          .rotate()
          .resize(STICKER_LAB_CANVAS_SIZE, STICKER_LAB_CANVAS_SIZE, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .flatten({ background: '#ffffff' })
          .jpeg({
            quality,
            mozjpeg: true,
            chromaSubsampling: '4:4:4',
          })
          .toBuffer();
        jpegBuffer = rendered;
        if (rendered.length <= STICKER_LAB_TARGET_BYTES) {
          break;
        }
      }
      if (jpegBuffer) {
        this.pushStickerLabUploadCandidate(candidates, fingerprints, {
          name: 'square_jpeg_512',
          buffer: Buffer.from(jpegBuffer),
          mimeType: 'image/jpeg',
          fileName: `${sourceBaseName}.jpg`,
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Sticker lab image candidate generation failed, using original payload only',
      );
    }

    return candidates;
  }

  private pushStickerLabUploadCandidate(
    candidates: StickerLabUploadCandidate[],
    fingerprints: Set<string>,
    candidate: StickerLabUploadCandidate,
  ): void {
    if (!candidate.buffer.length || candidate.buffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      return;
    }
    const prefix = candidate.buffer.subarray(0, 16).toString('base64');
    const fingerprint = `${candidate.mimeType}:${candidate.buffer.length}:${prefix}`;
    if (fingerprints.has(fingerprint)) {
      return;
    }
    fingerprints.add(fingerprint);
    candidates.push(candidate);
  }

  private selectPreferredStickerLabImageCandidate(
    candidates: StickerLabUploadCandidate[],
  ): StickerLabUploadCandidate {
    return (
      candidates.find((candidate) => candidate.name === 'square_webp_512') ??
      candidates.find((candidate) => candidate.name === 'square_png_512') ??
      candidates.find((candidate) => candidate.name === 'original') ??
      candidates[0]
    );
  }

  private async sendStickerLabFileMessageWithRetry(
    chatId: string,
    uploadPayload: Record<string, unknown>,
  ): Promise<MaxPublishedMessage> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.maxClient.sendCustomMessageImmediateWithResolvedLink(chatId, {
          attachments: [
            {
              type: 'file',
              payload: uploadPayload,
            },
          ],
        });
      } catch (error: unknown) {
        lastError = error;
        if (!this.isAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await this.sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Sticker lab file delivery failed without error details');
  }

  async listChats(
    user: AuthUser,
    options: { refresh?: boolean } = {},
  ): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'chat', options);
  }

  async listChannels(
    user: AuthUser,
    options: { refresh?: boolean } = {},
  ): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'channel', options);
  }

  async getChatHeader(chatId: string, user: AuthUser): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'chat');
  }

  async getChannelHeader(chatId: string, user: AuthUser): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'channel');
  }

  async listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: { refresh?: boolean } = {},
  ): Promise<ChatSummary[]> {
    if (options.refresh !== true) {
      const cached = await this.listChatsFromAllowlist(user.userId, entityType);
      const bootstrapped = await this.bootstrapCurrentChat(user, entityType);
      const initial = bootstrapped
        ? [bootstrapped, ...cached.filter((chat) => chat.id !== bootstrapped.id)]
        : cached;
      if (initial.length > 0) {
        return this.attachChannelOverview(initial);
      }

      return [];
    }

    try {
      const remoteChats = await this.maxClient.listBotChats();
      const resolvedChats = await this.mapWithConcurrencyLimit(
        remoteChats,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (remoteChat) => {
          const access = await this.resolveUserAndBotAdminAccess(
            remoteChat.chatId,
            user.userId,
          );
          if (access.status !== 'granted') {
            return null;
          }

          const persistedChat = await this.upsertUserChatAccess(
            remoteChat.chatId,
            user.userId,
            remoteChat.title,
            remoteChat.entityType,
            { updateEntityType: true },
          );

          const chat: ChatSummary = {
            id: persistedChat.id,
            title: persistedChat.title,
            createdAt: persistedChat.createdAt.toISOString(),
            entityType: this.fromPrismaEntityType(persistedChat.entityType),
            link: remoteChat.link,
            channelOverview: null,
          };

          if (this.isFallbackTitle(chat.id, chat.title)) {
            await this.refreshChatTitle(chat);
          }

          return {
            chat,
            lastEventTime: remoteChat.lastEventTime ?? 0,
          };
        },
      );

      const filtered = resolvedChats.filter(
        (item): item is { chat: ChatSummary; lastEventTime: number } => item !== null,
      );

      if (filtered.length > 0) {
        const byType =
          entityType === 'all'
            ? filtered
            : filtered.filter((item) => item.chat.entityType === entityType);
        byType.sort((a, b) => b.lastEventTime - a.lastEventTime);
        return this.attachChannelOverview(byType.map((item) => item.chat));
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to auto-discover chats via MAX API',
      );
    }

    const cached = await this.listChatsFromAllowlist(user.userId, entityType);
    if (cached.length > 0) {
      return this.attachChannelOverview(cached);
    }

    const bootstrapped = await this.bootstrapCurrentChat(user, entityType);
    return bootstrapped ? this.attachChannelOverview([bootstrapped]) : [];
  }

  async getChannelStats(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChannelStatsResponse> {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = channelStatsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveChannelStatsFrom(parsed.data.range, now);
    const bucket = this.resolveChannelStatsBucket(parsed.data.range);

    try {
      await this.channelStatsCollector?.syncChannelIfStale(chatId, {
        staleMs: CHANNEL_STATS_REFRESH_STALE_MS,
        reason: 'stats_endpoint',
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh channel stats opportunistically',
      );
    }

    const [
      chat,
      secondaryRows,
      latestAudienceSnapshot,
      earliestAudienceSnapshot,
      previousAudienceSnapshot,
      audienceSnapshots,
      syncState,
      periodPosts,
      anyPost,
      membershipRows,
    ] = await Promise.all([
      this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, title: true },
      }),
      this.prisma.$queryRaw<
        Array<{
          posts_with_buttons: unknown;
          comments: unknown;
          suggestions: unknown;
          comment_authors: unknown;
          suggestion_authors: unknown;
          suggestions_delivered: unknown;
          suggestions_failed: unknown;
          last_bot_activity_at: Date | string | null;
        }>
      >`
        SELECT
          COUNT(DISTINCT CASE
            WHEN action IN (${Prisma.join(CHANNEL_STATS_POST_ACTIONS)})
            THEN NULLIF(BTRIM(payload->>'threadId'), '')
            ELSE NULL
          END) AS posts_with_buttons,
          COUNT(*) FILTER (WHERE action = ${CHANNEL_DIALOG_ACTION_COMMENT}) AS comments,
          COUNT(*) FILTER (WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}) AS suggestions,
          COUNT(DISTINCT CASE
            WHEN action = ${CHANNEL_DIALOG_ACTION_COMMENT}
            THEN actor_user_id
            ELSE NULL
          END) AS comment_authors,
          COUNT(DISTINCT CASE
            WHEN action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
            THEN actor_user_id
            ELSE NULL
          END) AS suggestion_authors,
          COUNT(*) FILTER (
            WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
              AND payload->>'delivered' = 'true'
          ) AS suggestions_delivered,
          COUNT(*) FILTER (
            WHERE action = ${CHANNEL_DIALOG_ACTION_SUGGEST}
              AND payload->>'delivered' = 'false'
          ) AS suggestions_failed,
          MAX(created_at) FILTER (
            WHERE action IN (${Prisma.join(CHANNEL_STATS_ACTIVITY_ACTIONS)})
          ) AS last_bot_activity_at
        FROM audit_logs
        WHERE chat_id = ${chatId}
          AND created_at >= ${from}
          AND created_at <= ${now}
      `,
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'desc' },
      }),
      this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
        },
      }),
      this.prisma.channelAudienceSnapshot.findFirst({
        where: {
          chatId,
          capturedAt: { lt: from },
        },
        orderBy: { capturedAt: 'desc' },
        select: {
          participantsCount: true,
        },
      }),
      this.prisma.channelAudienceSnapshot.findMany({
        where: {
          chatId,
          capturedAt: { gte: from, lte: now },
        },
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
          participantsCount: true,
        },
      }),
      this.prisma.channelStatsSyncState.findUnique({
        where: { chatId },
      }),
      this.prisma.channelPost.findMany({
        where: {
          chatId,
          publishedAt: { gte: from, lte: now },
        },
        orderBy: { publishedAt: 'asc' },
        select: {
          publishedAt: true,
          latestViews: true,
          latestReactions: true,
          latestReactionsTotal: true,
        },
      }),
      this.prisma.channelPost.findFirst({
        where: { chatId },
        select: { id: true },
      }),
      this.prisma.$queryRaw<
        Array<{
          created_at: Date | string;
          event_type: string | null;
        }>
      >`
        SELECT
          created_at,
          normalized_payload->>'type' AS event_type
        FROM webhook_events
        WHERE normalized_payload->'message'->>'chatId' = ${chatId}
          AND normalized_payload->>'type' IN ('user_added', 'user_removed')
          AND created_at >= ${from}
          AND created_at <= ${now}
        ORDER BY created_at ASC
      `,
    ]);

    const localTitle = chat?.title?.trim() || `Канал ${chatId}`;
    let maxSnapshotAvailable = latestAudienceSnapshot !== null;
    let title = localTitle;
    let participantsCount = latestAudienceSnapshot?.participantsCount ?? null;
    let status = latestAudienceSnapshot?.status ?? null;
    let isPublic = latestAudienceSnapshot?.isPublic ?? null;
    let link = latestAudienceSnapshot?.link ?? null;
    let lastEventAt = latestAudienceSnapshot?.lastEventAt?.toISOString() ?? null;

    if (latestAudienceSnapshot) {
      title = chat?.title?.trim() || localTitle;
    } else {
      try {
        const snapshot = await this.maxClient.getChatSnapshot(chatId);
        title = snapshot.title?.trim() || localTitle;
        participantsCount = snapshot.participantsCount;
        status = snapshot.status;
        isPublic = snapshot.isPublic;
        link = snapshot.link;
        lastEventAt = snapshot.lastEventAt;
        maxSnapshotAvailable = true;
      } catch (error: unknown) {
        maxSnapshotAvailable = false;
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to fetch MAX fallback snapshot for channel stats',
        );
      }
    }

    const secondary = secondaryRows[0] ?? {
      posts_with_buttons: 0,
      comments: 0,
      suggestions: 0,
      comment_authors: 0,
      suggestion_authors: 0,
      suggestions_delivered: 0,
      suggestions_failed: 0,
      last_bot_activity_at: null,
    };

    const churnAvailable = Boolean(
      syncState?.membershipCoverageFrom &&
      syncState.membershipCoverageFrom.getTime() <= from.getTime(),
    );
    let joined = 0;
    let left = 0;
    for (const row of membershipRows) {
      if (row.event_type === 'user_added') {
        joined += 1;
      } else if (row.event_type === 'user_removed') {
        left += 1;
      }
    }

    const bucketStarts = this.buildChannelStatsBucketStarts(from, now, bucket);
    const topReactions = this.buildTopReactions(periodPosts);
    const response: ChannelStatsResponse = {
      channel: {
        id: chatId,
        title,
        participantsCount,
        status,
        isPublic,
        link,
        lastEventAt,
      },
      period: {
        range: parsed.data.range,
        from: from.toISOString(),
        to: now.toISOString(),
        bucket,
      },
      official: {
        audience: {
          joined,
          left,
          net: joined - left,
        },
        content: {
          posts: periodPosts.length,
          views: periodPosts.reduce((total, item) => total + Math.max(0, item.latestViews), 0),
          reactions: periodPosts.reduce(
            (total, item) => total + this.toSafeInteger(item.latestReactionsTotal),
            0,
          ),
          topReactions,
          lastPublishedAt:
            periodPosts.length > 0
              ? periodPosts[periodPosts.length - 1].publishedAt.toISOString()
              : null,
        },
        series: {
          participants: this.buildParticipantSeries(
            bucketStarts,
            bucket,
            previousAudienceSnapshot?.participantsCount ?? null,
            audienceSnapshots,
          ),
          membership: this.buildMembershipSeries(bucketStarts, bucket, membershipRows),
          views: this.buildViewsSeries(bucketStarts, bucket, periodPosts),
        },
      },
      secondary: {
        postsWithButtons: this.toSafeInteger(secondary.posts_with_buttons),
        comments: this.toSafeInteger(secondary.comments),
        suggestions: this.toSafeInteger(secondary.suggestions),
        commentAuthors: this.toSafeInteger(secondary.comment_authors),
        suggestionAuthors: this.toSafeInteger(secondary.suggestion_authors),
        suggestionsDelivered: this.toSafeInteger(secondary.suggestions_delivered),
        suggestionsFailed: this.toSafeInteger(secondary.suggestions_failed),
        lastBotActivityAt: this.toIsoString(secondary.last_bot_activity_at),
      },
      meta: {
        maxSnapshotAvailable,
        viewsAvailable: Boolean(anyPost),
        churnAvailable,
        officialCoverageFrom: this.resolveOfficialCoverageFrom(
          syncState,
          earliestAudienceSnapshot?.capturedAt ?? null,
        ),
        missingOfficialMetrics: [...CHANNEL_STATS_MISSING_METRICS],
      },
    };

    return channelStatsResponseSchema.parse(response);
  }

  async getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        entityType: ChatEntityType.CHAT,
        settings: {
          create: {},
        },
      },
      update: {
        settings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { settings: true },
    });

    if (!chat.settings) {
      throw new Error('Chat settings missing after upsert');
    }

    const parsed = chatSettingsSchema.safeParse(chat.settings);
    if (parsed.success) {
      const normalizedSettings = this.normalizeChatSettings(parsed.data);
      const normalizationChanges = this.getChatSettingsNormalizationChanges(
        parsed.data,
        normalizedSettings,
      );
      if (Object.keys(normalizationChanges).length > 0) {
        await this.prisma.chatSettings.update({
          where: { chatId },
          data: normalizationChanges,
        });
        await this.chatContextCache.invalidate(chatId);
      }

      return normalizedSettings;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid chat settings found in DB, applying defaults',
    );

    const fallback = chatSettingsSchema.parse({});
    await this.prisma.chatSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return fallback;
  }

  async getChatSettingsScreen(
    chatId: string,
    user: AuthUser,
  ): Promise<ChatSettingsScreenResponse> {
    const [settings, rules, header, domains, managedBroadcasts] = await Promise.all([
      this.getSettings(chatId, user),
      this.getRules(chatId, user),
      this.getChatHeader(chatId, user),
      this.getDomainAllowlistDetails(chatId, user),
      this.listManagedBroadcasts(chatId, user),
    ]);

    return chatSettingsScreenResponseSchema.parse({
      settings,
      rules,
      header,
      domains,
      managedBroadcasts,
    });
  }

  async updateSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const normalizedSettings = this.normalizeChatSettings(parsed.data);

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        entityType: ChatEntityType.CHAT,
        settings: {
          create: {
            ...normalizedSettings,
          },
        },
      },
      update: {
        settings: {
          upsert: {
            update: {
              ...normalizedSettings,
            },
            create: {
              ...normalizedSettings,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_SETTINGS',
        payload: {
          ...normalizedSettings,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return normalizedSettings;
  }

  async getRules(chatId: string, user: AuthUser): Promise<ChatRules> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const rules = await this.upsertChatRules(chatId);
    const hydratedRules = await this.hydratePublishedRulesUrl(chatId, rules);
    return this.mapChatRules(hydratedRules);
  }

  async updateRules(chatId: string, user: AuthUser, body: unknown): Promise<ChatRules> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = updateChatRulesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalizedDraft = this.normalizeChatRulesDraft(parsed.data);
    if (normalizedDraft.imageBase64) {
      const imageBuffer = this.decodeRulesImageBase64(normalizedDraft.imageBase64);
      if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото правил слишком большое. Максимум 1 MB.');
      }
      if (!normalizedDraft.imageMimeType.toLowerCase().startsWith('image/')) {
        throw new BadRequestException('Поддерживаются только изображения.');
      }
    }

    const rules = await this.prisma.chatRules.upsert({
      where: { chatId },
      create: {
        chatId,
        ...normalizedDraft,
      },
      update: {
        ...normalizedDraft,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_CHAT_RULES',
        payload: {
          autoTextEnabled: normalizedDraft.autoTextEnabled,
          hasImage: Boolean(normalizedDraft.imageBase64),
          textLength: normalizedDraft.text.length,
          source: 'miniapp',
        },
      },
    });
    await this.chatContextCache?.invalidate(chatId);

    return this.mapChatRules(rules);
  }

  async publishRules(chatId: string, user: AuthUser): Promise<PublishChatRulesResult> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const rules = await this.upsertChatRules(chatId);
    const messageText = rules.text.trim();
    if (!messageText) {
      throw new BadRequestException('Сначала заполните текст правил.');
    }

    let imagePayload: Record<string, unknown> | undefined;
    if (rules.imageBase64.trim()) {
      const imageMimeType = rules.imageMimeType.trim().toLowerCase();
      if (!imageMimeType.startsWith('image/')) {
        throw new BadRequestException('Поддерживаются только изображения.');
      }

      const imageBuffer = this.decodeRulesImageBase64(rules.imageBase64);
      if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото правил слишком большое. Максимум 1 MB.');
      }

      try {
        imagePayload = await this.maxClient.uploadImage(
          imageBuffer,
          this.resolveRulesImageFileName(rules.imageFileName, imageMimeType),
          imageMimeType,
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Rules image upload failed',
        );
        throw new BadRequestException(
          'Не удалось загрузить фото правил. Попробуйте другое изображение.',
        );
      }
    }

    let published: { messageId: string; url: string | null };
    try {
      published = await this.publishRulesMessageWithRetry(
        chatId,
        messageText,
        imagePayload ? { imagePayload } : undefined,
      );
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать правила.');
    }

    const publishedAt = new Date();
    await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        publishedMessageId: published.messageId,
        publishedUrl: published.url,
        publishedAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'PUBLISH_CHAT_RULES',
        payload: {
          messageId: published.messageId,
          url: published.url,
          publishedAt: publishedAt.toISOString(),
          hasImage: Boolean(imagePayload),
          source: 'miniapp',
        },
      },
    });

    const hydratedRules = await this.hydratePublishedRulesUrl(chatId, {
      ...rules,
      publishedMessageId: published.messageId,
      publishedUrl: published.url,
      publishedAt,
    });
    await this.chatContextCache?.invalidate(chatId);

    return publishChatRulesResultSchema.parse({
      chatId,
      messageId: published.messageId,
      url: hydratedRules.publishedUrl,
      publishedAt: publishedAt.toISOString(),
    });
  }

  async resetPublishedRules(chatId: string, user: AuthUser): Promise<ChatRules> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const rules = await this.upsertChatRules(chatId);
    const publishedMessageId = rules.publishedMessageId?.trim() ?? '';

    if (publishedMessageId) {
      try {
        await this.maxClient.deleteMessage(chatId, publishedMessageId, { immediate: true });
      } catch (error: unknown) {
        if (!this.isMaxMessageMissingError(error)) {
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          throw new BadRequestException(
            maxApiMessage || 'Не удалось удалить опубликованный пост правил.',
          );
        }
      }
    }

    const updatedRules = await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: {
          deletedPost: Boolean(publishedMessageId),
          messageId: publishedMessageId || null,
          source: 'miniapp',
        },
      },
    });
    await this.chatContextCache?.invalidate(chatId);

    return this.mapChatRules(updatedRules);
  }

  async getChatPoll(chatId: string, user: AuthUser): Promise<ManagedPoll> {
    return this.getManagedPoll(chatId, user, 'chat');
  }

  async updateChatPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.updateManagedPoll(chatId, user, 'chat', body, source);
  }

  async publishChatPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.publishManagedPoll(chatId, user, 'chat', source);
  }

  async closeChatPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.closeManagedPoll(chatId, user, 'chat', source);
  }

  async getChannelPoll(chatId: string, user: AuthUser): Promise<ManagedPoll> {
    return this.getManagedPoll(chatId, user, 'channel');
  }

  async updateChannelPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.updateManagedPoll(chatId, user, 'channel', body, source);
  }

  async publishChannelPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.publishManagedPoll(chatId, user, 'channel', source);
  }

  async closeChannelPoll(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManagedPoll> {
    return this.closeManagedPoll(chatId, user, 'channel', source);
  }

  async getChannelSettings(chatId: string, user: AuthUser): Promise<ChannelSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          create: {},
        },
      },
      update: {
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { channelSettings: true },
    });

    if (!chat.channelSettings) {
      throw new Error('Channel settings missing after upsert');
    }

    const parsed = channelSettingsSchema.safeParse(chat.channelSettings);
    if (parsed.success) {
      const normalized = this.normalizeChannelSettings(parsed.data);
      if (this.hasChannelSettingsNormalizationChanges(parsed.data, normalized)) {
        await this.prisma.channelSettings.update({
          where: { chatId },
          data: {
            ...normalized,
          },
        });
      }
      return normalized;
    }

    this.logger.warn(
      {
        chatId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'Invalid channel settings found in DB, applying defaults',
    );

    const fallback = channelSettingsSchema.parse({});
    await this.prisma.channelSettings.update({
      where: { chatId },
      data: {
        ...fallback,
      },
    });

    return fallback;
  }

  async getChannelSettingsScreen(
    chatId: string,
    user: AuthUser,
  ): Promise<ChannelSettingsScreenResponse> {
    const [settings, header] = await Promise.all([
      this.getChannelSettings(chatId, user),
      this.getChannelHeader(chatId, user),
    ]);

    return channelSettingsScreenResponseSchema.parse({
      settings,
      header,
    });
  }

  async updateChannelSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChannelSettings> {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');
    const parsed = channelSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const normalizedSettings = this.normalizeChannelSettings(parsed.data);

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Channel ${chatId}`,
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          create: {
            ...normalizedSettings,
          },
        },
      },
      update: {
        entityType: ChatEntityType.CHANNEL,
        channelSettings: {
          upsert: {
            update: {
              ...normalizedSettings,
            },
            create: {
              ...normalizedSettings,
            },
          },
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'UPDATE_CHANNEL_SETTINGS',
        payload: {
          ...normalizedSettings,
          source,
        },
      },
    });

    return normalizedSettings;
  }

  async publishChannelEngagementMessage(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = publishChannelEngagementRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const persistedSettings = await this.prisma.channelSettings.upsert({
      where: { chatId },
      create: {
        chatId,
      },
      update: {},
      select: {
        engagementPublishedMessageId: true,
        engagementPublishedThreadId: true,
        engagementPublishedAt: true,
      },
    });

    const existingPublishedMessageId = persistedSettings.engagementPublishedMessageId?.trim() ?? '';
    const existingThreadId = persistedSettings.engagementPublishedThreadId?.trim() ?? '';
    const threadId = existingThreadId || randomUUID();
    const commentsUrl = this.buildChannelDialogLaunchUrl(chatId, 'comments', threadId);
    const suggestUrl = this.buildChannelDialogLaunchUrl(chatId, 'suggest', threadId);
    const commentsWebAppUrl = this.buildChannelDialogDirectWebAppUrl(chatId, 'comments', threadId);
    const suggestWebAppUrl = this.buildChannelDialogDirectWebAppUrl(chatId, 'suggest', threadId);
    const botContactId = this.resolveBotContactId();
    const commentsButton: MaxMessageButton = commentsUrl
      ? {
          type: 'link',
          text: parsed.data.commentsButtonText,
          url: commentsUrl,
        }
      : commentsWebAppUrl && botContactId
        ? {
            type: 'open_app',
            text: parsed.data.commentsButtonText,
            webApp: commentsWebAppUrl,
            contactId: botContactId,
          }
        : {
            type: 'link',
            text: parsed.data.commentsButtonText,
            url: commentsWebAppUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
          };
    const suggestButton: MaxMessageButton = suggestUrl
      ? {
          type: 'link',
          text: parsed.data.suggestButtonText,
          url: suggestUrl,
        }
      : suggestWebAppUrl && botContactId
        ? {
            type: 'open_app',
            text: parsed.data.suggestButtonText,
            webApp: suggestWebAppUrl,
            contactId: botContactId,
          }
        : {
            type: 'link',
            text: parsed.data.suggestButtonText,
            url: suggestWebAppUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
          };
    const buttons: MaxMessageButton[][] = [];
    if (parsed.data.includeCommentsButton) {
      buttons.push([commentsButton]);
    }
    if (parsed.data.includeSuggestButton) {
      buttons.push([suggestButton]);
    }

    let messageId = existingPublishedMessageId;
    let updatedExisting = false;
    let recreatedFromMessageId: string | null = null;
    let publishedAt = persistedSettings.engagementPublishedAt ?? null;

    if (messageId) {
      try {
        await this.maxClient.editMessageInlineKeyboard(chatId, messageId, parsed.data.text, {
          buttons,
        } satisfies Pick<MaxSendMessageOptions, 'buttons'>);
        updatedExisting = true;
      } catch (error: unknown) {
        if (!this.shouldRecreateChannelEngagementMessage(error)) {
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          throw new BadRequestException(
            maxApiMessage || 'Не удалось обновить опубликованный пост с кнопками.',
          );
        }

        recreatedFromMessageId = messageId;
        messageId = '';
      }
    }

    if (!messageId) {
      try {
        const published = await this.maxClient.sendMessageImmediateWithResolvedLink(
          chatId,
          parsed.data.text,
          {
            buttons,
          } satisfies MaxSendMessageOptions,
        );
        messageId = published.messageId;
      } catch (error: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать пост с кнопками.');
      }
      publishedAt = new Date();
      updatedExisting = false;
    } else if (!publishedAt) {
      publishedAt = new Date();
    }

    await this.prisma.channelSettings.update({
      where: { chatId },
      data: {
        engagementPublishedMessageId: messageId,
        engagementPublishedThreadId: threadId,
        engagementPublishedAt: publishedAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: CHANNEL_DIALOG_ACTION_PUBLISH,
        payload: {
          messageId,
          text: parsed.data.text,
          commentsButtonText: parsed.data.commentsButtonText,
          suggestButtonText: parsed.data.suggestButtonText,
          includeCommentsButton: parsed.data.includeCommentsButton,
          includeSuggestButton: parsed.data.includeSuggestButton,
          threadId,
          updatedExisting,
          recreatedFromMessageId,
          commentsUrl,
          suggestUrl,
        },
      },
    });

    return publishChannelEngagementResultSchema.parse({
      chatId,
      sent: true,
      messageId,
      updatedExisting,
      publishedAt: publishedAt?.toISOString() ?? null,
    });
  }

  async getChannelDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const threadId = this.resolveChannelDialogThreadId(chatId, dialogType, token);
    const channelSettings = await this.getPublicChannelSettings(chatId);

    const action =
      dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId,
        action,
        ...(threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: threadId,
              },
            }
          : {}),
        ...(dialogType === 'suggest' ? { actorUserId: user.userId } : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: CHANNEL_DIALOG_MESSAGES_LIMIT,
    });

    const messages = rows
      .slice()
      .reverse()
      .map((row) => this.mapChannelDialogAuditLog(row, dialogType));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: this.resolveChannelDialogIntroText(channelSettings, dialogType),
      messages,
    });
  }

  async createChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId = this.resolveChannelDialogThreadId(chatId, dialogType, parsed.data.token);
    const text = parsed.data.text.trim();
    const authorDisplayName = user.displayName?.trim() ? user.displayName.trim() : user.username;
    const channelSettings = await this.getPublicChannelSettings(chatId);

    if (dialogType === 'comments' && !channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    if (dialogType === 'suggest' && !channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    if (dialogType === 'comments' && channelSettings.commentsModerationEnabled) {
      await this.assertChannelCommentAllowed({
        chatId,
        threadId,
        authorUserId: user.userId,
        text,
        settings: channelSettings,
      });
    }

    let delivered = true;
    let deliveredToUserId: string | null = null;
    if (dialogType === 'suggest') {
      const delivery = await this.deliverSuggestionToAdminPrivate(chatId, user, text);
      delivered = delivery.delivered;
      deliveredToUserId = delivery.deliveredToUserId;
    }

    const created = await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action:
          dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST,
        payload: {
          type: dialogType,
          threadId,
          text,
          authorDisplayName: authorDisplayName ?? null,
          delivered,
          deliveredToUserId,
          source: 'miniapp_dialog',
        },
      },
    });

    const message = {
      id: created.id,
      type: dialogType,
      text,
      authorUserId: user.userId,
      authorDisplayName: authorDisplayName ?? null,
      createdAt: created.createdAt.toISOString(),
      ...(dialogType === 'suggest'
        ? {
            delivered,
            deliveredToUserId,
          }
        : {}),
    };

    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message,
    });
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    settingKeys?: readonly (keyof ChatSettings)[],
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');
    const parsed = chatSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const normalizedSettings = this.normalizeChatSettings(parsed.data);

    const availableChats = await this.listChats(user);
    const appliedChatIds = Array.from(
      new Set([sourceChatId, ...availableChats.map((chat) => chat.id)]),
    );
    const filteredSettingKeys = Array.isArray(settingKeys)
      ? Array.from(new Set(settingKeys)).filter(
          (key): key is keyof ChatSettings => typeof key === 'string' && key in normalizedSettings,
        )
      : [];
    const settingsUpdatePayload: Partial<ChatSettings> =
      filteredSettingKeys.length > 0
        ? filteredSettingKeys.reduce<Partial<ChatSettings>>((acc, key) => {
            (acc as Record<keyof ChatSettings, ChatSettings[keyof ChatSettings]>)[key] =
              normalizedSettings[key];
            return acc;
          }, {})
        : normalizedSettings;

    for (const chatId of appliedChatIds) {
      await this.prisma.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: `Chat ${chatId}`,
          entityType: ChatEntityType.CHAT,
          settings: {
            create: {
              ...normalizedSettings,
            },
          },
        },
        update: {
          settings: {
            upsert: {
              update: {
                ...settingsUpdatePayload,
              },
              create: {
                ...normalizedSettings,
              },
            },
          },
        },
      });

      await this.prisma.chatAdminAllowlist.upsert({
        where: {
          chatId_userId: {
            chatId,
            userId: user.userId,
          },
        },
        create: {
          chatId,
          userId: user.userId,
        },
        update: {},
      });

      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'APPLY_SETTINGS_TO_ALL_CHATS',
          payload: {
            sourceChatId,
            targetChatId: chatId,
            source,
            ...(filteredSettingKeys.length > 0 ? { settingKeys: filteredSettingKeys } : {}),
          },
        },
      });

      await this.chatContextCache.invalidate(chatId);
    }

    return {
      sourceChatId,
      updatedChats: appliedChatIds.length,
      appliedChatIds,
    };
  }

  async applySettingsSectionToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ApplySectionToAllResponse> {
    const parsed = applySectionToAllRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const sourceSettings = await this.getSettings(sourceChatId, user);
    const result = await this.applySettingsToAllChats(
      sourceChatId,
      user,
      sourceSettings,
      source,
      SETTINGS_SECTION_KEYS[parsed.data.section],
    );

    return applySectionToAllResponseSchema.parse({
      section: parsed.data.section,
      ...result,
    });
  }

  private normalizeChatSettings(settings: ChatSettings): ChatSettings {
    return this.normalizeNightModeSettings(settings);
  }

  private normalizeNightModeSettings(settings: ChatSettings): ChatSettings {
    if (!settings.nightModeEnabled) {
      return {
        ...settings,
        nightModeBotMessageEnabled: false,
        nightModeBotButtonEnabled: false,
        nightModeRulesButtonEnabled: false,
      };
    }

    if (!settings.nightModeBotMessageEnabled) {
      return {
        ...settings,
        nightModeBotButtonEnabled: false,
        nightModeRulesButtonEnabled: false,
      };
    }

    return settings;
  }

  private getChatSettingsNormalizationChanges(
    current: Pick<
      ChatSettings,
      'nightModeBotMessageEnabled' | 'nightModeBotButtonEnabled' | 'nightModeRulesButtonEnabled'
    >,
    normalized: Pick<
      ChatSettings,
      'nightModeBotMessageEnabled' | 'nightModeBotButtonEnabled' | 'nightModeRulesButtonEnabled'
    >,
  ): Partial<
    Pick<
      ChatSettings,
      'nightModeBotMessageEnabled' | 'nightModeBotButtonEnabled' | 'nightModeRulesButtonEnabled'
    >
  > {
    const changes: Partial<
      Pick<
        ChatSettings,
        'nightModeBotMessageEnabled' | 'nightModeBotButtonEnabled' | 'nightModeRulesButtonEnabled'
      >
    > = {};

    if (current.nightModeBotMessageEnabled !== normalized.nightModeBotMessageEnabled) {
      changes.nightModeBotMessageEnabled = normalized.nightModeBotMessageEnabled;
    }
    if (current.nightModeBotButtonEnabled !== normalized.nightModeBotButtonEnabled) {
      changes.nightModeBotButtonEnabled = normalized.nightModeBotButtonEnabled;
    }
    if (current.nightModeRulesButtonEnabled !== normalized.nightModeRulesButtonEnabled) {
      changes.nightModeRulesButtonEnabled = normalized.nightModeRulesButtonEnabled;
    }

    return changes;
  }

  async sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.sendManagedBroadcast(sourceChatId, user, body, {
      entityType: 'chat',
      source,
      resolveTargets: (actor) => this.listChats(actor),
    });
  }

  async sendChannelBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.sendManagedBroadcast(sourceChatId, user, body, {
      entityType: 'channel',
      source,
    });
  }

  async listManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastSummary[]> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');

    const rows = await this.prisma.managedBroadcast.findMany({
      where: {
        sourceChatId,
        entityType: ChatEntityType.CHAT,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
      orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'desc' }],
    });

    const snapshots = await this.getManagedBroadcastDeliverySnapshots(rows);
    return rows.map((row) =>
      managedBroadcastSummarySchema.parse(
        this.mapManagedBroadcastSummary(row, snapshots.get(row.id)),
      ),
    );
  }

  async getManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');

    const row = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: ChatEntityType.CHAT,
      },
    });
    if (!row) {
      throw new BadRequestException('Рассылка не найдена.');
    }

    const snapshot = await this.getManagedBroadcastDeliverySnapshot(row);
    return managedBroadcastDetailsSchema.parse(this.mapManagedBroadcastDetails(row, snapshot));
  }

  async updateManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: ChatEntityType.CHAT,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Рассылка не найдена или уже завершена.');
    }

    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType: 'chat',
      resolveTargets: (actor) => this.listChats(actor),
    });

    const scheduledAt = this.parseManagedBroadcastSendAt(request.payload.sendAt, {
      required: true,
      sourceChatId,
      sentCount: existing.sentCount,
    });
    if (!scheduledAt) {
      throw new BadRequestException('Укажите следующее время отправки.');
    }
    const cycleEveryHours = request.payload.cycleEnabled ? request.payload.cycleEveryHours : 1;
    const cycleCount = request.payload.cycleEnabled ? request.payload.cycleCount : 1;

    if (existing.sentCount > 0 && !request.payload.cycleEnabled) {
      throw new BadRequestException(
        'После первого запуска цикла оставьте циклический режим включенным.',
      );
    }
    if (existing.sentCount > 0 && cycleCount <= existing.sentCount) {
      throw new BadRequestException('Количество отправок должно быть больше уже выполненных.');
    }

    const remainingDelayMs =
      scheduledAt.getTime() -
      Date.now() +
      Math.max(0, cycleCount - existing.sentCount - 1) * cycleEveryHours * ONE_HOUR_MS;
    if (remainingDelayMs > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Все оставшиеся отправки должны уместиться в 14 дней.');
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(existing);
    const currentOccurrenceDelivered = await this.prisma.managedBroadcastDelivery.count({
      where: {
        broadcastId: existing.id,
        occurrenceIndex: currentOccurrence,
        status: PrismaManagedBroadcastDeliveryStatus.SENT,
      },
    });
    if (currentOccurrenceDelivered > 0) {
      throw new BadRequestException(
        'Текущая отправка уже частично доставлена. Сначала повторите ошибки или остановите рассылку.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.managedBroadcast.update({
        where: { id: existing.id },
        data: {
          actorUserId: user.userId,
          text: request.payload.text.trim(),
          textFormat: request.payload.textFormat,
          applyToAllChats: request.payload.applyToAllChats,
          targetChatIds: request.targetChatIds as Prisma.InputJsonValue,
          buttonEnabled: request.payload.buttonEnabled,
          buttonUrl: request.payload.buttonEnabled ? request.payload.buttonUrl.trim() : '',
          buttonText: request.payload.buttonEnabled
            ? request.payload.buttonText.trim() || 'Открыть'
            : 'Открыть',
          imageEnabled: request.payload.imageEnabled,
          imageBase64: request.payload.imageEnabled ? request.payload.imageBase64 : '',
          imageMimeType: request.payload.imageEnabled ? request.payload.imageMimeType : '',
          imageFileName: request.payload.imageEnabled ? request.payload.imageFileName : '',
          nextSendAt: scheduledAt,
          cycleEnabled: request.payload.cycleEnabled,
          cycleEveryHours,
          cycleCount,
          status: PrismaManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
        },
      }),
      this.prisma.managedBroadcastDelivery.deleteMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: { gte: currentOccurrence },
          status: { not: PrismaManagedBroadcastDeliveryStatus.SENT },
        },
      }),
      this.prisma.managedBroadcastDelivery.createMany({
        data: this.buildManagedBroadcastDeliveryRows(
          existing.id,
          request.targetChatIds,
          currentOccurrence,
          cycleCount,
        ),
      }),
    ]);

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: existing.id },
    });
    if (!updated) {
      throw new BadRequestException('Рассылка не найдена.');
    }

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'UPDATE_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
          targetChats: request.targetChatIds.length,
          nextSendAt: scheduledAt.toISOString(),
          cycleEnabled: request.payload.cycleEnabled,
          cycleEveryHours,
          cycleCount,
        },
      },
    });

    const snapshot = await this.getManagedBroadcastDeliverySnapshot(updated);
    return managedBroadcastDetailsSchema.parse(this.mapManagedBroadcastDetails(updated, snapshot));
  }

  async cancelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: ChatEntityType.CHAT,
        status: {
          in: [
            PrismaManagedBroadcastStatus.ACTIVE,
            PrismaManagedBroadcastStatus.PARTIAL,
            PrismaManagedBroadcastStatus.FAILED,
          ],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Рассылка не найдена или уже завершена.');
    }

    const [canceled] = await this.prisma.$transaction([
      this.prisma.managedBroadcast.update({
        where: { id: existing.id },
        data: {
          status: PrismaManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
        },
      }),
      this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: existing.id,
          status: {
            in: [
              PrismaManagedBroadcastDeliveryStatus.PENDING,
              PrismaManagedBroadcastDeliveryStatus.SENDING,
              PrismaManagedBroadcastDeliveryStatus.FAILED,
            ],
          },
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
        },
      }),
    ]);

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'CANCEL_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
        },
      },
    });

    const snapshot = await this.getManagedBroadcastDeliverySnapshot(canceled);
    return managedBroadcastDetailsSchema.parse(this.mapManagedBroadcastDetails(canceled, snapshot));
  }

  async retryManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    await this.assertChatAdmin(sourceChatId, user.userId, 'chat');
    await this.ensureEntityType(sourceChatId, user.userId, 'chat');

    const existing = await this.prisma.managedBroadcast.findFirst({
      where: {
        id: broadcastId,
        sourceChatId,
        entityType: ChatEntityType.CHAT,
        status: {
          in: [PrismaManagedBroadcastStatus.PARTIAL, PrismaManagedBroadcastStatus.FAILED],
        },
      },
    });
    if (!existing) {
      throw new BadRequestException('Для повтора нет неуспешной рассылки.');
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(existing);
    await this.prisma.$transaction([
      this.prisma.managedBroadcast.update({
        where: { id: existing.id },
        data: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
          nextSendAt: existing.nextSendAt ?? new Date(),
        },
      }),
      this.prisma.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: existing.id,
          occurrenceIndex: currentOccurrence,
          status: {
            in: [
              PrismaManagedBroadcastDeliveryStatus.FAILED,
              PrismaManagedBroadcastDeliveryStatus.SENDING,
            ],
          },
        },
        data: {
          status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          lockedAt: null,
          lastError: null,
        },
      }),
    ]);

    await this.processManagedBroadcastOccurrence(
      existing.id,
      'manual_retry',
      new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
      [
        PrismaManagedBroadcastStatus.ACTIVE,
        PrismaManagedBroadcastStatus.PARTIAL,
        PrismaManagedBroadcastStatus.FAILED,
      ],
    );

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: existing.id },
    });
    if (!updated) {
      throw new BadRequestException('Рассылка не найдена.');
    }

    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'RETRY_BROADCAST_SCHEDULE',
        payload: {
          broadcastId: existing.id,
          occurrenceIndex: currentOccurrence,
        },
      },
    });

    const snapshot = await this.getManagedBroadcastDeliverySnapshot(updated);
    return managedBroadcastDetailsSchema.parse(this.mapManagedBroadcastDetails(updated, snapshot));
  }

  async processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS);
    const dueRows = await this.prisma.managedBroadcast.findMany({
      where: {
        entityType: ChatEntityType.CHAT,
        status: PrismaManagedBroadcastStatus.ACTIVE,
        nextSendAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      orderBy: [{ nextSendAt: 'asc' }, { createdAt: 'asc' }],
      take: MANAGED_BROADCAST_DUE_BATCH_SIZE,
      select: { id: true },
    });

    for (const row of dueRows) {
      await this.processManagedBroadcastOccurrence(
        row.id,
        reason,
        staleLockBefore,
        [PrismaManagedBroadcastStatus.ACTIVE],
      );
    }
  }

  private async sendManagedBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    options: {
      entityType: ManagedEntityType;
      source: AdminActionSource;
      resolveTargets?: (user: AuthUser) => Promise<ChatSummary[]>;
    },
  ): Promise<SendBroadcastResult> {
    const request = await this.prepareManagedBroadcastRequest(sourceChatId, user, body, {
      entityType: options.entityType,
      resolveTargets: options.resolveTargets,
    });

    if (options.entityType === 'chat') {
      return this.scheduleManagedBroadcast(sourceChatId, user, request, options.source);
    }

    return this.sendManagedBroadcastViaQueue(
      sourceChatId,
      user,
      request,
      options.entityType,
      options.source,
    );
  }

  private async prepareManagedBroadcastRequest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    options: {
      entityType: ManagedEntityType;
      resolveTargets?: (user: AuthUser) => Promise<ChatSummary[]>;
    },
  ): Promise<PreparedManagedBroadcastRequest> {
    await this.assertChatAdmin(sourceChatId, user.userId, options.entityType);
    await this.ensureEntityType(sourceChatId, user.userId, options.entityType);

    const parsed = sendBroadcastRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    let targetChatIds = [sourceChatId];
    if (parsed.data.applyToAllChats) {
      if (!options.resolveTargets) {
        throw new BadRequestException('Массовая рассылка по каналам пока недоступна.');
      }

      const availableTargets = await options.resolveTargets(user);
      targetChatIds = Array.from(
        new Set([
          sourceChatId,
          ...availableTargets
            .filter((chat) => chat.entityType === options.entityType)
            .map((chat) => chat.id),
        ]),
      );
    }

    return {
      payload: parsed.data,
      targetChatIds,
      normalizedSourceText: parsed.data.text.trim(),
    };
  }

  private async sendManagedBroadcastViaQueue(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<SendBroadcastResult> {
    const scheduledAt = this.parseManagedBroadcastSendAt(request.payload.sendAt, {
      required: false,
      sourceChatId,
      sentCount: 0,
    });
    const delayMs = scheduledAt ? scheduledAt.getTime() - Date.now() : 0;
    const cycleEnabled = request.payload.cycleEnabled;
    const cycleEveryHours = cycleEnabled ? request.payload.cycleEveryHours : 1;
    const cycleCount = cycleEnabled ? request.payload.cycleCount : 1;
    const cycleEveryMs = cycleEveryHours * ONE_HOUR_MS;
    const maxDelayWithCycles = delayMs + (cycleCount - 1) * cycleEveryMs;
    if (maxDelayWithCycles > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Все циклы должны укладываться в 14 дней от текущего момента.');
    }

    const imagePayload = await this.uploadManagedBroadcastImage(
      request.payload,
      entityType,
      sourceChatId,
      user.userId,
    );
    const sentChatIds: string[] = [];
    const failedChatIds: string[] = [];
    let firstSendError: unknown = null;

    for (const chatId of request.targetChatIds) {
      let chatFailed = false;
      for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
        const occurrenceDelayMs = delayMs + cycleIndex * cycleEveryMs;
        try {
          const message = await this.buildManagedBroadcastMessage(
            chatId,
            entityType,
            request.payload,
            request.normalizedSourceText,
            imagePayload,
          );
          if (occurrenceDelayMs === 0 && imagePayload) {
            await this.sendBroadcastImageMessageWithRetry(
              chatId,
              message.messageText,
              message.messageOptions,
            );
          } else {
            await this.maxClient.sendMessage(
              chatId,
              message.messageText,
              message.messageOptions,
              occurrenceDelayMs > 0 ? { delayMs: occurrenceDelayMs } : { immediate: true },
            );
          }
        } catch (error: unknown) {
          if (!firstSendError) {
            firstSendError = error;
          }
          chatFailed = true;
          this.logger.warn(
            {
              entityType,
              sourceChatId,
              targetChatId: chatId,
              actorUserId: user.userId,
              sendAt: scheduledAt?.toISOString() ?? null,
              cycleEnabled,
              cycleEveryHours,
              cycleCount,
              cycleIndex: cycleIndex + 1,
              err: error instanceof Error ? error.message : String(error),
            },
            'Broadcast message failed for target chat',
          );
          break;
        }
      }

      if (chatFailed) {
        failedChatIds.push(chatId);
      } else {
        sentChatIds.push(chatId);
      }
    }

    if (sentChatIds.length === 0 && failedChatIds.length > 0) {
      const fallbackMessage = 'Не удалось отправить рассылку.';
      const maxApiMessage = this.extractMaxApiErrorMessage(firstSendError);
      throw new BadRequestException(maxApiMessage || fallbackMessage);
    }

    const legacyCycleEveryDays = this.toLegacyCycleEveryDays(cycleEveryHours);
    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'SEND_BROADCAST',
        payload: {
          entityType,
          applyToAllChats: request.payload.applyToAllChats,
          targetChats: request.targetChatIds.length,
          sentChats: sentChatIds.length,
          failedChats: failedChatIds.length,
          sendAt: scheduledAt?.toISOString() ?? null,
          nextSendAt: scheduledAt?.toISOString() ?? null,
          cycleEnabled,
          cycleEveryHours,
          ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
          cycleCount,
          sentChatIds,
          failedChatIds,
          source,
        },
      },
    });

    return {
      sourceChatId,
      targetChats: request.targetChatIds.length,
      sentChats: sentChatIds.length,
      failedChats: failedChatIds.length,
      sentChatIds,
      failedChatIds,
      sendAt: scheduledAt?.toISOString() ?? null,
      nextSendAt: scheduledAt?.toISOString() ?? null,
      cycleEnabled,
      cycleEveryHours,
      ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
      cycleCount,
      scheduleId: null,
      scheduledOccurrences: 0,
    };
  }

  private async scheduleManagedBroadcast(
    sourceChatId: string,
    user: AuthUser,
    request: PreparedManagedBroadcastRequest,
    source: AdminActionSource,
  ): Promise<SendBroadcastResult> {
    const scheduledAt = this.parseManagedBroadcastSendAt(request.payload.sendAt, {
      required: false,
      sourceChatId,
      sentCount: 0,
    });
    const cycleEveryHours = request.payload.cycleEnabled ? request.payload.cycleEveryHours : 1;
    const cycleCount = request.payload.cycleEnabled ? request.payload.cycleCount : 1;
    const initialDelayMs = scheduledAt ? scheduledAt.getTime() - Date.now() : 0;
    const maxDelayWithCycles = initialDelayMs + (cycleCount - 1) * cycleEveryHours * ONE_HOUR_MS;
    if (maxDelayWithCycles > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Все циклы должны укладываться в 14 дней от текущего момента.');
    }

    const firstOccurrenceAt = scheduledAt ?? new Date();

    const created = await this.prisma.managedBroadcast.create({
      data: {
        sourceChatId,
        entityType: ChatEntityType.CHAT,
        actorUserId: user.userId,
        text: request.payload.text.trim(),
        textFormat: request.payload.textFormat,
        applyToAllChats: request.payload.applyToAllChats,
        targetChatIds: request.targetChatIds as Prisma.InputJsonValue,
        buttonEnabled: request.payload.buttonEnabled,
        buttonUrl: request.payload.buttonEnabled ? request.payload.buttonUrl.trim() : '',
        buttonText: request.payload.buttonEnabled
          ? request.payload.buttonText.trim() || 'Открыть'
          : 'Открыть',
        imageEnabled: request.payload.imageEnabled,
        imageBase64: request.payload.imageEnabled ? request.payload.imageBase64 : '',
        imageMimeType: request.payload.imageEnabled ? request.payload.imageMimeType : '',
        imageFileName: request.payload.imageEnabled ? request.payload.imageFileName : '',
        nextSendAt: firstOccurrenceAt,
        cycleEnabled: request.payload.cycleEnabled,
        cycleEveryHours,
        cycleCount,
        sentCount: 0,
        status: PrismaManagedBroadcastStatus.ACTIVE,
      },
    });
    await this.prisma.managedBroadcastDelivery.createMany({
      data: this.buildManagedBroadcastDeliveryRows(created.id, request.targetChatIds, 1, cycleCount),
    });

    let occurrence: BroadcastOccurrenceResult = {
      status: PrismaManagedBroadcastStatus.ACTIVE,
      currentOccurrence: 1,
      sentChatIds: [],
      failedChatIds: [],
      pendingChatIds: request.targetChatIds,
      canRetry: false,
      firstSendError: null,
      nextSendAt: firstOccurrenceAt,
    };

    if (!scheduledAt) {
      occurrence = await this.processManagedBroadcastOccurrence(
        created.id,
        'immediate',
        new Date(Date.now() - MANAGED_BROADCAST_LOCK_STALE_MS),
        [PrismaManagedBroadcastStatus.ACTIVE],
      );
    }

    const updated = await this.prisma.managedBroadcast.findUnique({
      where: { id: created.id },
    });
    if (!updated) {
      throw new BadRequestException('Рассылка не найдена.');
    }

    const legacyCycleEveryDays = this.toLegacyCycleEveryDays(cycleEveryHours);
    await this.prisma.auditLog.create({
      data: {
        chatId: sourceChatId,
        actorUserId: user.userId,
        action: 'SCHEDULE_BROADCAST',
        payload: {
          broadcastId: created.id,
          applyToAllChats: request.payload.applyToAllChats,
          targetChats: request.targetChatIds.length,
          sendAt: request.payload.sendAt,
          nextSendAt: updated.nextSendAt?.toISOString() ?? null,
          cycleEnabled: request.payload.cycleEnabled,
          cycleEveryHours,
          ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
          cycleCount,
          sentCount: updated.sentCount,
          source,
        },
      },
    });

    return {
      sourceChatId,
      targetChats: request.targetChatIds.length,
      sentChats: occurrence.sentChatIds.length,
      failedChats: occurrence.failedChatIds.length,
      sentChatIds: occurrence.sentChatIds,
      failedChatIds: occurrence.failedChatIds,
      sendAt: request.payload.sendAt,
      nextSendAt: updated.nextSendAt?.toISOString() ?? null,
      cycleEnabled: request.payload.cycleEnabled,
      cycleEveryHours,
      ...(legacyCycleEveryDays ? { cycleEveryDays: legacyCycleEveryDays } : {}),
      cycleCount,
      scheduleId: created.id,
      scheduledOccurrences: Math.max(0, cycleCount - updated.sentCount),
    };
  }

  private async processManagedBroadcastOccurrence(
    broadcastId: string,
    reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate',
    staleLockBefore: Date,
    allowedStatuses: PrismaManagedBroadcastStatus[],
  ): Promise<BroadcastOccurrenceResult> {
    const claimedAt = new Date();
    const claim = await this.prisma.managedBroadcast.updateMany({
      where: {
        id: broadcastId,
        status: { in: allowedStatuses },
        nextSendAt: { lte: claimedAt },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt: claimedAt,
      },
    });
    if (claim.count === 0) {
      const row = await this.prisma.managedBroadcast.findUnique({
        where: { id: broadcastId },
      });
      return {
        status: row?.status ?? PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence: row ? this.getCurrentManagedBroadcastOccurrence(row) : 1,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: row?.nextSendAt ?? null,
      };
    }

    const row = await this.prisma.managedBroadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!row || !row.nextSendAt || !allowedStatuses.includes(row.status)) {
      await this.prisma.managedBroadcast.updateMany({
        where: { id: broadcastId },
        data: { lockedAt: null },
      });
      return {
        status: row?.status ?? PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence: row ? this.getCurrentManagedBroadcastOccurrence(row) : 1,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: row?.nextSendAt ?? null,
      };
    }

    const currentOccurrence = this.getCurrentManagedBroadcastOccurrence(row);

    try {
      await this.reconcileStaleManagedBroadcastDeliveries(
        row.id,
        currentOccurrence,
        staleLockBefore,
      );

      const request: PreparedManagedBroadcastRequest = {
        payload: {
          text: row.text,
          textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
          applyToAllChats: row.applyToAllChats,
          buttonEnabled: row.buttonEnabled,
          buttonUrl: row.buttonUrl,
          buttonText: row.buttonText,
          imageEnabled: row.imageEnabled,
          imageBase64: row.imageBase64,
          imageMimeType: row.imageMimeType,
          imageFileName: row.imageFileName,
          sendAt: row.nextSendAt.toISOString(),
          cycleEnabled: row.cycleEnabled,
          cycleEveryHours: row.cycleEveryHours,
          cycleCount: row.cycleCount,
        },
        targetChatIds: this.parseManagedBroadcastTargetChatIds(row.targetChatIds),
        normalizedSourceText: row.text.trim(),
      };

      const sentChatIds: string[] = [];
      const failedChatIds: string[] = [];
      let firstSendError: unknown = null;
      const initialDeliveries = await this.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex: currentOccurrence,
        },
        orderBy: [{ targetChatId: 'asc' }],
      });

      if (initialDeliveries.some((delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED)) {
        return this.finalizeManagedBroadcastOccurrence(
          row,
          currentOccurrence,
          [],
          [],
          null,
        );
      }

      const imagePayload = await this.uploadManagedBroadcastImage(
        request.payload,
        'chat',
        row.sourceChatId,
        row.actorUserId,
      );

      for (const delivery of initialDeliveries) {
        if (delivery.status !== PrismaManagedBroadcastDeliveryStatus.PENDING) {
          continue;
        }

        const deliveryClaim = await this.prisma.managedBroadcastDelivery.updateMany({
          where: {
            id: delivery.id,
            status: PrismaManagedBroadcastDeliveryStatus.PENDING,
          },
          data: {
            status: PrismaManagedBroadcastDeliveryStatus.SENDING,
            lockedAt: claimedAt,
            attemptCount: { increment: 1 },
          },
        });
        if (deliveryClaim.count === 0) {
          continue;
        }

        try {
          const message = await this.buildManagedBroadcastMessage(
            delivery.targetChatId,
            'chat',
            request.payload,
            request.normalizedSourceText,
            imagePayload,
          );
          if (imagePayload) {
            await this.sendBroadcastImageMessageWithRetry(
              delivery.targetChatId,
              message.messageText,
              message.messageOptions,
            );
          } else {
            await this.maxClient.sendMessage(
              delivery.targetChatId,
              message.messageText,
              message.messageOptions,
              { immediate: true },
            );
          }

          sentChatIds.push(delivery.targetChatId);
          await this.prisma.managedBroadcastDelivery.update({
            where: { id: delivery.id },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              lockedAt: null,
              lastError: null,
            },
          });
        } catch (error: unknown) {
          if (!firstSendError) {
            firstSendError = error;
          }
          failedChatIds.push(delivery.targetChatId);
          this.logger.warn(
            {
              sourceChatId: row.sourceChatId,
              broadcastId: row.id,
              targetChatId: delivery.targetChatId,
              actorUserId: row.actorUserId,
              occurrenceIndex: currentOccurrence,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed broadcast delivery failed for target chat',
          );
          await this.prisma.managedBroadcastDelivery.update({
            where: { id: delivery.id },
            data: {
              status: PrismaManagedBroadcastDeliveryStatus.FAILED,
              lockedAt: null,
              lastError:
                this.extractMaxApiErrorMessage(error) ||
                (error instanceof Error && error.message.trim()
                  ? error.message
                  : 'Не удалось отправить сообщение.'),
            },
          });
        }
      }

      return this.finalizeManagedBroadcastOccurrence(
        row,
        currentOccurrence,
        sentChatIds,
        failedChatIds,
        firstSendError,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          broadcastId: row.id,
          sourceChatId: row.sourceChatId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Managed broadcast processing failed',
      );
      await this.prisma.managedBroadcast.update({
        where: { id: row.id },
        data: {
          status: PrismaManagedBroadcastStatus.FAILED,
          lastError:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'Не удалось обработать рассылку.',
          lockedAt: null,
        },
      });
      return {
        status: PrismaManagedBroadcastStatus.FAILED,
        currentOccurrence,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: true,
        firstSendError: error,
        nextSendAt: row.nextSendAt,
      };
    }
  }

  private async buildManagedBroadcastMessage(
    chatId: string,
    entityType: ManagedEntityType,
    payload: SendBroadcastRequest,
    normalizedSourceText: string,
    imagePayload?: Record<string, unknown>,
  ): Promise<{
    messageText: string;
    messageOptions:
      | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'textFormat'>
      | undefined;
  }> {
    const broadcastButtons = await this.resolveBroadcastButtons(chatId, entityType, {
      includeCustomButton: payload.buttonEnabled,
      customButtonText: payload.buttonText.trim(),
      customButtonUrl: payload.buttonUrl.trim(),
    });
    const shouldUseRichText =
      payload.textFormat === 'markdown' &&
      normalizedSourceText.length > 0 &&
      (entityType !== 'channel' || broadcastButtons.length > 0);
    const renderedText = shouldUseRichText
      ? renderSupportedMarkdownAsHtml(normalizedSourceText)
      : entityType === 'channel' && payload.textFormat === 'markdown'
        ? stripSupportedMarkdownToPlainText(normalizedSourceText)
        : normalizedSourceText;
    const messageText = renderedText || (payload.imageEnabled ? ' ' : '');
    const textFormat: MaxSendMessageOptions['textFormat'] = shouldUseRichText ? 'html' : undefined;
    const messageOptions =
      broadcastButtons.length > 0 || imagePayload || textFormat
        ? {
            ...(textFormat ? { textFormat } : {}),
            ...(broadcastButtons.length > 0 ? { buttons: broadcastButtons } : {}),
            ...(imagePayload ? { imagePayload } : {}),
          }
        : undefined;

    return {
      messageText,
      messageOptions,
    };
  }

  private async uploadManagedBroadcastImage(
    payload: SendBroadcastRequest,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (!payload.imageEnabled) {
      return undefined;
    }

    const imageMimeType = payload.imageMimeType.trim().toLowerCase();
    if (!imageMimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }
    const imageBuffer = this.decodeBroadcastImageBase64(payload.imageBase64);
    if (imageBuffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
    }

    try {
      return await this.maxClient.uploadImage(
        imageBuffer,
        this.resolveBroadcastImageFileName(payload.imageFileName, imageMimeType),
        imageMimeType,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          sourceChatId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Broadcast image upload failed',
      );
      throw new BadRequestException('Не удалось загрузить фото. Попробуйте другое изображение.');
    }
  }

  private parseManagedBroadcastSendAt(
    sendAt: string | null,
    options: {
      required: boolean;
      sourceChatId: string;
      sentCount: number;
    },
  ): Date | null {
    if (!sendAt) {
      if (options.required) {
        throw new BadRequestException('Укажите следующее время отправки.');
      }
      return null;
    }

    const scheduledAt = new Date(sendAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Некорректное время рассылки.');
    }
    const calculatedDelayMs = scheduledAt.getTime() - Date.now();
    if (calculatedDelayMs < BROADCAST_MIN_DELAY_MS) {
      const message =
        options.sentCount > 0
          ? 'Следующую отправку можно поставить минимум через 30 секунд.'
          : 'Укажите время рассылки минимум через 30 секунд.';
      throw new BadRequestException(message);
    }
    if (calculatedDelayMs > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Максимальный таймер рассылки: 14 дней.');
    }
    return scheduledAt;
  }

  private toLegacyCycleEveryDays(cycleEveryHours: number): number | undefined {
    return cycleEveryHours % 24 === 0 ? cycleEveryHours / 24 : undefined;
  }

  private parseManagedBroadcastTargetChatIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  }

  private normalizeBroadcastTextFormat(value: string): BroadcastTextFormat {
    return value === 'markdown' ? 'markdown' : 'plain';
  }

  private getCurrentManagedBroadcastOccurrence(row: PersistedManagedBroadcast): number {
    return Math.min(Math.max(1, row.sentCount + 1), Math.max(1, row.cycleCount));
  }

  private buildManagedBroadcastDeliveryRows(
    broadcastId: string,
    targetChatIds: string[],
    fromOccurrenceIndex: number,
    cycleCount: number,
  ): Prisma.ManagedBroadcastDeliveryCreateManyInput[] {
    const rows: Prisma.ManagedBroadcastDeliveryCreateManyInput[] = [];
    for (let occurrenceIndex = fromOccurrenceIndex; occurrenceIndex <= cycleCount; occurrenceIndex += 1) {
      for (const targetChatId of targetChatIds) {
        rows.push({
          broadcastId,
          occurrenceIndex,
          targetChatId,
          status: PrismaManagedBroadcastDeliveryStatus.PENDING,
        });
      }
    }
    return rows;
  }

  private async reconcileStaleManagedBroadcastDeliveries(
    broadcastId: string,
    occurrenceIndex: number,
    staleLockBefore: Date,
  ): Promise<void> {
    await this.prisma.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId,
        occurrenceIndex,
        status: PrismaManagedBroadcastDeliveryStatus.SENDING,
        lockedAt: { lt: staleLockBefore },
      },
      data: {
        status: PrismaManagedBroadcastDeliveryStatus.FAILED,
        lockedAt: null,
        lastError:
          'Прошлая попытка была прервана после старта отправки. Проверьте чат и повторите только ошибочные доставки.',
      },
    });
  }

  private async finalizeManagedBroadcastOccurrence(
    row: PersistedManagedBroadcast,
    currentOccurrence: number,
    sentChatIds: string[],
    failedChatIds: string[],
    firstSendError: unknown,
  ): Promise<BroadcastOccurrenceResult> {
    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: currentOccurrence,
      },
    });
    const deliveredChats = deliveries.filter(
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
    );
    const failedChats = deliveries.filter(
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
    );
    const pendingChats = deliveries.filter(
      (delivery) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    );
    const canRetry = failedChats.length > 0;

    if (failedChats.length > 0) {
      const status =
        deliveredChats.length > 0
          ? PrismaManagedBroadcastStatus.PARTIAL
          : PrismaManagedBroadcastStatus.FAILED;
      const failureMessage = this.buildManagedBroadcastFailureMessage(
        failedChats.length,
        firstSendError,
      );
      await this.prisma.managedBroadcast.update({
        where: { id: row.id },
        data: {
          status,
          lastError: failureMessage,
          lockedAt: null,
        },
      });

      return {
        status,
        currentOccurrence,
        sentChatIds:
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery) => delivery.targetChatId),
        failedChatIds:
          failedChatIds.length > 0
            ? failedChatIds
            : failedChats.map((delivery) => delivery.targetChatId),
        pendingChatIds: pendingChats.map((delivery) => delivery.targetChatId),
        canRetry,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

    if (pendingChats.length > 0) {
      await this.prisma.managedBroadcast.update({
        where: { id: row.id },
        data: {
          status: PrismaManagedBroadcastStatus.ACTIVE,
          lastError: null,
          lockedAt: null,
        },
      });
      return {
        status: PrismaManagedBroadcastStatus.ACTIVE,
        currentOccurrence,
        sentChatIds:
          sentChatIds.length > 0
            ? sentChatIds
            : deliveredChats.map((delivery) => delivery.targetChatId),
        failedChatIds: [],
        pendingChatIds: pendingChats.map((delivery) => delivery.targetChatId),
        canRetry: false,
        firstSendError,
        nextSendAt: row.nextSendAt,
      };
    }

    const nextSentCount = currentOccurrence;
    const isComplete = nextSentCount >= row.cycleCount;
    const nextSendAt = isComplete
      ? null
      : new Date(row.nextSendAt!.getTime() + row.cycleEveryHours * ONE_HOUR_MS);
    await this.prisma.managedBroadcast.update({
      where: { id: row.id },
      data: {
        sentCount: nextSentCount,
        nextSendAt,
        status: isComplete
          ? PrismaManagedBroadcastStatus.COMPLETED
          : PrismaManagedBroadcastStatus.ACTIVE,
        lastError: null,
        lockedAt: null,
      },
    });
    return {
      status: isComplete
        ? PrismaManagedBroadcastStatus.COMPLETED
        : PrismaManagedBroadcastStatus.ACTIVE,
      currentOccurrence,
      sentChatIds:
        sentChatIds.length > 0
          ? sentChatIds
          : deliveredChats.map((delivery) => delivery.targetChatId),
      failedChatIds: [],
      pendingChatIds: [],
      canRetry: false,
      firstSendError,
      nextSendAt,
    };
  }

  private buildManagedBroadcastFailureMessage(failedChats: number, firstSendError: unknown): string {
    return (
      this.extractMaxApiErrorMessage(firstSendError) ||
      (firstSendError instanceof Error && firstSendError.message.trim()
        ? firstSendError.message
        : `Не удалось отправить в ${failedChats} чат(ов).`)
    );
  }

  private async getManagedBroadcastDeliverySnapshots(
    rows: PersistedManagedBroadcast[],
  ): Promise<Map<string, ManagedBroadcastDeliverySnapshot>> {
    if (rows.length === 0) {
      return new Map();
    }

    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        OR: rows.map((row) => ({
          broadcastId: row.id,
          occurrenceIndex: this.getCurrentManagedBroadcastOccurrence(row),
        })),
      },
      select: {
        broadcastId: true,
        status: true,
      },
    });

    const grouped = new Map<string, PersistedManagedBroadcastDelivery[]>();
    for (const delivery of deliveries) {
      const current = grouped.get(delivery.broadcastId) ?? [];
      current.push(delivery as PersistedManagedBroadcastDelivery);
      grouped.set(delivery.broadcastId, current);
    }

    return new Map(
      rows.map((row) => [row.id, this.createManagedBroadcastDeliverySnapshot(row, grouped.get(row.id) ?? [])]),
    );
  }

  private async getManagedBroadcastDeliverySnapshot(
    row: PersistedManagedBroadcast,
  ): Promise<ManagedBroadcastDeliverySnapshot> {
    const deliveries = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: row.id,
        occurrenceIndex: this.getCurrentManagedBroadcastOccurrence(row),
      },
    });
    return this.createManagedBroadcastDeliverySnapshot(row, deliveries);
  }

  private createManagedBroadcastDeliverySnapshot(
    row: PersistedManagedBroadcast,
    deliveries: PersistedManagedBroadcastDelivery[],
  ): ManagedBroadcastDeliverySnapshot {
    return {
      currentOccurrence: this.getCurrentManagedBroadcastOccurrence(row),
      deliveredChats: deliveries.filter(
        (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
      ).length,
      failedChats: deliveries.filter(
        (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
      ).length,
      pendingChats: deliveries.filter(
        (delivery) =>
          delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
          delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
      ).length,
      canRetry:
        row.status === PrismaManagedBroadcastStatus.PARTIAL ||
        row.status === PrismaManagedBroadcastStatus.FAILED,
    };
  }

  private mapManagedBroadcastSummary(
    row: PersistedManagedBroadcast,
    snapshot?: ManagedBroadcastDeliverySnapshot,
  ): ManagedBroadcastSummary {
    const targetChatIds = this.parseManagedBroadcastTargetChatIds(row.targetChatIds);
    const normalizedText = row.text.replace(/\s+/gu, ' ').trim();
    const resolvedSnapshot =
      snapshot ??
      this.createManagedBroadcastDeliverySnapshot(row, []);

    return {
      id: row.id,
      status: row.status,
      textPreview: normalizedText
        ? normalizedText.slice(0, 160)
        : row.imageEnabled
          ? 'Фото без текста'
          : 'Пустая рассылка',
      textLength: row.text.length,
      applyToAllChats: row.applyToAllChats,
      targetChats: targetChatIds.length,
      hasImage: row.imageEnabled,
      buttonEnabled: row.buttonEnabled,
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      cycleEnabled: row.cycleEnabled,
      cycleEveryHours: row.cycleEveryHours,
      cycleCount: row.cycleCount,
      sentCount: row.sentCount,
      currentOccurrence: resolvedSnapshot.currentOccurrence,
      deliveredChats: resolvedSnapshot.deliveredChats,
      failedChats: resolvedSnapshot.failedChats,
      pendingChats: resolvedSnapshot.pendingChats,
      canRetry: resolvedSnapshot.canRetry,
      remainingCount: Math.max(0, row.cycleCount - row.sentCount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastError: row.lastError && row.lastError.trim() ? row.lastError : null,
    };
  }

  private mapManagedBroadcastDetails(
    row: PersistedManagedBroadcast,
    snapshot?: ManagedBroadcastDeliverySnapshot,
  ): ManagedBroadcastDetails {
    const targetChatIds = this.parseManagedBroadcastTargetChatIds(row.targetChatIds);
    const resolvedSnapshot =
      snapshot ??
      this.createManagedBroadcastDeliverySnapshot(row, []);

    return {
      id: row.id,
      status: row.status,
      text: row.text,
      textFormat: this.normalizeBroadcastTextFormat(row.textFormat),
      applyToAllChats: row.applyToAllChats,
      targetChatIds,
      buttonEnabled: row.buttonEnabled,
      buttonUrl: row.buttonUrl,
      buttonText: row.buttonText,
      imageEnabled: row.imageEnabled,
      imageBase64: row.imageBase64,
      imageMimeType: row.imageMimeType,
      imageFileName: row.imageFileName,
      nextSendAt: row.nextSendAt?.toISOString() ?? null,
      cycleEnabled: row.cycleEnabled,
      cycleEveryHours: row.cycleEveryHours,
      cycleCount: row.cycleCount,
      sentCount: row.sentCount,
      currentOccurrence: resolvedSnapshot.currentOccurrence,
      deliveredChats: resolvedSnapshot.deliveredChats,
      failedChats: resolvedSnapshot.failedChats,
      pendingChats: resolvedSnapshot.pendingChats,
      canRetry: resolvedSnapshot.canRetry,
      remainingCount: Math.max(0, row.cycleCount - row.sentCount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastError: row.lastError && row.lastError.trim() ? row.lastError : null,
    };
  }

  private async sendBroadcastImageMessageWithRetry(
    chatId: string,
    text: string,
    options:
      | Pick<MaxSendMessageOptions, 'button' | 'buttons' | 'imagePayload' | 'textFormat'>
      | undefined,
  ): Promise<void> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.maxClient.sendMessage(chatId, text, options, { immediate: true });
        return;
      } catch (error: unknown) {
        lastError = error;
        if (!this.isAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await this.sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  private isAttachmentNotReadyError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 400) {
      return false;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractMaxApiErrorMessage(error: unknown): string {
    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    if (!responseData || typeof responseData !== 'object') {
      return '';
    }

    const row = responseData as Record<string, unknown>;
    const message = row.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }

    const code = row.code;
    if (typeof code === 'string' && code.trim()) {
      return `Ошибка MAX API: ${code.trim()}`;
    }

    return '';
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
    if (!normalized) {
      throw new BadRequestException('Добавьте фото для рассылки.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(normalized, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Не удалось прочитать фото.');
    }

    return imageBuffer;
  }

  private decodeRulesImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
    if (!normalized) {
      throw new BadRequestException('Добавьте фото для правил.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(normalized, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото правил.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Не удалось прочитать фото правил.');
    }

    return imageBuffer;
  }

  private resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    if (mimeType === 'image/png') {
      return 'broadcast-image.png';
    }
    if (mimeType === 'image/webp') {
      return 'broadcast-image.webp';
    }
    if (mimeType === 'image/gif') {
      return 'broadcast-image.gif';
    }

    return 'broadcast-image.jpg';
  }

  private async resolveBroadcastButtons(
    chatId: string,
    entityType: ManagedEntityType,
    options: {
      includeCustomButton: boolean;
      customButtonText: string;
      customButtonUrl: string;
    },
  ): Promise<MaxMessageButton[][]> {
    const rows: MaxMessageButton[][] = [];

    if (options.includeCustomButton) {
      rows.push([
        {
          type: 'link',
          text: options.customButtonText,
          url: options.customButtonUrl,
        },
      ]);
    }

    if (entityType !== 'channel') {
      return rows;
    }

    const channelSettings = await this.prisma.channelSettings.upsert({
      where: { chatId },
      create: { chatId },
      update: {},
      select: {
        autoPostButtonsMode: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: true,
        commentsEnabled: true,
      },
    });
    const threadId = randomUUID();

    if (
      channelSettings.autoPostButtonsMode === 'COMMENTS' ||
      channelSettings.autoPostButtonsMode === 'BOTH' ||
      (channelSettings.autoPostButtonsMode === 'OFF' && channelSettings.commentsEnabled)
    ) {
      rows.push([this.buildChannelDialogButton(chatId, 'comments', threadId, '💬 Комментарии')]);
    }

    if (channelSettings.postSuggestionsEnabled) {
      rows.push([
        this.buildChannelDialogButton(
          chatId,
          'suggest',
          threadId,
          channelSettings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
        ),
      ]);
    }

    return rows;
  }

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
  ): MaxMessageButton {
    const launchUrl = this.buildChannelDialogLaunchUrl(chatId, type, threadId);
    const webAppUrl = this.buildChannelDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId();

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://maxim.play-team.ru'}/app/`,
    };
  }

  private resolveRulesImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    if (mimeType === 'image/png') {
      return 'chat-rules.png';
    }
    if (mimeType === 'image/webp') {
      return 'chat-rules.webp';
    }
    if (mimeType === 'image/gif') {
      return 'chat-rules.gif';
    }

    return 'chat-rules.jpg';
  }

  private async publishRulesMessageWithRetry(
    chatId: string,
    text: string,
    options: Pick<MaxSendMessageOptions, 'imagePayload'> | undefined,
  ): Promise<{ messageId: string; url: string | null }> {
    let lastError: unknown = null;
    const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, text, options);
      } catch (error: unknown) {
        lastError = error;
        if (
          !options?.imagePayload ||
          !this.isAttachmentNotReadyError(error) ||
          attempt >= attempts
        ) {
          throw error;
        }
        const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
        await this.sleep(delayMs);
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Rules publish failed without error details');
  }

  private normalizeChatRulesDraft(value: UpdateChatRulesRequest): UpdateChatRulesRequest {
    const normalizedImageBase64 = value.imageBase64.trim();
    if (!normalizedImageBase64) {
      return {
        text: value.text,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: value.autoTextEnabled,
      };
    }

    return {
      text: value.text,
      imageBase64: normalizedImageBase64,
      imageMimeType: value.imageMimeType.trim(),
      imageFileName: value.imageFileName.trim(),
      autoTextEnabled: value.autoTextEnabled,
    };
  }

  private async upsertChatRules(chatId: string): Promise<PersistedChatRules> {
    return this.prisma.chatRules.upsert({
      where: { chatId },
      create: {
        chatId,
      },
      update: {},
    });
  }

  private mapChatRules(rules: PersistedChatRules): ChatRules {
    return chatRulesSchema.parse({
      text: rules.text,
      imageBase64: rules.imageBase64,
      imageMimeType: rules.imageMimeType,
      imageFileName: rules.imageFileName,
      autoTextEnabled: rules.autoTextEnabled,
      publishedMessageId: rules.publishedMessageId,
      publishedUrl: rules.publishedUrl,
      publishedAt: rules.publishedAt ? rules.publishedAt.toISOString() : null,
    });
  }

  private async hydratePublishedRulesUrl(
    chatId: string,
    rules: PersistedChatRules,
  ): Promise<PersistedChatRules> {
    const currentUrl = this.normalizePublishedRulesUrl(rules.publishedUrl);
    if (currentUrl || !rules.publishedMessageId?.trim()) {
      return {
        ...rules,
        publishedUrl: currentUrl,
      };
    }

    let resolvedUrl: string | null = null;
    try {
      resolvedUrl = this.normalizePublishedRulesUrl(
        await this.maxClient.resolveMessageLink(rules.publishedMessageId),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: rules.publishedMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover published chat rules url',
      );
      return rules;
    }

    if (!resolvedUrl) {
      return rules;
    }

    await this.prisma.chatRules.update({
      where: { chatId },
      data: {
        publishedUrl: resolvedUrl,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return {
      ...rules,
      publishedUrl: resolvedUrl,
    };
  }

  private normalizePublishedRulesUrl(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private async getManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const poll = await this.upsertManagedPoll(chatId);
    const hydrated = await this.hydrateManagedPollPublishedUrl(chatId, poll);
    return this.mapManagedPoll(hydrated);
  }

  private async updateManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
    source: AdminActionSource,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const parsed = updateManagedPollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const current = await this.upsertManagedPoll(chatId);
    if (current.status === PrismaManagedPollStatus.ACTIVE) {
      throw new BadRequestException('Сначала закройте активный опрос.');
    }

    const normalizedDraft = normalizeManagedPollDraft(parsed.data.question, parsed.data.options);
    const currentDraft = normalizeManagedPollDraft(
      current.question,
      this.readManagedPollOptions(current.options),
    );
    const hasChanges =
      normalizedDraft.question !== currentDraft.question ||
      normalizedDraft.options.length !== currentDraft.options.length ||
      normalizedDraft.options.some((option, index) => option !== currentDraft.options[index]);

    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        question: normalizedDraft.question,
        options: normalizedDraft.options as Prisma.InputJsonValue,
        ...(current.status === PrismaManagedPollStatus.CLOSED && hasChanges
          ? {
              status: PrismaManagedPollStatus.DRAFT,
              publishedMessageId: null,
              publishedUrl: null,
              publishedAt: null,
              closedAt: null,
            }
          : {}),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_UPDATE,
        payload: {
          entityType,
          questionLength: normalizedDraft.question.length,
          optionsCount: normalizedDraft.options.length,
          statusBefore: current.status,
          statusAfter:
            current.status === PrismaManagedPollStatus.CLOSED && hasChanges
              ? PrismaManagedPollStatus.DRAFT
              : current.status,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapManagedPoll(updated);
  }

  private async publishManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const current = await this.upsertManagedPoll(chatId);
    if (current.status === PrismaManagedPollStatus.ACTIVE && current.publishedMessageId?.trim()) {
      throw new BadRequestException('Сначала закройте активный опрос.');
    }

    let normalizedDraft: { question: string; options: string[] };
    try {
      normalizedDraft = validateManagedPollForPublish(
        current.question,
        this.readManagedPollOptions(current.options),
      );
    } catch (error: unknown) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Опрос заполнен некорректно.',
      );
    }

    const nextVersion = Math.max(0, current.activeVersion) + 1;
    const zeroResults = buildManagedPollOptionSummaries(
      normalizedDraft.options,
      normalizedDraft.options.map(() => 0),
    );
    const buttons = buildManagedPollButtons(
      current.id,
      nextVersion,
      normalizedDraft.options,
      zeroResults.optionResults,
    );
    const messageText = buildManagedPollMessageText(
      normalizedDraft.question,
      zeroResults.optionResults,
      'ACTIVE',
    );

    let published: { messageId: string; url: string | null };
    try {
      published = await this.maxClient.sendMessageImmediateWithResolvedLink(chatId, messageText, {
        buttons,
      });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать опрос.');
    }

    const publishedAt = new Date();
    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        question: normalizedDraft.question,
        options: normalizedDraft.options as Prisma.InputJsonValue,
        status: PrismaManagedPollStatus.ACTIVE,
        activeVersion: nextVersion,
        publishedMessageId: published.messageId,
        publishedUrl: this.normalizePublishedRulesUrl(published.url),
        publishedAt,
        closedAt: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_PUBLISH,
        payload: {
          entityType,
          messageId: published.messageId,
          url: published.url,
          questionLength: normalizedDraft.question.length,
          optionsCount: normalizedDraft.options.length,
          activeVersion: nextVersion,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapManagedPoll(updated);
  }

  private async closeManagedPoll(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: AdminActionSource,
  ): Promise<ManagedPoll> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const current = await this.upsertManagedPoll(chatId);
    const publishedMessageId = current.publishedMessageId?.trim() ?? '';
    if (current.status !== PrismaManagedPollStatus.ACTIVE || !publishedMessageId) {
      throw new BadRequestException('Активного опроса нет.');
    }

    const normalizedDraft = normalizeManagedPollDraft(
      current.question,
      this.readManagedPollOptions(current.options),
    );
    const voteCounts = await this.loadManagedPollVoteCounts(
      current.id,
      current.activeVersion,
      normalizedDraft.options.length,
    );
    const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);
    const messageText = buildManagedPollMessageText(
      normalizedDraft.question,
      summary.optionResults,
      'CLOSED',
    );

    try {
      await this.maxClient.editMessageInlineKeyboard(chatId, publishedMessageId, messageText);
    } catch (error: unknown) {
      if (!this.isMaxMessageMissingError(error)) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось закрыть опрос.');
      }
    }

    const closedAt = new Date();
    const updated = await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        status: PrismaManagedPollStatus.CLOSED,
        closedAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: MANAGED_POLL_ACTION_CLOSE,
        payload: {
          entityType,
          messageId: publishedMessageId,
          activeVersion: current.activeVersion,
          totalVotes: summary.totalVotes,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return this.mapManagedPoll(updated);
  }

  private async upsertManagedPoll(chatId: string): Promise<PersistedManagedPoll> {
    return this.prisma.managedPoll.upsert({
      where: { chatId },
      create: {
        chatId,
      },
      update: {},
    });
  }

  private async mapManagedPoll(poll: PersistedManagedPoll): Promise<ManagedPoll> {
    const normalizedDraft = normalizeManagedPollDraft(
      poll.question,
      this.readManagedPollOptions(poll.options),
    );
    const voteCounts =
      poll.status === PrismaManagedPollStatus.ACTIVE ||
      poll.status === PrismaManagedPollStatus.CLOSED
        ? await this.loadManagedPollVoteCounts(
            poll.id,
            poll.activeVersion,
            normalizedDraft.options.length,
          )
        : normalizedDraft.options.map(() => 0);
    const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);

    return managedPollSchema.parse({
      question: normalizedDraft.question,
      options: normalizedDraft.options,
      status: poll.status,
      activeVersion: poll.activeVersion,
      publishedMessageId: poll.publishedMessageId?.trim() || null,
      publishedUrl: this.normalizePublishedRulesUrl(poll.publishedUrl),
      publishedAt: poll.publishedAt ? poll.publishedAt.toISOString() : null,
      closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
      totalVotes: summary.totalVotes,
      optionResults: summary.optionResults,
    });
  }

  private async hydrateManagedPollPublishedUrl(
    chatId: string,
    poll: PersistedManagedPoll,
  ): Promise<PersistedManagedPoll> {
    const currentUrl = this.normalizePublishedRulesUrl(poll.publishedUrl);
    if (currentUrl || !poll.publishedMessageId?.trim()) {
      return {
        ...poll,
        publishedUrl: currentUrl,
      };
    }

    let resolvedUrl: string | null = null;
    try {
      resolvedUrl = this.normalizePublishedRulesUrl(
        await this.maxClient.resolveMessageLink(poll.publishedMessageId),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: poll.publishedMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover published managed poll url',
      );
      return poll;
    }

    if (!resolvedUrl) {
      return poll;
    }

    await this.prisma.managedPoll.update({
      where: { chatId },
      data: {
        publishedUrl: resolvedUrl,
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return {
      ...poll,
      publishedUrl: resolvedUrl,
    };
  }

  private readManagedPollOptions(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string');
  }

  private async loadManagedPollVoteCounts(
    pollId: string,
    pollVersion: number,
    optionCount: number,
  ): Promise<number[]> {
    const counts = Array.from({ length: optionCount }, () => 0);
    const votes = await this.prisma.managedPollVote.findMany({
      where: {
        pollId,
        pollVersion,
      },
      select: {
        optionIndex: true,
      },
    });

    for (const vote of votes) {
      if (vote.optionIndex >= 0 && vote.optionIndex < counts.length) {
        counts[vote.optionIndex] += 1;
      }
    }

    return counts;
  }

  private resolveChannelDialogIntroText(
    settings: ChannelSettings,
    dialogType: ChannelDialogType,
  ): string | null {
    const value =
      dialogType === 'suggest' ? settings.postSuggestionsText : settings.commentsMessageText;
    const normalized = value.trim();
    return normalized || null;
  }

  private isMaxMessageMissingError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return true;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return normalized.includes('not found') || normalized.includes('message_not_found');
  }

  private shouldRecreateChannelEngagementMessage(error: unknown): boolean {
    if (this.isMaxMessageMissingError(error)) {
      return true;
    }

    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 400 && status !== 403) {
      return false;
    }

    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(responseData ?? '').toLowerCase();
    return (
      normalized.includes('edit') ||
      normalized.includes('update') ||
      normalized.includes('too old') ||
      normalized.includes('24') ||
      normalized.includes("can't be edited") ||
      normalized.includes('cannot edit') ||
      normalized.includes('cant edit') ||
      normalized.includes('message.not.updated')
    );
  }

  async getLogsDashboard(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<LogsDashboardResponse> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = logsDashboardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, title: true },
    });

    const membershipRows = await this.prisma.$queryRaw<
      Array<{ joined_users: unknown; left_users: unknown }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE normalized_payload->>'type' = 'user_added') AS joined_users,
        COUNT(*) FILTER (WHERE normalized_payload->>'type' = 'user_removed') AS left_users
      FROM webhook_events
      WHERE normalized_payload->'message'->>'chatId' = ${chatId}
        AND normalized_payload->>'type' IN ('user_added', 'user_removed')
        AND created_at >= ${from}
        AND created_at <= ${now}
    `;

    const violationsWhere: Prisma.ModerationEventWhereInput = {
      chatId,
      createdAt: { gte: from, lte: now },
      OR: [
        {
          action: {
            in: ['WARN', 'DELETE_MESSAGE', 'KICK', 'BAN'],
          },
        },
        {
          action: SanctionAction.NONE,
          ruleCode: 'MANUAL_UNBAN',
        },
      ],
    };

    const [
      warnCount,
      deleteMessageCount,
      kickCount,
      banCount,
      unbanCount,
      affectedUsers,
      violationRows,
    ] = await Promise.all([
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'WARN',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'DELETE_MESSAGE',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'KICK',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: 'BAN',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.count({
        where: {
          chatId,
          action: SanctionAction.NONE,
          ruleCode: 'MANUAL_UNBAN',
          createdAt: { gte: from, lte: now },
        },
      }),
      this.prisma.moderationEvent.findMany({
        where: violationsWhere,
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.moderationEvent.findMany({
        where: violationsWhere,
        orderBy: { createdAt: 'desc' },
        take: LOGS_DASHBOARD_VIOLATIONS_LIMIT,
      }),
    ]);
    const userDisplayNames = await this.resolveUserDisplayNames(
      chatId,
      violationRows.map((row) => row.userId),
    );

    const membershipSource = membershipRows[0] ?? { joined_users: 0, left_users: 0 };
    const joinedUsers = this.toSafeInteger(membershipSource.joined_users);
    const leftUsers = this.toSafeInteger(membershipSource.left_users);
    const response: LogsDashboardResponse = {
      chat: {
        id: chatId,
        title: chat?.title?.trim() || 'Чат без названия',
      },
      period: {
        range: parsed.data.range,
        from: from.toISOString(),
        to: now.toISOString(),
      },
      membership: {
        joinedUsers,
        leftUsers,
        netUsers: joinedUsers - leftUsers,
      },
      violationsSummary: {
        warn: warnCount,
        deleteMessage: deleteMessageCount,
        kick: kickCount,
        ban: banCount,
        unban: unbanCount,
        affectedUsers: affectedUsers.length,
        total: warnCount + deleteMessageCount + kickCount + banCount + unbanCount,
      },
      violations: violationRows.map((row) => ({
        id: row.id,
        action: row.action,
        ruleCode: row.ruleCode,
        userId: row.userId,
        userDisplayName: userDisplayNames.get(row.userId) ?? null,
        createdAt: row.createdAt.toISOString(),
        maskedExcerpt: row.maskedExcerpt,
        metadata:
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null,
      })),
    };

    return logsDashboardResponseSchema.parse(response);
  }

  async applyManualModerationAction(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ManualModerationActionResult> {
    await this.assertChatAdmin(chatId, user.userId);
    const targetUserId = targetUserIdRaw.trim();
    if (!targetUserId) {
      throw new BadRequestException('User ID is required');
    }
    if (targetUserId === user.userId) {
      throw new BadRequestException('Нельзя применять это действие к своему аккаунту.');
    }

    const parsed = manualModerationActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const metadataBase = {
      source,
      initiatedByUserId: user.userId,
    } as const;

    if (parsed.data.action === 'KICK') {
      await this.maxClient.cancelScheduledUnban(chatId, targetUserId);

      try {
        await this.maxClient.kickMember(chatId, targetUserId, { immediate: true });
      } catch (error: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось удалить участника из чата.');
      }

      await this.recordManualModerationAction({
        chatId,
        targetUserId,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_KICK',
        sanctionAction: SanctionAction.KICK,
        auditAction: 'MANUAL_KICK_MEMBER',
        metadata: {
          ...metadataBase,
          reason: 'Ручное удаление участника через miniapp',
        },
        auditPayload: {
          userId: targetUserId,
          source,
        },
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'KICK',
        userId: targetUserId,
        banDurationHours: null,
        unbanScheduledAt: null,
        message: 'Участник удалён из чата.',
      });
    }

    if (parsed.data.action === 'BAN') {
      const banDurationHours = parsed.data.banDurationHours;
      if (!banDurationHours) {
        throw new BadRequestException('Укажите длительность бана в часах.');
      }
      const unbanScheduledAt = new Date(Date.now() + banDurationHours * ONE_HOUR_MS);

      try {
        await this.maxClient.banMember(chatId, targetUserId, { immediate: true });
        try {
          await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
          await this.maxClient.unbanMember(chatId, targetUserId, {
            delayMs: banDurationHours * ONE_HOUR_MS,
          });
        } catch (scheduleError: unknown) {
          try {
            await this.maxClient.unbanMember(chatId, targetUserId, { immediate: true });
          } catch (rollbackError: unknown) {
            this.logger.warn(
              {
                chatId,
                userId: targetUserId,
                err: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              },
              'Failed to rollback manual ban after scheduling error',
            );
          }

          throw scheduleError;
        }
      } catch (error: unknown) {
        const maxApiMessage = this.extractMaxApiErrorMessage(error);
        throw new BadRequestException(maxApiMessage || 'Не удалось применить временный бан.');
      }

      await this.recordManualModerationAction({
        chatId,
        targetUserId,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_BAN',
        sanctionAction: SanctionAction.BAN,
        auditAction: 'MANUAL_BAN_MEMBER',
        metadata: {
          ...metadataBase,
          reason: 'Ручной бан участника через miniapp',
          banDurationHours,
          unbanScheduledAt: unbanScheduledAt.toISOString(),
          mode: 'MAX_BLOCK',
        },
        auditPayload: {
          userId: targetUserId,
          banDurationHours,
          unbanScheduledAt: unbanScheduledAt.toISOString(),
          source,
        },
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'BAN',
        userId: targetUserId,
        banDurationHours,
        unbanScheduledAt: unbanScheduledAt.toISOString(),
        message: `Участник забанен на ${banDurationHours}ч. Авторазбан запланирован.`,
      });
    }

    await this.maxClient.cancelScheduledUnban(chatId, targetUserId);

    try {
      await this.maxClient.unbanMember(chatId, targetUserId, { immediate: true });
    } catch (error: unknown) {
      const maxApiMessage = this.extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось вернуть участника в чат.');
    }

    await this.recordManualModerationAction({
      chatId,
      targetUserId,
      actorUserId: user.userId,
      ruleCode: 'MANUAL_UNBAN',
      sanctionAction: SanctionAction.NONE,
      auditAction: 'MANUAL_UNBAN_MEMBER',
      metadata: {
        ...metadataBase,
        reason: 'Ручной разбан участника через miniapp',
        mode: 'MAX_UNBLOCK',
      },
      auditPayload: {
        userId: targetUserId,
        source,
      },
    });

    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'UNBAN',
      userId: targetUserId,
      banDurationHours: null,
      unbanScheduledAt: null,
      message: 'Участник возвращён в чат и разблокирован.',
    });
  }

  private async recordManualModerationAction(params: {
    chatId: string;
    targetUserId: string;
    actorUserId: string;
    ruleCode: 'MANUAL_KICK' | 'MANUAL_BAN' | 'MANUAL_UNBAN';
    sanctionAction: SanctionAction;
    auditAction: 'MANUAL_KICK_MEMBER' | 'MANUAL_BAN_MEMBER' | 'MANUAL_UNBAN_MEMBER';
    metadata: Record<string, unknown>;
    auditPayload: Record<string, unknown>;
  }) {
    const {
      chatId,
      targetUserId,
      actorUserId,
      ruleCode,
      sanctionAction,
      auditAction,
      metadata,
      auditPayload,
    } = params;

    await this.prisma.$transaction([
      this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: targetUserId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode,
          action: sanctionAction,
          operator: Operator.ADMIN,
          metadata: metadata as Prisma.InputJsonValue,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId,
          action: auditAction,
          payload: auditPayload as Prisma.InputJsonValue,
        },
      }),
    ]);
  }

  async getEvents(chatId: string, user: AuthUser, query: unknown): Promise<ModerationEvent[]> {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = dateRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : undefined;
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined;

    const rows = await this.prisma.moderationEvent.findMany({
      where: {
        chatId,
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (parsed.data.page - 1) * parsed.data.limit,
      take: parsed.data.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      eventType: row.eventType,
      ruleCode: row.ruleCode,
      action: row.action,
      maskedExcerpt: row.maskedExcerpt,
      score: row.score,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
      operator: row.operator,
    }));
  }

  async addAdmin(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addAdminRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
      },
      update: {},
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: parsed.data.userId,
        },
      },
      create: {
        chatId,
        userId: parsed.data.userId,
      },
      update: {},
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_ADMIN',
        payload: {
          userId: parsed.data.userId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeAdmin(chatId: string, user: AuthUser, targetUserId: string) {
    await this.assertChatAdmin(chatId, user.userId);

    await this.prisma.chatAdminAllowlist.delete({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_ADMIN',
        payload: {
          userId: targetUserId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getDomainAllowlist(chatId: string, user: AuthUser): Promise<string[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: { domain: 'asc' },
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    const normalizedRows = await this.canonicalizeActiveAllowlistRows(chatId, rows);

    return normalizedRows.map((row) => row.domain);
  }

  async getDomainAllowlistDetails(chatId: string, user: AuthUser): Promise<DomainAllowlistEntry[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: [{ removeAfterAt: 'asc' }, { domain: 'asc' }],
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    return this.canonicalizeActiveAllowlistRows(chatId, rows);
  }

  async addDomain(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = normalizeAllowlistLink(parsed.data.domain);
    if (!normalized) {
      throw new BadRequestException('Invalid allowlist link');
    }

    await this.upsertNormalizedAllowlistDomain(chatId, normalized);

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_DOMAIN',
        payload: {
          domain: normalized,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeDomain(
    chatId: string,
    user: AuthUser,
    domain: string,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalized = normalizeAllowlistLink(this.decodePathParam(domain));
    if (!normalized) {
      throw new BadRequestException('Invalid allowlist link');
    }

    const matchingDomains = await this.findStoredAllowlistDomains(chatId, normalized);
    if (matchingDomains.length === 0) {
      throw new BadRequestException('Link not found in allowlist');
    }

    await this.prisma.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: matchingDomains,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_DOMAIN',
        payload: {
          domain: normalized,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async scheduleDomainRemoval(
    chatId: string,
    user: AuthUser,
    domain: string,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedDomain = normalizeAllowlistLink(this.decodePathParam(domain));
    if (!normalizedDomain) {
      throw new BadRequestException('Invalid allowlist link');
    }
    const parsed = scheduleDomainRemovalRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    let removeAfterAt: Date | null = null;
    if (parsed.data.removeAfterAt) {
      const scheduledAt = new Date(parsed.data.removeAfterAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('Invalid removal datetime');
      }

      if (scheduledAt.getTime() <= Date.now()) {
        throw new BadRequestException('Removal datetime must be in the future');
      }

      removeAfterAt = scheduledAt;
    }

    const matchingDomains = await this.findStoredAllowlistDomains(chatId, normalizedDomain);
    if (matchingDomains.length === 0) {
      throw new BadRequestException('Link not found in allowlist');
    }

    await this.prisma.domainAllowlist.updateMany({
      where: {
        chatId,
        domain: {
          in: matchingDomains,
        },
      },
      data: {
        removeAfterAt,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: removeAfterAt ? 'SCHEDULE_DOMAIN_REMOVE' : 'CLEAR_DOMAIN_REMOVE_SCHEDULE',
        payload: {
          domain: normalizedDomain,
          removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
          source,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async assertChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
  ) {
    const access = await this.resolveUserAndBotAdminAccess(chatId, userId);
    if (access.status === 'denied') {
      if (access.reason === 'bot_not_admin') {
        throw new ForbiddenException(
          'Бот больше не состоит в этом чате MAX или не является его администратором.',
        );
      }

      throw new ForbiddenException('Пользователь не является администратором чата.');
    }

    if (access.status === 'unknown') {
      throw new ServiceUnavailableException(
        'Не удалось проверить права администратора в MAX. Повторите попытку.',
      );
    }

    await this.upsertUserChatAccess(chatId, userId, null, entityType);
  }

  private resolveLogsDashboardFrom(range: LogsDashboardRange, to: Date): Date {
    const toTimestamp = to.getTime();

    if (range === '24h') {
      return new Date(toTimestamp - 24 * 60 * 60 * 1000);
    }

    if (range === '30d') {
      return new Date(toTimestamp - 30 * 24 * 60 * 60 * 1000);
    }

    return new Date(toTimestamp - 7 * 24 * 60 * 60 * 1000);
  }

  private resolveChannelStatsFrom(range: ChannelStatsRange, to: Date): Date {
    return this.resolveLogsDashboardFrom(range, to);
  }

  private resolveChannelStatsBucket(range: ChannelStatsRange): ChannelStatsBucket {
    return range === '24h' ? 'hour' : 'day';
  }

  private buildChannelStatsBucketStarts(from: Date, to: Date, bucket: ChannelStatsBucket): Date[] {
    const starts: Date[] = [];
    let cursor = this.floorChannelStatsBucket(from, bucket);
    const end = this.floorChannelStatsBucket(to, bucket);

    while (cursor.getTime() <= end.getTime()) {
      starts.push(cursor);
      cursor = this.shiftChannelStatsBucket(cursor, bucket, 1);
    }

    return starts;
  }

  private floorChannelStatsBucket(date: Date, bucket: ChannelStatsBucket): Date {
    const result = new Date(date);
    result.setUTCMinutes(0, 0, 0);
    if (bucket === 'day') {
      result.setUTCHours(0, 0, 0, 0);
    }
    return result;
  }

  private shiftChannelStatsBucket(date: Date, bucket: ChannelStatsBucket, amount: number): Date {
    const result = new Date(date);
    if (bucket === 'hour') {
      result.setUTCHours(result.getUTCHours() + amount);
      return result;
    }

    result.setUTCDate(result.getUTCDate() + amount);
    return result;
  }

  private buildParticipantSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    initialParticipantsCount: number | null,
    snapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
  ) {
    let cursorValue = initialParticipantsCount;
    let snapshotIndex = 0;

    return bucketStarts.map((bucketStart) => {
      const bucketEnd = this.shiftChannelStatsBucket(bucketStart, bucket, 1);
      while (
        snapshotIndex < snapshots.length &&
        snapshots[snapshotIndex].capturedAt.getTime() < bucketEnd.getTime()
      ) {
        cursorValue = snapshots[snapshotIndex].participantsCount;
        snapshotIndex += 1;
      }

      return {
        at: bucketStart.toISOString(),
        participantsCount: cursorValue,
      };
    });
  }

  private buildMembershipSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    rows: Array<{ created_at: Date | string; event_type: string | null }>,
  ) {
    const grouped = new Map<string, { joined: number; left: number }>();

    for (const row of rows) {
      const createdAt = this.toIsoString(row.created_at);
      if (!createdAt) {
        continue;
      }
      const bucketStart = this.floorChannelStatsBucket(new Date(createdAt), bucket).toISOString();
      const current = grouped.get(bucketStart) ?? { joined: 0, left: 0 };
      if (row.event_type === 'user_added') {
        current.joined += 1;
      } else if (row.event_type === 'user_removed') {
        current.left += 1;
      }
      grouped.set(bucketStart, current);
    }

    return bucketStarts.map((bucketStart) => {
      const current = grouped.get(bucketStart.toISOString()) ?? { joined: 0, left: 0 };
      return {
        at: bucketStart.toISOString(),
        joined: current.joined,
        left: current.left,
      };
    });
  }

  private buildViewsSeries(
    bucketStarts: Date[],
    bucket: ChannelStatsBucket,
    posts: Array<{ publishedAt: Date; latestViews: number }>,
  ) {
    const grouped = new Map<string, number>();

    for (const post of posts) {
      const bucketStart = this.floorChannelStatsBucket(post.publishedAt, bucket).toISOString();
      grouped.set(bucketStart, (grouped.get(bucketStart) ?? 0) + Math.max(0, post.latestViews));
    }

    return bucketStarts.map((bucketStart) => ({
      at: bucketStart.toISOString(),
      views: grouped.get(bucketStart.toISOString()) ?? 0,
    }));
  }

  private buildTopReactions(
    posts: Array<{
      latestReactions: Prisma.JsonValue | null;
    }>,
  ) {
    const grouped = new Map<string, number>();

    for (const post of posts) {
      for (const reaction of this.readChannelPostReactions(post.latestReactions)) {
        grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + reaction.count);
      }
    }

    return Array.from(grouped.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji))
      .slice(0, 3);
  }

  private readChannelPostReactions(
    value: Prisma.JsonValue | null,
  ): Array<{ emoji: string; count: number }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.readChannelPostReaction(item))
      .filter((item): item is { emoji: string; count: number } => item !== null);
  }

  private readChannelPostReaction(
    value: Prisma.JsonValue,
  ): { emoji: string; count: number } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const emoji = typeof row.emoji === 'string' ? row.emoji.trim() : '';
    const count = this.toSafeInteger(row.count);
    if (!emoji || count <= 0) {
      return null;
    }

    return {
      emoji,
      count,
    };
  }

  private resolveOfficialCoverageFrom(
    syncState: {
      viewsCoverageFrom: Date | null;
      membershipCoverageFrom: Date | null;
    } | null,
    latestAudienceCapturedAt: Date | null,
  ): string | null {
    const candidates = [
      syncState?.viewsCoverageFrom ?? null,
      syncState?.membershipCoverageFrom ?? null,
      latestAudienceCapturedAt,
    ].filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));

    if (candidates.length === 0) {
      return null;
    }

    const earliest = candidates.reduce((acc, item) =>
      item.getTime() < acc.getTime() ? item : acc,
    );
    return earliest.toISOString();
  }

  private toSafeInteger(value: unknown): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    }

    if (typeof value === 'bigint') {
      return value > 0n ? Number(value) : 0;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
    }

    return 0;
  }

  private toIsoString(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }

      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private async resolveUserDisplayNames(
    chatId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string | null; sender_name: string | null }>
    >`
      SELECT DISTINCT ON (sender_id)
        sender_id AS user_id,
        sender_name
      FROM (
        SELECT
          normalized_payload->'message'->>'senderId' AS sender_id,
          NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
          created_at
        FROM webhook_events
        WHERE normalized_payload->'message'->>'chatId' = ${chatId}
          AND normalized_payload->'message'->>'senderId' IN (${Prisma.join(normalizedUserIds)})
      ) AS sender_rows
      WHERE sender_id IS NOT NULL AND sender_name IS NOT NULL
      ORDER BY sender_id, created_at DESC
    `;

    const byUserId = new Map<string, string>();
    for (const row of rows) {
      const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
      const senderName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
      if (!userId || !senderName || byUserId.has(userId)) {
        continue;
      }
      byUserId.set(userId, senderName);
    }

    return byUserId;
  }

  private activeDomainWhere(chatId: string) {
    const now = new Date();
    return {
      chatId,
      OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
    };
  }

  private decodePathParam(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private async upsertNormalizedAllowlistDomain(chatId: string, normalizedDomain: string) {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        domain: true,
      },
    });

    const obsoleteDomains = rows
      .map((row: { domain: string }) => row.domain)
      .filter(
        (storedDomain) =>
          storedDomain !== normalizedDomain &&
          normalizeAllowlistLink(storedDomain) === normalizedDomain,
      );

    await this.prisma.domainAllowlist.upsert({
      where: {
        chatId_domain: {
          chatId,
          domain: normalizedDomain,
        },
      },
      create: {
        chatId,
        domain: normalizedDomain,
      },
      update: {
        removeAfterAt: null,
      },
    });

    if (obsoleteDomains.length === 0) {
      return;
    }

    await this.prisma.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: obsoleteDomains,
        },
      },
    });
  }

  private async findStoredAllowlistDomains(
    chatId: string,
    normalizedDomain: string,
  ): Promise<string[]> {
    const rows = await this.prisma.domainAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        domain: true,
      },
    });

    return rows
      .map((row: { domain: string }) => row.domain)
      .filter((storedDomain) => normalizeAllowlistLink(storedDomain) === normalizedDomain);
  }

  private async canonicalizeActiveAllowlistRows(
    chatId: string,
    rows: Array<{ domain: string; removeAfterAt: Date | null }>,
  ): Promise<DomainAllowlistEntry[]> {
    const byDomain = new Map<string, Date | null>();
    const exactRows = new Map<string, Date | null>();
    const obsoleteDomains = new Set<string>();

    for (const row of rows) {
      const normalizedDomain = normalizeAllowlistLink(row.domain);
      if (!normalizedDomain) {
        obsoleteDomains.add(row.domain);
        continue;
      }

      if (row.domain === normalizedDomain) {
        exactRows.set(normalizedDomain, row.removeAfterAt);
      } else {
        obsoleteDomains.add(row.domain);
      }

      const current = byDomain.get(normalizedDomain);
      if (current === undefined) {
        byDomain.set(normalizedDomain, row.removeAfterAt);
        continue;
      }

      if (current === null || row.removeAfterAt === null) {
        byDomain.set(normalizedDomain, null);
        continue;
      }

      if (row.removeAfterAt.getTime() < current.getTime()) {
        byDomain.set(normalizedDomain, row.removeAfterAt);
      }
    }

    const normalizedRows = Array.from(byDomain.entries())
      .sort(([leftDomain, leftRemoveAfter], [rightDomain, rightRemoveAfter]) => {
        if (leftRemoveAfter === null && rightRemoveAfter !== null) {
          return -1;
        }
        if (leftRemoveAfter !== null && rightRemoveAfter === null) {
          return 1;
        }
        if (leftRemoveAfter !== null && rightRemoveAfter !== null) {
          const byTime = leftRemoveAfter.getTime() - rightRemoveAfter.getTime();
          if (byTime !== 0) {
            return byTime;
          }
        }

        return leftDomain.localeCompare(rightDomain);
      })
      .map(([domain, removeAfterAt]) => ({
        domain,
        removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
      }));

    const domainsToUpsert = normalizedRows.filter((entry) => {
      const existing = exactRows.get(entry.domain);
      return !this.isSameOptionalIsoDate(existing, entry.removeAfterAt);
    });

    if (domainsToUpsert.length === 0 && obsoleteDomains.size === 0) {
      return normalizedRows;
    }

    await this.prisma.$transaction([
      ...domainsToUpsert.map((entry) =>
        this.prisma.domainAllowlist.upsert({
          where: {
            chatId_domain: {
              chatId,
              domain: entry.domain,
            },
          },
          create: {
            chatId,
            domain: entry.domain,
            removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
          },
          update: {
            removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
          },
        }),
      ),
      ...(obsoleteDomains.size > 0
        ? [
            this.prisma.domainAllowlist.deleteMany({
              where: {
                chatId,
                domain: {
                  in: Array.from(obsoleteDomains),
                },
              },
            }),
          ]
        : []),
    ]);

    await this.chatContextCache.invalidate(chatId);
    return normalizedRows;
  }

  private isSameOptionalIsoDate(value: Date | null | undefined, isoValue: string | null): boolean {
    if (value === undefined) {
      return false;
    }

    if (value === null) {
      return isoValue === null;
    }

    if (isoValue === null) {
      return false;
    }

    return value.toISOString() === isoValue;
  }

  private async getPublicChannelSettings(chatId: string): Promise<ChannelSettings> {
    const settings = await this.prisma.channelSettings.findUnique({
      where: { chatId },
    });

    if (!settings) {
      return DEFAULT_CHANNEL_SETTINGS;
    }

    const parsed = channelSettingsSchema.safeParse(settings);
    return parsed.success ? this.normalizeChannelSettings(parsed.data) : DEFAULT_CHANNEL_SETTINGS;
  }

  private normalizeChannelSettings(settings: ChannelSettings): ChannelSettings {
    return {
      ...settings,
      autoPostButtonsMode: this.normalizeChannelAutoPostButtonsMode(settings),
    };
  }

  private normalizeChannelAutoPostButtonsMode(
    settings: Pick<
      ChannelSettings,
      'autoPostButtonsMode' | 'commentsEnabled' | 'postSuggestionsEnabled'
    >,
  ): ChannelSettings['autoPostButtonsMode'] {
    const includeComments =
      settings.commentsEnabled &&
      (settings.autoPostButtonsMode === 'COMMENTS' || settings.autoPostButtonsMode === 'BOTH');
    const includeSuggest = settings.postSuggestionsEnabled;

    if (includeComments && includeSuggest) {
      return 'BOTH';
    }
    if (includeComments) {
      return 'COMMENTS';
    }
    if (includeSuggest) {
      return 'SUGGEST';
    }
    return 'OFF';
  }

  private hasChannelSettingsNormalizationChanges(
    current: Pick<ChannelSettings, 'autoPostButtonsMode'>,
    normalized: Pick<ChannelSettings, 'autoPostButtonsMode'>,
  ): boolean {
    return current.autoPostButtonsMode !== normalized.autoPostButtonsMode;
  }

  private async assertChannelCommentAllowed(params: {
    chatId: string;
    threadId: string | null;
    authorUserId: string;
    text: string;
    settings: ChannelSettings;
  }): Promise<void> {
    const { chatId, threadId, authorUserId, text, settings } = params;

    if (settings.commentsBlockLinksEnabled && this.channelCommentContainsLink(text)) {
      throw new BadRequestException('Ссылки в комментариях отключены.');
    }

    const threadFilter = threadId
      ? {
          payload: {
            path: ['threadId'],
            equals: threadId,
          } satisfies Prisma.JsonFilter,
        }
      : {};

    const [recentThreadComments, recentOwnComments] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          ...threadFilter,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_COMMENT_MAX_CONSECUTIVE,
      }),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          actorUserId: authorUserId,
          ...threadFilter,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 8,
      }),
    ]);

    if (
      settings.commentsLimitTwoInRowEnabled &&
      recentThreadComments.length >= CHANNEL_COMMENT_MAX_CONSECUTIVE &&
      recentThreadComments.every((row) => row.actorUserId === authorUserId)
    ) {
      throw new BadRequestException(
        'Нельзя оставлять больше двух комментариев подряд. Дайте другим ответить.',
      );
    }

    if (!settings.commentsAntiSpamEnabled) {
      return;
    }

    const normalizedCurrentText = this.normalizeChannelCommentText(text);
    const hasRecentDuplicate = recentOwnComments.some((row) => {
      if (Date.now() - row.createdAt.getTime() > CHANNEL_COMMENT_DUPLICATE_WINDOW_MS) {
        return false;
      }

      const payload = this.readObjectPayload(row.payload);
      const previousText = this.readTrimmedString(payload.text);
      return previousText
        ? this.normalizeChannelCommentText(previousText) === normalizedCurrentText
        : false;
    });

    if (hasRecentDuplicate) {
      throw new BadRequestException(
        'Одинаковые комментарии подряд отправлять нельзя. Напишите один комментарий без повтора.',
      );
    }
  }

  private mapChannelDialogAuditLog(
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date },
    fallbackType: ChannelDialogType,
  ) {
    const payload = this.readObjectPayload(row.payload);
    const rawType = this.readLowerString(payload.type);
    const type: ChannelDialogType =
      rawType === 'suggest' || rawType === 'comments' ? rawType : fallbackType;
    const authorDisplayName = this.readTrimmedString(payload.authorDisplayName);
    const text = this.readTrimmedString(payload.text) ?? '';
    const delivered = payload.delivered === true;
    const deliveredToUserId = this.readTrimmedString(payload.deliveredToUserId);

    return {
      id: row.id,
      type,
      text,
      authorUserId: row.actorUserId,
      authorDisplayName,
      createdAt: row.createdAt.toISOString(),
      ...(type === 'suggest' ? { delivered, deliveredToUserId: deliveredToUserId ?? null } : {}),
    };
  }

  private channelCommentContainsLink(value: string): boolean {
    CHANNEL_COMMENT_LINK_PATTERN.lastIndex = 0;
    return CHANNEL_COMMENT_LINK_PATTERN.test(value);
  }

  private normalizeChannelCommentText(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/gu, ' ');
  }

  private readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readLowerString(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    return normalized ? normalized.toLowerCase() : null;
  }

  private async deliverSuggestionToAdminPrivate(
    chatId: string,
    user: AuthUser,
    text: string,
  ): Promise<{ delivered: boolean; deliveredToUserId: string | null }> {
    const adminIds = Array.from(
      new Set(
        (await this.maxClient.getChatAdminIds(chatId)).filter(
          (id) => id.trim().length > 0 && !this.isOwnBotUserId(id),
        ),
      ),
    );

    if (adminIds.length === 0) {
      return { delivered: false, deliveredToUserId: null };
    }

    const channelTitle = await this.resolveChannelTitle(chatId);
    const actorName = user.displayName?.trim() || user.username?.trim() || `user:${user.userId}`;
    const message = [
      'Новая предложка поста',
      '',
      `Канал: ${channelTitle}`,
      `Отправитель: ${actorName} (${user.userId})`,
      '',
      text,
    ].join('\n');

    for (const adminUserId of adminIds) {
      const privateChatId = await this.findLatestPrivateChatIdForUser(adminUserId);
      if (!privateChatId) {
        continue;
      }

      try {
        await this.maxClient.sendMessage(privateChatId, message, undefined, { immediate: true });
        return { delivered: true, deliveredToUserId: adminUserId };
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            adminUserId,
            privateChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to deliver suggestion to admin private chat',
        );
      }
    }

    return { delivered: false, deliveredToUserId: null };
  }

  private async findLatestPrivateChatIdForUser(userId: string): Promise<string | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return null;
    }

    const rows = await this.prisma.$queryRaw<Array<{ recipient_chat_id: string | null }>>`
      SELECT
        COALESCE(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id') AS recipient_chat_id
      FROM webhook_events
      WHERE COALESCE(raw_payload->'message'->'sender'->>'user_id', raw_payload->'message'->>'sender_id') = ${normalizedUserId}
        AND COALESCE(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id') ~ '^[0-9]+$'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!rows[0]?.recipient_chat_id) {
      return null;
    }

    return rows[0].recipient_chat_id.trim();
  }

  private async resolvePrivateDialogChatId(user: AuthUser): Promise<string | null> {
    const currentChatId = user.chatId?.trim() ?? '';
    if (currentChatId && /^[0-9]+$/u.test(currentChatId)) {
      return currentChatId;
    }

    return this.findLatestPrivateChatIdForUser(user.userId);
  }

  private async resolveChannelTitle(chatId: string): Promise<string> {
    const local = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    if (local?.title?.trim()) {
      return local.title.trim();
    }

    const remote = await this.maxClient.getChatTitle(chatId);
    if (remote?.trim()) {
      return remote.trim();
    }

    return `Канал ${chatId}`;
  }

  private buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    return this.buildMiniappStartUrl(this.buildChannelDialogStartParam(chatId, type, threadId));
  }

  private buildChannelDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildChannelDialogToken(chatId, type, threadId);
    const encodedChatId = encodeURIComponent(chatId);
    return `${this.appBaseUrl}/app/channel/${encodedChatId}/dialog/${type}?token=${token}`;
  }

  private buildChannelDialogStartParam(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildChannelDialogToken(chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: 'channel-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!this.ownBotUserId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  private buildChannelDialogToken(
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    const normalizedThreadId = threadId?.trim() ?? '';
    if (!normalizedThreadId) {
      return this.buildChannelDialogTokenSignature(chatId, type);
    }

    const payload = JSON.stringify({
      v: 1,
      d: normalizedThreadId,
      s: this.buildChannelDialogTokenSignature(chatId, type, normalizedThreadId),
    } satisfies ChannelDialogTokenPayload);
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildChannelDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    const normalizedThreadId = threadId?.trim() ?? '';
    const scope = normalizedThreadId
      ? `dialog:${chatId}:${type}:${normalizedThreadId}`
      : `dialog:${chatId}:${type}`;
    return createHmac('sha256', this.maxBotToken).update(scope).digest('hex');
  }

  private resolveChannelDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    const normalizedToken = typeof token === 'string' ? token.trim() : '';
    if (!normalizedToken) {
      throw new BadRequestException(
        'Неверный токен кнопки. Откройте диалог заново из сообщения канала.',
      );
    }

    if (/^[a-f0-9]{64}$/iu.test(normalizedToken)) {
      const signature = normalizedToken.toLowerCase();
      const expected = this.buildChannelDialogTokenSignature(chatId, type);
      if (!this.isValidChannelDialogSignature(signature, expected)) {
        throw new BadRequestException(
          'Кнопка устарела. Откройте сообщение в канале и нажмите кнопку снова.',
        );
      }

      return null;
    }

    if (!normalizedToken.startsWith(CHANNEL_DIALOG_TOKEN_PREFIX)) {
      throw new BadRequestException(
        'Неверный токен кнопки. Откройте диалог заново из сообщения канала.',
      );
    }

    const encodedPayload = normalizedToken.slice(CHANNEL_DIALOG_TOKEN_PREFIX.length);
    if (!encodedPayload) {
      throw new BadRequestException(
        'Неверный токен кнопки. Откройте диалог заново из сообщения канала.',
      );
    }

    let payload: Partial<ChannelDialogTokenPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<ChannelDialogTokenPayload>;
    } catch {
      throw new BadRequestException(
        'Неверный токен кнопки. Откройте диалог заново из сообщения канала.',
      );
    }

    const threadId = this.readTrimmedString(payload.d);
    const signature = this.readTrimmedString(payload.s)?.toLowerCase() ?? '';
    if (
      payload.v !== 1 ||
      !threadId ||
      threadId.length > 120 ||
      !/^[a-f0-9]{64}$/u.test(signature)
    ) {
      throw new BadRequestException(
        'Неверный токен кнопки. Откройте диалог заново из сообщения канала.',
      );
    }

    const expected = this.buildChannelDialogTokenSignature(chatId, type, threadId);
    if (!this.isValidChannelDialogSignature(signature, expected)) {
      throw new BadRequestException(
        'Кнопка устарела. Откройте сообщение в канале и нажмите кнопку снова.',
      );
    }

    return threadId;
  }

  private isValidChannelDialogSignature(providedHex: string, expectedHex: string): boolean {
    return (
      providedHex.length === expectedHex.length &&
      timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
    );
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/, '');
    if (!normalized || !/^https?:\/\//iu.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized || !/^\d+$/u.test(normalized)) {
      return null;
    }

    return normalized;
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

  private isOwnBotUserId(userId: string): boolean {
    if (!this.ownBotUserId) {
      return false;
    }

    const normalized = userId.trim();
    if (!normalized) {
      return false;
    }

    return normalized === this.ownBotUserId || normalized === this.ownBotUserId.split('_')[0];
  }

  private async mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const concurrency = Math.max(1, Math.min(limit, items.length));
    const results: R[] = new Array<R>(items.length);
    let currentIndex = 0;

    const runWorker = async () => {
      while (true) {
        const itemIndex = currentIndex;
        currentIndex += 1;

        if (itemIndex >= items.length) {
          return;
        }

        results[itemIndex] = await worker(items[itemIndex]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return results;
  }

  private isFallbackTitle(chatId: string, title: string): boolean {
    const normalized = title.trim();
    return normalized === `Chat ${chatId}` || normalized === `Channel ${chatId}`;
  }

  private async loadRemoteAdminAccess(chatId: string, userId: string): Promise<AdminAccessResolution> {
    try {
      const maxClientWithAdminAccess = this.maxClient as MaxClientService & {
        getChatAdminIds?: (chatId: string) => Promise<string[]>;
        getChatEditableAdminIds?: (chatId: string) => Promise<string[]>;
      };
      const adminIds =
        typeof maxClientWithAdminAccess.getChatAdminIds === 'function'
          ? await maxClientWithAdminAccess.getChatAdminIds(chatId)
          : typeof maxClientWithAdminAccess.getChatEditableAdminIds === 'function'
            ? await maxClientWithAdminAccess.getChatEditableAdminIds(chatId)
            : [];
      const hasAccess = adminIds.includes(userId);
      const cacheState: ChatAdminAccessState = hasAccess ? 'granted' : 'user_denied';
      await this.chatContextCache.setAdminAccess?.(chatId, userId, cacheState);

      if (!hasAccess) {
        await this.prunePersistedChatAccess(chatId, userId);
        return {
          status: 'denied',
          source: 'remote',
          reason: 'user_not_admin',
        };
      }

      return {
        status: 'granted',
        source: 'remote',
      };
    } catch (error: unknown) {
      if (this.isBotAdminLookupDeniedError(error)) {
        await this.chatContextCache.setAdminAccess?.(chatId, userId, 'bot_denied');
        await this.prunePersistedChatAccess(chatId, userId);
        return {
          status: 'denied',
          source: 'remote',
          reason: 'bot_not_admin',
        };
      }

      this.logger.warn(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Chat hidden: failed to validate bot/user admin access',
      );
      return {
        status: 'unknown',
        error,
      };
    }
  }

  private async resolveUserAndBotAdminAccess(
    chatId: string,
    userId: string,
  ): Promise<AdminAccessResolution> {
    const cached = (await this.chatContextCache.getAdminAccess?.(chatId, userId)) ?? null;
    if (cached === 'granted') {
      return {
        status: 'granted',
        source: 'cache',
      };
    }

    if (cached === 'user_denied') {
      return {
        status: 'denied',
        source: 'cache',
        reason: 'user_not_admin',
      };
    }

    if (cached === 'bot_denied') {
      return {
        status: 'denied',
        source: 'cache',
        reason: 'bot_not_admin',
      };
    }

    const key = `${chatId}:${userId}`;
    const inFlight = this.adminAccessChecks.get(key);
    if (inFlight) {
      return this.withAllowlistFallback(chatId, userId, inFlight);
    }

    const pending = this.loadRemoteAdminAccess(chatId, userId);
    this.adminAccessChecks.set(key, pending);

    try {
      return await this.withAllowlistFallback(chatId, userId, pending);
    } finally {
      this.adminAccessChecks.delete(key);
    }
  }

  private async withAllowlistFallback(
    chatId: string,
    userId: string,
    resolutionPromise: Promise<AdminAccessResolution>,
  ): Promise<AdminAccessResolution> {
    const resolution = await resolutionPromise;
    if (resolution.status !== 'unknown') {
      return resolution;
    }

    if (!(await this.hasPersistedChatAccess(chatId, userId))) {
      return resolution;
    }

    this.logger.warn(
      {
        chatId,
        userId,
      },
      'Using persisted admin access allowlist after transient MAX API failure',
    );
    return {
      status: 'granted',
      source: 'allowlist_fallback',
    };
  }

  private extractMaxErrorStatus(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim() ? maybeCode.trim().toLowerCase() : null;
  }

  private extractMaxErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data
      ?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim()) {
      return responseMessage.trim().toLowerCase();
    }

    if (error instanceof Error && error.message.trim()) {
      return error.message.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private isBotAdminLookupDeniedError(error: unknown): boolean {
    const status = this.extractMaxErrorStatus(error);
    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    if (status !== 400 && status !== 403) {
      return false;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('method is available only for chat administrator') ||
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found')
    );
  }

  private async hasPersistedChatAccess(chatId: string, userId: string): Promise<boolean> {
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
        userId,
      },
      select: {
        chatId: true,
      },
      take: 1,
    });

    return rows.length > 0;
  }

  private async prunePersistedChatAccess(chatId: string, userId: string): Promise<void> {
    await this.prisma.chatAdminAllowlist.deleteMany({
      where: {
        chatId,
        userId,
      },
    });
  }

  private async refreshChatTitle(chat: ChatSummary): Promise<void> {
    try {
      const refreshedTitle = await this.maxClient.getChatTitle(chat.id);
      if (!refreshedTitle) {
        return;
      }

      chat.title = refreshedTitle;
      await this.prisma.chat.update({
        where: { id: chat.id },
        data: {
          title: refreshedTitle,
        },
      });
      await this.chatContextCache.invalidateManagedEntityHeader?.(chat.id);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: chat.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh chat title from MAX API',
      );
    }
  }

  private async listChatsFromAllowlist(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    const whereClause =
      entityType === 'all'
        ? { userId }
        : {
            userId,
            chat: {
              entityType: this.toPrismaEntityType(entityType),
            },
          };
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: whereClause,
      include: { chat: true },
      orderBy: {
        chat: {
          createdAt: 'desc',
        },
      },
    });

    return rows.map(
      (row: {
        chat: { id: string; title: string; createdAt: Date; entityType: ChatEntityType };
      }) => ({
        id: row.chat.id,
        title: row.chat.title,
        createdAt: row.chat.createdAt.toISOString(),
        entityType: this.fromPrismaEntityType(row.chat.entityType),
        link: null,
        channelOverview: null,
      }),
    );
  }

  private async attachChannelOverview(chats: ChatSummary[]): Promise<ChatSummary[]> {
    const channelIds = chats.filter((chat) => chat.entityType === 'channel').map((chat) => chat.id);

    if (channelIds.length === 0 || typeof this.prisma.channelSettings?.findMany !== 'function') {
      return chats;
    }

    try {
      const rows = await this.prisma.channelSettings.findMany({
        where: {
          chatId: {
            in: channelIds,
          },
        },
        select: {
          chatId: true,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      });

      const byChatId = new Map(
        rows.map((row) => [
          row.chatId,
          {
            commentsEnabled: row.commentsEnabled,
            postSuggestionsEnabled: row.postSuggestionsEnabled,
            commentsModerationEnabled: row.commentsModerationEnabled,
          },
        ]),
      );

      return chats.map((chat) => {
        if (chat.entityType !== 'channel') {
          return chat;
        }

        const settings = byChatId.get(chat.id) ?? DEFAULT_CHANNEL_SETTINGS;
        return {
          ...chat,
          channelOverview: this.buildChannelOverview(settings),
        };
      });
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to attach channel overview to managed entities list',
      );
      return chats;
    }
  }

  private async upsertUserChatAccess(
    chatId: string,
    userId: string,
    chatTitle: string | null,
    entityType: ManagedEntityType | null = null,
    options: { updateEntityType?: boolean } = {},
  ) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const fallbackTitle = entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`;
    const updateEntityType = options.updateEntityType === true;
    const persistedChat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: normalizedTitle ?? fallbackTitle,
        ...(entityType ? { entityType: this.toPrismaEntityType(entityType) } : {}),
      },
      update: {
        ...(normalizedTitle
          ? {
              title: normalizedTitle,
            }
          : {}),
        ...(updateEntityType && entityType
          ? { entityType: this.toPrismaEntityType(entityType) }
          : {}),
      },
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId,
        },
      },
      create: {
        chatId,
        userId,
      },
      update: {},
    });

    if (normalizedTitle || updateEntityType) {
      await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    }

    return persistedChat;
  }

  private async bootstrapCurrentChat(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary | null> {
    if (entityType === 'channel') {
      return null;
    }

    if (!user.chatId) {
      return null;
    }

    const access = await this.resolveUserAndBotAdminAccess(user.chatId, user.userId);
    if (access.status !== 'granted') {
      return null;
    }

    const persistedChat = await this.upsertUserChatAccess(
      user.chatId,
      user.userId,
      user.chatTitle ?? null,
      'chat',
    );

    const chat: ChatSummary = {
      id: user.chatId,
      title: persistedChat.title,
      createdAt: persistedChat.createdAt.toISOString(),
      entityType: this.fromPrismaEntityType(persistedChat.entityType),
      link: null,
      channelOverview: null,
    };

    if (this.isFallbackTitle(chat.id, chat.title)) {
      await this.refreshChatTitle(chat);
    }

    return chat;
  }

  private async ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    const current = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
      },
    });

    if (current) {
      if (this.fromPrismaEntityType(current.entityType) !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
      return;
    }

    try {
      const remoteChats = await this.maxClient.listBotChats();
      const discovered = remoteChats.find((item) => item.chatId === chatId);
      if (discovered && discovered.entityType !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
    }

    await this.upsertUserChatAccess(chatId, userId, null, expectedEntityType);
  }

  private async getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntityHeader> {
    await this.assertChatAdmin(chatId, user.userId, entityType);
    await this.ensureEntityType(chatId, user.userId, entityType);

    const cached = await this.chatContextCache.getManagedEntityHeader?.(chatId, entityType);
    if (cached) {
      return cached;
    }

    const persistedChat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
      },
    });

    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId);
      const title = snapshot.title?.trim() || persistedChat?.title?.trim() || chatId;

      if (
        persistedChat &&
        title &&
        title !== persistedChat.title &&
        !this.isFallbackTitle(chatId, title)
      ) {
        await this.prisma.chat.update({
          where: { id: chatId },
          data: { title },
        });
      }

      const header: ManagedEntityHeader = {
        id: chatId,
        title,
        entityType,
        link: snapshot.link,
        participantsCount: snapshot.participantsCount,
      };
      await this.chatContextCache.setManagedEntityHeader?.(header);
      return header;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          entityType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load managed entity header snapshot from MAX API',
      );
    }

    const fallbackHeader: ManagedEntityHeader = {
      id: chatId,
      title: persistedChat?.title?.trim() || chatId,
      entityType,
      link: null,
      participantsCount: null,
    };
    await this.chatContextCache.setManagedEntityHeader?.(fallbackHeader);
    return fallbackHeader;
  }

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): ManagedEntityType {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private buildChannelOverview(
    settings: Pick<
      ChannelSettings,
      'commentsEnabled' | 'postSuggestionsEnabled' | 'commentsModerationEnabled'
    >,
  ): ChannelOverview {
    const enabledScenariosCount =
      Number(settings.commentsEnabled) + Number(settings.postSuggestionsEnabled);

    return {
      enabledScenariosCount,
      commentsEnabled: settings.commentsEnabled,
      postSuggestionsEnabled: settings.postSuggestionsEnabled,
      commentsModerationEnabled: settings.commentsEnabled && settings.commentsModerationEnabled,
    };
  }
}
