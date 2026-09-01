import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
  channelPostSignatureSettingsSchema,
  updateChannelPostSignatureRequestSchema,
  type ChannelPostSignatureSettings,
} from '@maxim/contracts';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxApiTrafficClass,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { ChannelPostSignaturePresentation, ChatEntityType } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

export const CHANNEL_POST_MAX_TEXT_LENGTH = 4_000;

export type ChannelPostText = {
  text: string;
  textFormat?: MaxSendMessageOptions['textFormat'];
  engagementText?: string;
};

@Injectable()
export class ChannelPostSignatureService {
  private readonly logger = new Logger(ChannelPostSignatureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {}

  async getSettings(chatId: string): Promise<ChannelPostSignatureSettings> {
    const settings = await this.prisma.channelSettings.findUnique({
      where: { chatId },
      select: {
        postSignatureEnabled: true,
        postSignaturePresentation: true,
        postSignatureText: true,
        postSignatureUrl: true,
      },
    });
    return channelPostSignatureSettingsSchema.parse({
      enabled: settings?.postSignatureEnabled ?? false,
      presentation:
        settings?.postSignaturePresentation === ChannelPostSignaturePresentation.BUTTON
          ? 'button'
          : 'signature',
      text: settings?.postSignatureText ?? CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
      url: settings?.postSignatureUrl ?? '',
    });
  }

  async updateSettings(
    chatId: string,
    actorUserId: string,
    body: unknown,
  ): Promise<ChannelPostSignatureSettings> {
    const parsed = updateChannelPostSignatureRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    await this.assertChannel(chatId);
    const current = await this.getSettings(chatId);
    const next = channelPostSignatureSettingsSchema.parse({ ...current, ...parsed.data });
    if (next.enabled && !next.url) {
      await this.resolveChannelLink(chatId, 'interactive');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.channelSettings.upsert({
        where: { chatId },
        create: {
          chatId,
          postSignatureEnabled: next.enabled,
          postSignaturePresentation:
            next.presentation === 'button'
              ? ChannelPostSignaturePresentation.BUTTON
              : ChannelPostSignaturePresentation.SIGNATURE,
          postSignatureText: next.text,
          postSignatureUrl: next.url,
        },
        update: {
          postSignatureEnabled: next.enabled,
          postSignaturePresentation:
            next.presentation === 'button'
              ? ChannelPostSignaturePresentation.BUTTON
              : ChannelPostSignaturePresentation.SIGNATURE,
          postSignatureText: next.text,
          postSignatureUrl: next.url,
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId,
          action: 'UPDATE_CHANNEL_POST_SIGNATURE',
          payload: { changed: parsed.data },
        },
      });
    });

    return next;
  }

  async preparePostText(
    chatId: string,
    input: ChannelPostText,
    options: {
      entityType?: 'chat' | 'channel';
      trafficClass?: MaxApiTrafficClass;
      sourceTag?: string;
      maxLength?: number;
    } = {},
  ): Promise<ChannelPostText & { signatureApplied: boolean }> {
    if (options.entityType === 'chat') {
      return { ...input, signatureApplied: false };
    }
    const settings = await this.getSettings(chatId);
    if (!settings.enabled || settings.presentation === 'button') {
      return { ...input, signatureApplied: false };
    }
    await this.assertChannel(chatId);
    const signatureUrl =
      settings.url ||
      (await this.resolveChannelLink(
        chatId,
        options.trafficClass ?? 'background',
        options.sourceTag,
      ));
    const baseHtml =
      input.textFormat === 'html'
        ? input.text
        : input.textFormat === 'markdown'
          ? renderSupportedMarkdownAsHtml(input.text, { blockMode: 'raw' })
          : escapeMaxHtmlText(input.text);
    const signatureHtml = `<a href="${escapeMaxHtmlAttribute(signatureUrl)}">${escapeMaxHtmlText(
      settings.text,
    )}</a>`;
    const normalizedBaseHtml = baseHtml.trim();
    const signatureAlreadyPresent = normalizedBaseHtml.endsWith(signatureHtml);
    const text = signatureAlreadyPresent
      ? normalizedBaseHtml
      : [normalizedBaseHtml, signatureHtml].filter(Boolean).join('\n\n');
    const maxLength = options.maxLength ?? CHANNEL_POST_MAX_TEXT_LENGTH;
    if (text.length > maxLength) {
      throw new BadRequestException(
        `Текст вместе с подписью слишком длинный. Максимум ${maxLength} символов.`,
      );
    }
    if (signatureAlreadyPresent) {
      return {
        ...input,
        text,
        textFormat: 'html',
        signatureApplied: false,
      };
    }
    const engagementText = [
      (input.engagementText ?? input.text).trim(),
      `[${escapeMarkdownLinkLabel(settings.text)}](${escapeMarkdownLinkDestination(signatureUrl)})`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text, textFormat: 'html', engagementText, signatureApplied: true };
  }

