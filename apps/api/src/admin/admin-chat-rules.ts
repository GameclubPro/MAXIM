import {
  chatRulesSchema,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  MAX_BROADCAST_LINK_BUTTONS,
  publishChatRulesResultSchema,
  type BroadcastLinkButton,
  type ChatRules,
  type PublishChatRulesResult,
  type UpdateChatRulesRequest,
  updateChatRulesRequestSchema,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type {
  MaxClientService,
  MaxMessageButton,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
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

  return chatRulesSchema.parse({
    text: rules.text,
    imageBase64: rules.imageBase64,
    imageMimeType: rules.imageMimeType,
    imageFileName: rules.imageFileName,
    autoTextEnabled: rules.autoTextEnabled,
    buttons: buttonState.buttons,
    buttonEnabled: rules.buttonEnabled,
    buttonUrl: buttonState.buttonUrl,
    buttonText: buttonState.buttonText,
    adminContactButtonEnabled: rules.adminContactButtonEnabled,
    adminContactButtonUrl: rules.adminContactButtonUrl,
    publishedMessageId: rules.publishedMessageId,
    publishedUrl: rules.publishedUrl,
    publishedAt: rules.publishedAt ? rules.publishedAt.toISOString() : null,
  });
}

export function normalizePublishedRulesUrl(value: string | null | undefined): string | null {
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
  if (status === 404) {
    return true;
  }

  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  const normalized = JSON.stringify(responseData ?? '').toLowerCase();
  return normalized.includes('not found') || normalized.includes('message_not_found');
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
  return mapChatRules(hydratedRules);
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
    const maxApiMessage = extractMaxApiErrorMessage(error);
    throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать правила.');
  }

  if (previousPublishedMessageId && previousPublishedMessageId !== published.messageId) {
    const deleteBotId = previousPublishedBotId ?? resolvedBotId;
    try {
      await params.maxClient.deleteMessage(
        params.chatId,
        previousPublishedMessageId,
        buildChatRulesDeleteOptions(deleteBotId),
      );
    } catch (error: unknown) {
      if (!isMaxMessageMissingError(error)) {
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

  const publishedAt = new Date();
  await params.prisma.chatRules.update({
    where: { chatId: params.chatId },
    data: {
      ...(autofilledText !== null ? { text: autofilledText } : {}),
      publishedMessageId: published.messageId,
      publishedBotId: resolvedBotId ?? null,
      publishedUrl: published.url,
      publishedAt,
    },
  });

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
        source: params.source,
      },
    },
  });

  const hydratedRules = await hydratePublishedRulesUrl({
    prisma: params.prisma,
    chatContextCache: params.chatContextCache,
    maxClient: params.maxClient,
    logger: params.logger,
    chatId: params.chatId,
    rules: {
      ...rules,
      ...(autofilledText !== null ? { text: autofilledText } : {}),
      publishedMessageId: published.messageId,
      publishedBotId: resolvedBotId ?? null,
      publishedUrl: published.url,
      publishedAt,
    },
    resolveBotId: () => resolvedBotId,
  });
  await params.chatContextCache.invalidate(params.chatId);

  if (params.source === 'miniapp') {
    await params.sendPrivateConfirmation(hydratedRules.publishedUrl);
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
  chatId: string;
  actorUserId: string;
  source: AdminActionSource;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
}): Promise<ChatRules> {
  const rules = await ensureChatRules({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const publishedMessageId = rules.publishedMessageId?.trim() ?? '';
  const resolvedBotId = normalizeOptionalBotId(await params.resolveBotId());
  const deleteBotId = normalizeOptionalBotId(rules.publishedBotId) ?? resolvedBotId;

  if (publishedMessageId) {
    try {
      await params.maxClient.deleteMessage(
        params.chatId,
        publishedMessageId,
        buildChatRulesDeleteOptions(deleteBotId),
      );
    } catch (error: unknown) {
      if (!isMaxMessageMissingError(error)) {
        const maxApiMessage = extractMaxApiErrorMessage(error);
        throw new BadRequestException(
          maxApiMessage || 'Не удалось удалить опубликованный пост правил.',
        );
      }
    }
  }

  const updatedRules = await params.prisma.chatRules.update({
    where: { chatId: params.chatId },
    data: {
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: null,
      publishedAt: null,
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: 'RESET_CHAT_RULES_PUBLICATION',
      payload: {
        deletedPost: Boolean(publishedMessageId),
        messageId: publishedMessageId || null,
        botId: deleteBotId ?? null,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

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
