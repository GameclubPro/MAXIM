import {
  chatRulesSchema,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  MAX_BROADCAST_LINK_BUTTONS,
  normalizeHttpButtonUrl,
  publishChatRulesResultSchema,
  type BroadcastLinkButton,
  type ChatRules,
  type PublishChatRulesResult,
  type UpdateChatRulesRequest,
  updateChatRulesRequestSchema,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type {
  MaxActionDispatchOptions,
  MaxClientService,
  MaxMessageButton,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import type { ChatRules as PersistedChatRules } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { normalizeLegacyProfileButtonUrl } from './admin-profile-links';
import { isPrismaKnownError } from './admin-legacy-utils';
import {
  BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS,
  RULES_IMAGE_MAX_BYTES,
  type AdminActionSource,
} from './admin.service.support';

type ChatRulesMessageOptions =
  | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
  | undefined;

type ChatRulesFormattedPublication = {
  text: string;
  textFormat: MaxSendMessageOptions['textFormat'];
};

type ChatRulesDeleteOutcome = 'confirmed' | 'accepted' | 'failed';
type DeletePublishedChatRulesMessage = (params: {
  chatId: string;
  messageId: string;
  botId?: string;
  directOptions: MaxActionDispatchOptions;
}) => Promise<ChatRulesDeleteOutcome>;

const CHAT_RULES_LINK_TIMEOUT_MS = 2_500;
const CHAT_RULES_SEND_TIMEOUT_MS = 12_000;
const CHAT_RULES_UPLOAD_TIMEOUT_MS = 30_000;

function buildChatRulesReadOptions(botId?: string) {
  return {
    ...(botId ? { botId } : {}),
    trafficClass: 'interactive' as const,
    actionHealthLane: 'background' as const,
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: CHAT_RULES_LINK_TIMEOUT_MS,
  };
}

function buildChatRulesSendOptions(botId?: string) {
  return {
    ...(botId ? { botId } : {}),
    trafficClass: 'interactive' as const,
    actionHealthLane: 'interactive' as const,
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: CHAT_RULES_SEND_TIMEOUT_MS,
  };
}

function buildChatRulesUploadOptions(botId?: string) {
  return {
    ...(botId ? { botId } : {}),
    trafficClass: 'interactive' as const,
    actionHealthLane: 'interactive' as const,
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: CHAT_RULES_UPLOAD_TIMEOUT_MS,
  };
}

function buildChatRulesDeleteOptions(botId?: string) {
  return {
    immediate: true,
    ...buildChatRulesSendOptions(botId),
  };
}

async function deletePublishedChatRulesMessage(params: {
  maxClient: Pick<MaxClientService, 'deleteMessage'>;
  deleteMessage?: DeletePublishedChatRulesMessage;
  chatId: string;
  messageId: string;
  botId?: string;
}): Promise<ChatRulesDeleteOutcome> {
  const directOptions = buildChatRulesDeleteOptions(params.botId);
  if (params.deleteMessage) {
    return params.deleteMessage({
      chatId: params.chatId,
      messageId: params.messageId,
      botId: params.botId,
      directOptions,
    });
  }
  await params.maxClient.deleteMessage(params.chatId, params.messageId, directOptions);
  return 'confirmed';
}

export function decodeRulesImageBase64(value: string): Buffer {
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

export function normalizeStoredLinkButtons(
  rawButtons: unknown,
  legacy?: {
    buttonUrl?: string | null;
    buttonText?: string | null;
  },
): BroadcastLinkButton[] {
  const normalizedButtons: BroadcastLinkButton[] = [];

  if (Array.isArray(rawButtons)) {
    for (const item of rawButtons) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const row = item as { text?: unknown; url?: unknown };
      const url = normalizeLegacyProfileButtonUrl(typeof row.url === 'string' ? row.url : '');
      if (!url) {
        continue;
      }

      normalizedButtons.push({
        text:
          typeof row.text === 'string' && row.text.trim().length > 0
            ? row.text.trim()
            : DEFAULT_BROADCAST_BUTTON_TEXT,
        url,
      });

      if (normalizedButtons.length >= MAX_BROADCAST_LINK_BUTTONS) {
        break;
      }
    }
  }

  if (normalizedButtons.length > 0) {
    return normalizedButtons;
  }

  const legacyUrl = normalizeLegacyProfileButtonUrl(legacy?.buttonUrl ?? '');
  if (!legacyUrl) {
    return [];
  }

  return [
    {
      text: legacy?.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
      url: legacyUrl,
    },
  ];
}

export function buildStoredLinkButtonState(
  rawButtons: unknown,
  legacy?: {
    buttonUrl?: string | null;
    buttonText?: string | null;
  },
): {
  buttons: BroadcastLinkButton[];
  buttonUrl: string;
  buttonText: string;
} {
  const buttons = normalizeStoredLinkButtons(rawButtons, legacy);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
  };
}

function normalizeRulesAdminContactButton(rules: {
  adminContactButtonEnabled?: boolean | null;
  adminContactButtonUrl?: string | null;
}): {
  adminContactButtonEnabled: boolean;
  adminContactButtonUrl: string;
} {
  const trimmedUrl =
    typeof rules.adminContactButtonUrl === 'string' ? rules.adminContactButtonUrl.trim() : '';
  const adminContactButtonUrl = trimmedUrl ? (normalizeHttpButtonUrl(trimmedUrl) ?? '') : '';
  return {
    adminContactButtonEnabled:
      rules.adminContactButtonEnabled === true && adminContactButtonUrl.length > 0,
    adminContactButtonUrl,
  };
}

export function normalizeChatRulesDraft(value: UpdateChatRulesRequest): UpdateChatRulesRequest {
  const buttonState = buildStoredLinkButtonState(value.buttons, {
    buttonUrl: value.buttonUrl,
    buttonText: value.buttonText,
  });
  const baseDraft = {
    text: value.text,
    autoTextEnabled: value.autoTextEnabled,
    buttons: buttonState.buttons,
    buttonEnabled: value.buttonEnabled,
    buttonUrl: buttonState.buttonUrl,
    buttonText: buttonState.buttonText,
    adminContactButtonEnabled: value.adminContactButtonEnabled,
    adminContactButtonUrl: value.adminContactButtonEnabled ? value.adminContactButtonUrl : '',
  } satisfies Pick<
    UpdateChatRulesRequest,
    | 'text'
    | 'autoTextEnabled'
    | 'buttons'
    | 'buttonEnabled'
    | 'buttonUrl'
    | 'buttonText'
    | 'adminContactButtonEnabled'
    | 'adminContactButtonUrl'
  >;
  const normalizedImageBase64 = value.imageBase64.trim();
  if (!normalizedImageBase64) {
    return {
      ...baseDraft,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
    };
  }

  return {
    ...baseDraft,
    imageBase64: normalizedImageBase64,
    imageMimeType: value.imageMimeType.trim(),
    imageFileName: value.imageFileName.trim(),
  };
}

export function mapChatRules(rules: PersistedChatRules): ChatRules {
  const buttonState = buildStoredLinkButtonState(rules.buttons, {
    buttonUrl: rules.buttonUrl,
    buttonText: rules.buttonText,
  });
  const adminContactButtonState = normalizeRulesAdminContactButton(rules);

  return chatRulesSchema.parse({
    text: rules.text,
    imageBase64: rules.imageBase64,
    imageMimeType: rules.imageMimeType,
    imageFileName: rules.imageFileName,
    autoTextEnabled: rules.autoTextEnabled,
    buttons: buttonState.buttons,
    buttonEnabled: rules.buttonEnabled === true && buttonState.buttons.length > 0,
    buttonUrl: buttonState.buttonUrl,
    buttonText: buttonState.buttonText,
    adminContactButtonEnabled: adminContactButtonState.adminContactButtonEnabled,
    adminContactButtonUrl: adminContactButtonState.adminContactButtonUrl,
    publishedMessageId: rules.publishedMessageId,
    publishedUrl: normalizePublishedRulesUrl(rules.publishedUrl),
    publishedAt: rules.publishedAt ? rules.publishedAt.toISOString() : null,
  });
}

export function normalizePublishedRulesUrl(value: string | null | undefined): string | null {
  return typeof value === 'string' ? normalizeHttpButtonUrl(value) : null;
}

function normalizeOptionalBotId(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

export function extractMaxApiErrorMessage(error: unknown): string {
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

export function isMaxMessageMissingError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
    return false;
  }

  const row = responseData as Record<string, unknown>;
  const nestedError =
    row.error && typeof row.error === 'object' && !Array.isArray(row.error)
      ? (row.error as Record<string, unknown>)
      : null;
  const code = String(nestedError?.code ?? row.code ?? '')
    .trim()
    .toLowerCase();
  const message = String(nestedError?.message ?? row.message ?? '')
    .trim()
    .toLowerCase();
  const exactMessageCode = new Set([
    'message.not.found',
    'message_not_found',
    'message.not_found',
  ]).has(code);
  const exactMessageText =
    message.includes('message not found') || message.includes('message.not.found');

  return (
    (exactMessageCode && (status === 404 || status === 200)) || (status === 404 && exactMessageText)
  );
}

export function resolveRulesImageFileName(fileName: string, mimeType: string): string {
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

export function buildBroadcastLinkButtonRows(
  buttons: readonly BroadcastLinkButton[],
): MaxMessageButton[][] {
  const rows: MaxMessageButton[][] = [];

  for (let index = 0; index < buttons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
    rows.push(
      buttons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW).map((button) => ({
        type: 'link',
        text: button.text,
        url: button.url,
      })),
    );
  }

  return rows;
}

export function buildChatRulesButtonRows(rules: {
  buttons: unknown;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
}): MaxMessageButton[][] | null {
  const buttons = rules.buttonEnabled
    ? normalizeStoredLinkButtons(rules.buttons, {
        buttonUrl: rules.buttonUrl,
        buttonText: rules.buttonText,
      }).map((button) => ({
        ...button,
        url: normalizePublishedRulesUrl(button.url) ?? '',
      }))
    : [];
  const normalizedButtons = buttons.filter((button) => button.url.length > 0);
  if (normalizedButtons.length === 0) {
    return null;
  }

  return buildBroadcastLinkButtonRows(normalizedButtons);
}

export async function ensureChatRules(params: {
  prisma: PrismaService;
  chatId: string;
}): Promise<PersistedChatRules> {
  try {
    return await params.prisma.chatRules.upsert({
      where: { chatId: params.chatId },
      create: {
        chatId: params.chatId,
        autoTextEnabled: true,
      },
      update: {},
    });
  } catch (error: unknown) {
    if (!isPrismaKnownError(error, 'P2002')) {
      throw error;
    }

    const existing = await params.prisma.chatRules.findUnique({
      where: { chatId: params.chatId },
    });
    if (existing) {
      return existing;
    }

    throw error;
  }
}

export async function hydratePublishedRulesUrl(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'resolveMessageLink'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  rules: PersistedChatRules;
  resolveBotId?: () => Promise<string | undefined> | string | undefined;
}): Promise<PersistedChatRules> {
  const currentUrl = normalizePublishedRulesUrl(params.rules.publishedUrl);
  if (currentUrl || !params.rules.publishedMessageId?.trim()) {
    return {
      ...params.rules,
      publishedUrl: currentUrl,
    };
  }

  let botId = normalizeOptionalBotId(params.rules.publishedBotId);
  try {
    botId ??= normalizeOptionalBotId(await params.resolveBotId?.());
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: params.rules.publishedMessageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to resolve bot for published chat rules url recovery',
    );
  }

  let resolvedUrl: string | null = null;
  try {
    resolvedUrl = normalizePublishedRulesUrl(
      await params.maxClient.resolveMessageLink(
        params.rules.publishedMessageId,
        buildChatRulesReadOptions(botId),
      ),
    );
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: params.rules.publishedMessageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to recover published chat rules url',
    );
    return params.rules;
  }

  if (!resolvedUrl) {
    return params.rules;
  }

  await params.prisma.chatRules.update({
    where: { chatId: params.chatId },
    data: {
      publishedUrl: resolvedUrl,
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return {
    ...params.rules,
    publishedUrl: resolvedUrl,
  };
}

export async function readChatRules(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'resolveMessageLink'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  resolveBotId?: () => Promise<string | undefined> | string | undefined;
}): Promise<ChatRules> {
  const rules = await ensureChatRules({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const hydratedRules = await hydratePublishedRulesUrl({
    prisma: params.prisma,
    chatContextCache: params.chatContextCache,
    maxClient: params.maxClient,
    logger: params.logger,
    chatId: params.chatId,
    rules,
    resolveBotId: params.resolveBotId,
  });
  const adminContactButtonState = normalizeRulesAdminContactButton(hydratedRules);
  if (
    adminContactButtonState.adminContactButtonEnabled !== hydratedRules.adminContactButtonEnabled ||
    adminContactButtonState.adminContactButtonUrl !== hydratedRules.adminContactButtonUrl
  ) {
    const repaired = await params.prisma.chatRules.updateMany({
      where: {
        chatId: params.chatId,
        adminContactButtonEnabled: hydratedRules.adminContactButtonEnabled,
        adminContactButtonUrl: hydratedRules.adminContactButtonUrl,
      },
      data: adminContactButtonState,
    });
    if (repaired.count > 0) {
      await params.chatContextCache.invalidate(params.chatId);
    }
  }

  return mapChatRules({
    ...hydratedRules,
    ...adminContactButtonState,
  });
}

function hasRetriableRulesAttachment(options: ChatRulesMessageOptions): boolean {
  return Boolean(options?.imagePayload) || Boolean(options?.attachments?.length);
}

function isAttachmentNotReadyError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status !== 400) {
    return false;
  }

  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  const normalized = JSON.stringify(responseData ?? '').toLowerCase();
  return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishChatRulesMessageWithRetry(params: {
  maxClient: Pick<MaxClientService, 'sendMessageImmediateWithResolvedLink'>;
  chatId: string;
  text: string;
  options: ChatRulesMessageOptions;
  botId?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MaxPublishedMessage> {
  let lastError: unknown = null;
  const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;
  const sleep = params.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return params.botId
        ? await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            params.text,
            params.options,
            buildChatRulesSendOptions(params.botId),
          )
        : await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            params.text,
            params.options,
            buildChatRulesSendOptions(),
          );
    } catch (error: unknown) {
      lastError = error;
      if (
        !hasRetriableRulesAttachment(params.options) ||
        !isAttachmentNotReadyError(error) ||
        attempt >= attempts
      ) {
        throw error;
      }
      const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
      await sleep(delayMs);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Message publish failed without error details');
}

export async function publishChatRules(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<
    MaxClientService,
    'deleteMessage' | 'resolveMessageLink' | 'sendMessageImmediateWithResolvedLink' | 'uploadImage'
  >;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  actorUserId: string;
  source: AdminActionSource;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
  buildAutofilledText: () => Promise<string>;
  buildFormattedText: (
    sourceText: string,
    options: {
      adminContactButtonEnabled: boolean;
      adminContactButtonUrl: string;
    },
  ) => Promise<ChatRulesFormattedPublication>;
  sendPrivateConfirmation: (publishedUrl: string | null) => Promise<void>;
  deletePreviousPublishedMessage?: DeletePublishedChatRulesMessage;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PublishChatRulesResult> {
  const rules = await ensureChatRules({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const previousPublishedMessageId = rules.publishedMessageId?.trim() || null;
  const previousPublishedBotId = normalizeOptionalBotId(rules.publishedBotId);
  const autofilledText =
    rules.autoTextEnabled && !rules.text.trim() ? await params.buildAutofilledText() : null;
  const messageText = (autofilledText ?? rules.text).trim();
  if (!messageText) {
    throw new BadRequestException('Сначала заполните текст правил.');
  }
  const resolvedBotId = normalizeOptionalBotId(await params.resolveBotId());

  let imagePayload: Record<string, unknown> | undefined;
  if (rules.imageBase64.trim()) {
    const imageMimeType = rules.imageMimeType.trim().toLowerCase();
    if (!imageMimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }

    const imageBuffer = decodeRulesImageBase64(rules.imageBase64);
    if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото правил слишком большое.');
    }

    try {
      imagePayload = resolvedBotId
        ? await params.maxClient.uploadImage(
            imageBuffer,
            resolveRulesImageFileName(rules.imageFileName, imageMimeType),
            imageMimeType,
            buildChatRulesUploadOptions(resolvedBotId),
          )
        : await params.maxClient.uploadImage(
            imageBuffer,
            resolveRulesImageFileName(rules.imageFileName, imageMimeType),
            imageMimeType,
            buildChatRulesUploadOptions(),
          );
    } catch (error: unknown) {
      params.logger.warn(
        {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Rules image upload failed',
      );
      throw new BadRequestException(
        'Не удалось загрузить фото правил. Попробуйте другое изображение.',
      );
    }
  }

  let published: MaxPublishedMessage;
  const buttonRows = buildChatRulesButtonRows(rules);
  const formattedMessage = await params.buildFormattedText(messageText, {
    adminContactButtonEnabled: rules.adminContactButtonEnabled,
    adminContactButtonUrl: rules.adminContactButtonUrl,
  });
  const publishOperationId = randomUUID();
  const claimed = await params.prisma.chatRules.updateMany({
    where: {
      chatId: params.chatId,
      publishSendStartedAt: null,
      pendingCleanupMessageId: null,
    },
    data: {
      publishOperationId,
      publishOperationBotId: resolvedBotId ?? null,
      publishSendStartedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    throw new BadRequestException(
      'Предыдущая публикация правил имеет неопределённый результат. Проверьте Safety Desk перед повтором.',
    );
  }
  try {
    published = await publishChatRulesMessageWithRetry({
      maxClient: params.maxClient,
      chatId: params.chatId,
      text: formattedMessage.text,
      options: {
        textFormat: formattedMessage.textFormat,
        ...(imagePayload ? { imagePayload } : {}),
        ...(buttonRows ? { buttons: buttonRows } : {}),
      },
      botId: resolvedBotId,
      sleep: params.sleep,
    });
  } catch (error: unknown) {
    if (!isAmbiguousMaxSendError(error)) {
      await params.prisma.chatRules
        .updateMany({
          where: { chatId: params.chatId, publishOperationId },
          data: {
            publishOperationId: null,
            publishOperationBotId: null,
            publishSendStartedAt: null,
          },
        })
        .catch((releaseError: unknown) => {
          params.logger.warn(
            {
              chatId: params.chatId,
              actorUserId: params.actorUserId,
              err: releaseError instanceof Error ? releaseError.message : String(releaseError),
            },
            'Failed to release a safely rejected chat rules publish fence',
          );
        });
    }
    const maxApiMessage = extractMaxApiErrorMessage(error);
    throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать правила.');
  }

  const publishedAt = new Date();
  const needsPreviousCleanup = Boolean(
    previousPublishedMessageId && previousPublishedMessageId !== published.messageId,
  );
  try {
    const finalized = await params.prisma.chatRules.updateMany({
      where: {
        chatId: params.chatId,
        publishOperationId,
      },
      data: {
        ...(autofilledText !== null ? { text: autofilledText } : {}),
        publishedMessageId: published.messageId,
        publishedBotId: resolvedBotId ?? null,
        publishedUrl: published.url,
        publishedAt,
        publishOperationId: null,
        publishOperationBotId: null,
        publishSendStartedAt: null,
        pendingCleanupMessageId: needsPreviousCleanup ? previousPublishedMessageId : null,
        pendingCleanupBotId: needsPreviousCleanup
          ? (previousPublishedBotId ?? resolvedBotId ?? null)
          : null,
        pendingCleanupIntentId: null,
        pendingCleanupKind: needsPreviousCleanup ? 'republish_previous' : null,
      },
    });
    if (finalized.count !== 1) {
      throw new Error('Chat rules publish fence ownership was lost before finalization');
    }
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'MAX accepted chat rules, but the publication state could not be finalized',
    );
    throw new BadRequestException(
      'MAX принял публикацию, но её результат не удалось сохранить. Повтор не выполняйте; проверьте Safety Desk.',
    );
  }

  let previousCleanupOutcome: ChatRulesDeleteOutcome | 'not_needed' = 'not_needed';
  let previousCleanupError: string | null = null;
  let previousCleanupBotId: string | null = null;
  if (previousPublishedMessageId && previousPublishedMessageId !== published.messageId) {
    const deleteBotId = previousPublishedBotId ?? resolvedBotId;
    previousCleanupBotId = deleteBotId ?? null;
    try {
      const outcome = await deletePublishedChatRulesMessage({
        maxClient: params.maxClient,
        deleteMessage: params.deletePreviousPublishedMessage,
        chatId: params.chatId,
        messageId: previousPublishedMessageId,
        botId: deleteBotId,
      });
      previousCleanupOutcome = outcome;
      if (outcome === 'failed') {
        previousCleanupError = 'Durable cleanup reached a terminal state';
        params.logger.warn(
          {
            chatId: params.chatId,
            actorUserId: params.actorUserId,
            messageId: previousPublishedMessageId,
          },
          'Durable cleanup could not accept previous published chat rules post deletion',
        );
      }
    } catch (error: unknown) {
      if (isMaxMessageMissingError(error)) {
        previousCleanupOutcome = 'confirmed';
      } else {
        previousCleanupOutcome = 'failed';
        previousCleanupError = error instanceof Error ? error.message : String(error);
        params.logger.warn(
          {
            chatId: params.chatId,
            actorUserId: params.actorUserId,
            messageId: previousPublishedMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to delete previous published chat rules post during republish',
        );
      }
    }
  }
  if (previousCleanupOutcome === 'confirmed' && previousPublishedMessageId) {
    await params.prisma.chatRules
      .updateMany({
        where: {
          chatId: params.chatId,
          pendingCleanupMessageId: previousPublishedMessageId,
        },
        data: {
          pendingCleanupMessageId: null,
          pendingCleanupBotId: null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: null,
        },
      })
      .catch((error: unknown) => {
        params.logger.warn(
          {
            chatId: params.chatId,
            messageId: previousPublishedMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to finalize confirmed previous rules cleanup state',
        );
      });
  }

  try {
    await params.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        action: 'PUBLISH_CHAT_RULES',
        payload: {
          messageId: published.messageId,
          botId: resolvedBotId ?? null,
          url: published.url,
          publishedAt: publishedAt.toISOString(),
          buttonEnabled: rules.buttonEnabled,
          adminContactButtonEnabled: rules.adminContactButtonEnabled,
          hasImage: Boolean(imagePayload),
          autofilledTextApplied: autofilledText !== null,
          replacedPreviousPost: Boolean(
            previousPublishedMessageId && previousPublishedMessageId !== published.messageId,
          ),
          previousPublishedMessageId,
          previousPublishedBotId: previousCleanupBotId,
          previousCleanupOutcome,
          ...(previousCleanupError ? { previousCleanupError } : {}),
          source: params.source,
        },
      },
    });
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist post-commit chat rules publish audit',
    );
  }

  const committedRules: PersistedChatRules = {
    ...rules,
    ...(autofilledText !== null ? { text: autofilledText } : {}),
    publishedMessageId: published.messageId,
    publishedBotId: resolvedBotId ?? null,
    publishedUrl: published.url,
    publishedAt,
    publishOperationId: null,
    publishOperationBotId: null,
    publishSendStartedAt: null,
    pendingCleanupMessageId: needsPreviousCleanup ? previousPublishedMessageId : null,
    pendingCleanupBotId: needsPreviousCleanup
      ? (previousPublishedBotId ?? resolvedBotId ?? null)
      : null,
    pendingCleanupIntentId: null,
    pendingCleanupKind: needsPreviousCleanup ? 'republish_previous' : null,
  };
  let hydratedRules = committedRules;
  try {
    hydratedRules = await hydratePublishedRulesUrl({
      prisma: params.prisma,
      chatContextCache: params.chatContextCache,
      maxClient: params.maxClient,
      logger: params.logger,
      chatId: params.chatId,
      rules: committedRules,
      resolveBotId: () => resolvedBotId,
    });
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to hydrate committed chat rules publication url',
    );
  }
  try {
    await params.chatContextCache.invalidate(params.chatId);
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to invalidate chat rules cache after committed publish',
    );
  }

  if (params.source === 'miniapp') {
    try {
      await params.sendPrivateConfirmation(hydratedRules.publishedUrl);
    } catch (error: unknown) {
      params.logger.warn(
        {
          chatId: params.chatId,
          messageId: published.messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send post-commit chat rules publication confirmation',
      );
    }
  }

  return publishChatRulesResultSchema.parse({
    chatId: params.chatId,
    messageId: published.messageId,
    url: hydratedRules.publishedUrl,
    publishedAt: publishedAt.toISOString(),
  });
}

export async function resetPublishedChatRules(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'deleteMessage'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  actorUserId: string;
  source: AdminActionSource;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
  deletePublishedMessage?: DeletePublishedChatRulesMessage;
}): Promise<ChatRules> {
  const rules = await ensureChatRules({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const publishedMessageId = rules.publishedMessageId?.trim() ?? '';
  const resolvedBotId = normalizeOptionalBotId(await params.resolveBotId());
  const deleteBotId = normalizeOptionalBotId(rules.publishedBotId) ?? resolvedBotId;
  let cleanupOutcome: ChatRulesDeleteOutcome | 'not_needed' = 'not_needed';

  if (publishedMessageId) {
    const alreadyOwned =
      rules.pendingCleanupKind === 'reset_current' &&
      rules.pendingCleanupMessageId === publishedMessageId;
    if (!alreadyOwned) {
      const claimed = await params.prisma.chatRules.updateMany({
        where: {
          chatId: params.chatId,
          publishedMessageId,
          publishSendStartedAt: null,
          pendingCleanupMessageId: null,
        },
        data: {
          pendingCleanupMessageId: publishedMessageId,
          pendingCleanupBotId: deleteBotId ?? null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: 'reset_current',
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(
          'Публикация или очистка правил уже выполняется. Обновите данные и повторите позже.',
        );
      }
    }

    try {
      cleanupOutcome = await deletePublishedChatRulesMessage({
        maxClient: params.maxClient,
        deleteMessage: params.deletePublishedMessage,
        chatId: params.chatId,
        messageId: publishedMessageId,
        botId: deleteBotId,
      });
      if (cleanupOutcome === 'failed') {
        throw new Error('Durable chat rules cleanup reached a terminal state');
      }
    } catch (error: unknown) {
      if (isMaxMessageMissingError(error)) {
        cleanupOutcome = 'confirmed';
      } else {
        const maxApiMessage = extractMaxApiErrorMessage(error);
        throw new BadRequestException(
          maxApiMessage || 'Не удалось удалить опубликованный пост правил.',
        );
      }
    }
  }

  let updatedRules = rules;
  if (cleanupOutcome === 'confirmed' && publishedMessageId) {
    try {
      const cleared = await params.prisma.chatRules.updateMany({
        where: {
          chatId: params.chatId,
          publishedMessageId,
        },
        data: {
          publishedMessageId: null,
          publishedBotId: null,
          publishedUrl: null,
          publishedAt: null,
          pendingCleanupMessageId: null,
          pendingCleanupBotId: null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: null,
        },
      });
      if (cleared.count === 1) {
        updatedRules = {
          ...rules,
          publishedMessageId: null,
          publishedBotId: null,
          publishedUrl: null,
          publishedAt: null,
          pendingCleanupMessageId: null,
          pendingCleanupBotId: null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: null,
        };
      }
    } catch (error: unknown) {
      params.logger.warn(
        {
          chatId: params.chatId,
          messageId: publishedMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to finalize confirmed chat rules reset state',
      );
    }
  }

  try {
    await params.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: {
          deletedPost: cleanupOutcome === 'confirmed',
          cleanupOutcome,
          messageId: publishedMessageId || null,
          botId: deleteBotId ?? null,
          source: params.source,
        },
      },
    });
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: publishedMessageId || null,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist post-commit chat rules reset audit',
    );
  }
  try {
    await params.chatContextCache.invalidate(params.chatId);
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to invalidate chat rules cache after reset',
    );
  }

  return mapChatRules(updatedRules);
}

export async function saveChatRulesDraft(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  chatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
}): Promise<ChatRules> {
  const parsed = updateChatRulesRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const normalizedDraft = normalizeChatRulesDraft(parsed.data);
  if (normalizedDraft.imageBase64) {
    const imageBuffer = decodeRulesImageBase64(normalizedDraft.imageBase64);
    if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото правил слишком большое.');
    }
    if (!normalizedDraft.imageMimeType.toLowerCase().startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }
  }

  const rulesUpdate = {
    ...normalizedDraft,
  };
  let rules: PersistedChatRules;
  try {
    rules = await params.prisma.chatRules.upsert({
      where: { chatId: params.chatId },
      create: {
        chatId: params.chatId,
        ...normalizedDraft,
      },
      update: rulesUpdate,
    });
  } catch (error: unknown) {
    if (!isPrismaKnownError(error, 'P2002')) {
      throw error;
    }

    rules = await params.prisma.chatRules.update({
      where: { chatId: params.chatId },
      data: rulesUpdate,
    });
  }

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: 'UPDATE_CHAT_RULES',
      payload: {
        autoTextEnabled: normalizedDraft.autoTextEnabled,
        buttonEnabled: normalizedDraft.buttonEnabled,
        adminContactButtonEnabled: normalizedDraft.adminContactButtonEnabled,
        hasImage: Boolean(normalizedDraft.imageBase64),
        textLength: normalizedDraft.text.length,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return mapChatRules(rules);
}