  async buildPostButton(
    chatId: string,
    options: {
      entityType?: 'chat' | 'channel';
      trafficClass?: MaxApiTrafficClass;
      sourceTag?: string;
    } = {},
  ): Promise<MaxMessageButton | null> {
    if (options.entityType === 'chat') {
      return null;
    }
    const settings = await this.getSettings(chatId);
    if (!settings.enabled || settings.presentation !== 'button') {
      return null;
    }
    await this.assertChannel(chatId);
    const url =
      settings.url ||
      (await this.resolveChannelLink(
        chatId,
        options.trafficClass ?? 'background',
        options.sourceTag,
      ));
    return {
      type: 'link',
      text: settings.text,
      url,
    };
  }

  async assertChannelLinkAvailable(
    chatId: string,
    trafficClass: MaxApiTrafficClass = 'interactive',
  ): Promise<void> {
    await this.assertChannel(chatId);
    const settings = await this.getSettings(chatId);
    if (settings.url) {
      return;
    }
    await this.resolveChannelLink(chatId, trafficClass);
  }

  private async assertChannel(chatId: string): Promise<void> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (chat?.entityType !== ChatEntityType.CHANNEL) {
      throw new BadRequestException('Подпись публикаций доступна только для канала.');
    }
  }

  private async resolveChannelLink(
    chatId: string,
    trafficClass: MaxApiTrafficClass,
    sourceTag: string = MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
  ): Promise<string> {
    try {
      const audienceSnapshot = await this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId, link: { not: null } },
        orderBy: { capturedAt: 'desc' },
        select: { link: true },
      });
      const knownLink = normalizeMaxChannelLink(audienceSnapshot?.link);
      if (knownLink) {
        return knownLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to read cached channel audience link');
    }

    try {
      const catalogEntry = await this.prisma.managedBotChatCatalog.findFirst({
        where: {
          chatId,
          entityType: ChatEntityType.CHANNEL,
          status: 'ACTIVE',
          link: { not: null },
        },
        orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
        select: { link: true },
      });
      const knownLink = normalizeMaxChannelLink(catalogEntry?.link);
      if (knownLink) {
        return knownLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to read cached managed channel link');
    }

    try {
      const botId = await this.maxBotLinkService.resolveBotIdForSend({ chatId });
      if (!botId) {
        throw new Error('No bot can resolve the MAX channel link');
      }
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId,
        trafficClass,
        sourceTag,
      });
      const resolvedLink = normalizeMaxChannelLink(snapshot.link);
      if (snapshot.entityType === 'channel' && resolvedLink) {
        return resolvedLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to resolve MAX channel post signature link');
      throw new ServiceUnavailableException('Не удалось получить ссылку канала. Повторите позже.');
    }

    throw new BadRequestException('У канала нет публичной ссылки MAX.');
  }
}

function normalizeMaxChannelLink(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (hostname !== 'max.ru' && hostname !== 'www.max.ru') ||
      Boolean(parsed.username || parsed.password || parsed.port) ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.hostname = 'max.ru';
    parsed.hash = '';
    parsed.search = '';
    const canonical = parsed.toString();
    return escapeMaxHtmlAttribute(canonical).length <= CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function escapeMaxHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeMaxHtmlAttribute(value: string): string {
  return escapeMaxHtmlText(value).replace(/"/gu, '&quot;');
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]');
}

function escapeMarkdownLinkDestination(value: string): string {
  return value
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('[', '%5B')
    .replaceAll(']', '%5D');
}
