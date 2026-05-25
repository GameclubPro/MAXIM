import {
  addVkParsingSourceRequestSchema,
  publishVkParsingPostRequestSchema,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type PublishVkParsingPostResult,
  type VkParsingFeed,
  type VkParsingPost,
  type VkParsingRefreshResult,
  type VkParsingSource,
} from '@maxim/contracts';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxAttachmentPayload,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;

type VkWallGetResponse = {
  count?: number;
  items?: unknown[];
  groups?: unknown[];
};

type NormalizedVkSourceInput = {
  domain: string;
  url: string;
};

type NormalizedVkSourceInfo = {
  ownerId: number;
  wallOwnerId: number;
  screenName: string;
  title: string;
  url: string;
};

type NormalizedVkPost = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  url: string;
  photoUrls: string[];
  linkUrls: string[];
  attachments: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
};

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_STATUS_DISABLED = 'DISABLED';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VK_IMAGE_FETCH_TIMEOUT_MS = 15_000;

@Injectable()
export class VkParsingService {
  private readonly logger = new Logger(VkParsingService.name);
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly vkApiBaseUrl: string;
  private readonly vkApiVersion: string;
  private readonly syncIntervalMs: number;
  private readonly fetchCount: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly configService: ConfigService,
  ) {
    this.allowedUserIds = new Set(
      String(configService.get<string>('VK_PARSING_ALLOWED_USER_IDS') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    this.vkApiBaseUrl = this.normalizeBaseUrl(
      configService.get<string>('VK_API_BASE_URL') ?? 'https://api.vk.ru',
    );
    this.vkApiVersion = configService.get<string>('VK_API_VERSION') ?? '5.131';
    this.syncIntervalMs = configService.get<number>('VK_PARSING_SYNC_INTERVAL_MS') ?? 600_000;
    this.fetchCount = configService.get<number>('VK_PARSING_FETCH_COUNT') ?? 20;
  }

  getSyncIntervalMs(): number {
    return this.syncIntervalMs;
  }

  async listVkParsing(chatId: string, user: AuthUser): Promise<VkParsingFeed> {
    await this.assertVkParsingChannelAccess(chatId, user);
    return this.buildFeed(chatId);
  }

  async addSource(chatId: string, user: AuthUser, body: unknown): Promise<VkParsingRefreshResult> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const parsed = addVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = this.normalizeSourceInput(parsed.data.url);
    const wall = await this.fetchWall({ domain: normalized.domain, count: 1 });
    const sourceInfo = this.resolveSourceInfo(normalized, wall);
    const source = await this.prisma.vkParsingSource.upsert({
      where: {
        chatId_wallOwnerId: {
          chatId,
          wallOwnerId: sourceInfo.wallOwnerId,
        },
      },
      create: {
        chatId,
        ownerId: sourceInfo.ownerId,
        wallOwnerId: sourceInfo.wallOwnerId,
        screenName: sourceInfo.screenName,
        title: sourceInfo.title,
        url: sourceInfo.url,
        status: VK_SOURCE_STATUS_ACTIVE,
        createdByUserId: user.userId,
      },
      update: {
        ownerId: sourceInfo.ownerId,
        screenName: sourceInfo.screenName,
        title: sourceInfo.title,
        url: sourceInfo.url,
        status: VK_SOURCE_STATUS_ACTIVE,
        lastError: null,
      },
    });

    const imported = await this.syncSource(source);
    const feed = await this.buildFeed(chatId);
    return { ...feed, imported };
  }

  async removeSource(chatId: string, sourceId: string, user: AuthUser): Promise<VkParsingFeed> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const source = await this.prisma.vkParsingSource.findFirst({
      where: { id: sourceId, chatId },
    });
    if (!source) {
      throw new NotFoundException('VK-источник не найден.');
    }

    await this.prisma.vkParsingSource.update({
      where: { id: source.id },
      data: { status: VK_SOURCE_STATUS_DISABLED },
    });
    return this.buildFeed(chatId);
  }

  async refresh(chatId: string, user: AuthUser): Promise<VkParsingRefreshResult> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
      orderBy: [{ createdAt: 'asc' }],
    });

    let imported = 0;
    for (const source of sources) {
      imported += await this.syncSource(source);
    }

    const feed = await this.buildFeed(chatId);
    return { ...feed, imported };
  }

  async syncDueSources(): Promise<void> {
    const dueBefore = new Date(Date.now() - this.syncIntervalMs);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        status: VK_SOURCE_STATUS_ACTIVE,
        OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: dueBefore } }],
      },
      orderBy: [{ lastSyncAt: 'asc' }, { createdAt: 'asc' }],
      take: 50,
    });

    for (const source of sources) {
      await this.syncSource(source);
    }
  }

  async publishPost(
    chatId: string,
    postId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublishVkParsingPostResult> {
    await this.assertVkParsingChannelAccess(chatId, user);
    const parsed = publishVkParsingPostRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');
    const text = this.composePublishText(parsed.data.text, linkUrls);
    if (text.length > VK_PARSING_MAX_PUBLISH_TEXT_LENGTH) {
      throw new BadRequestException(
        `Текст публикации слишком длинный. Максимум ${VK_PARSING_MAX_PUBLISH_TEXT_LENGTH} символов.`,
      );
    }

    const botId = await this.maxBotLinkService.resolveBotId({ chatId });
    const requestOptions = {
      botId,
      trafficClass: 'interactive' as const,
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    };
    const options: MaxSendMessageOptions = {
      debugContext: {
        screen: 'vk_parsing',
        action: 'publish_post',
      },
    };

    try {
      const engagementContext = await this.adminService.buildChannelPublicationEngagementContext(
        chatId,
        botId,
      );
      if (engagementContext.buttons.length > 0) {
        options.buttons = engagementContext.buttons;
      }

      const imagePayloads = [];
      for (let index = 0; index < photoUrls.length; index += 1) {
        const image = await this.downloadImage(photoUrls[index]!, index);
        const uploaded = await this.maxClient.uploadImage(
          image.buffer,
          image.fileName,
          image.mimeType,
          requestOptions,
        );
        imagePayloads.push(uploaded);
      }

      if (imagePayloads.length === 1) {
        options.imagePayload = imagePayloads[0];
      } else if (imagePayloads.length > 1) {
        options.attachments = imagePayloads.map(
          (payload): MaxAttachmentPayload => ({
            type: 'image',
            payload,
          }),
        );
      }

      const result = await this.maxClient.sendMessageImmediateWithResolvedLink(
        chatId,
        text || ' ',
        options,
        requestOptions,
      );
      await this.recordChannelPublicationEngagementSafely({
        chatId,
        actorUserId: user.userId,
        messageId: result.messageId,
        engagementContext,
        botId,
      });
      const updated = await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_PUBLISHED,
          publishedMessageId: result.messageId,
          publishedUrl: result.url,
          publishedAtMax: new Date(),
          lastError: null,
        },
        include: { source: true },
      });

      return {
        post: this.mapPost(updated),
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      await this.prisma.vkParsingPost.update({
        where: { id: post.id },
        data: {
          status: VK_POST_STATUS_FAILED,
          lastError: this.formatError(error),
        },
      });
      throw error;
    }
  }

  private async recordChannelPublicationEngagementSafely(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    engagementContext: Awaited<
      ReturnType<AdminService['buildChannelPublicationEngagementContext']>
    >;
    botId?: string | null;
  }): Promise<void> {
    try {
      await this.adminService.recordChannelPublicationEngagement({
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        messageId: params.messageId,
        context: params.engagementContext,
        source: 'vk_parsing',
        botId: params.botId,
      });
    } catch (error) {
      this.logger.warn(
        {
          chatId: params.chatId,
          messageId: params.messageId,
          err: error,
        },
        'Failed to record VK parsing channel engagement binding',
      );
    }
  }

  private async assertVkParsingChannelAccess(chatId: string, user: AuthUser): Promise<void> {
    if (!this.allowedUserIds.has(user.userId)) {
      throw new ForbiddenException('ВК-парсинг недоступен для этого пользователя.');
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (!chat) {
      throw new NotFoundException('Канал не найден.');
    }
    if (chat.entityType !== ChatEntityType.CHANNEL) {
      throw new BadRequestException('ВК-парсинг доступен только для каналов.');
    }

    await this.adminService.assertChatAdmin(chatId, user.userId, 'channel');
  }

  private async buildFeed(chatId: string): Promise<VkParsingFeed> {
    const [sources, posts] = await Promise.all([
      this.prisma.vkParsingSource.findMany({
        where: { chatId, status: VK_SOURCE_STATUS_ACTIVE },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.prisma.vkParsingPost.findMany({
        where: { chatId, source: { status: VK_SOURCE_STATUS_ACTIVE } },
        include: { source: true },
        orderBy: [{ vkPublishedAt: 'desc' }, { createdAt: 'desc' }],
        take: 50,
      }),
    ]);

    return {
      sources: sources.map((source) => this.mapSource(source)),
      posts: posts.map((post) => this.mapPost(post)),
    };
  }

  private async syncSource(source: VkParsingSourceRow): Promise<number> {
    try {
      const wall = await this.fetchWall({ ownerId: source.wallOwnerId, count: this.fetchCount });
      const posts = (wall.items ?? [])
        .map((item) => this.normalizePost(item))
        .filter((post): post is NormalizedVkPost => post !== null);

      let imported = 0;
      for (const post of posts) {
        const created = await this.upsertPost(source, post);
        if (created) {
          imported += 1;
        }
      }

      await this.prisma.vkParsingSource.update({
        where: { id: source.id },
        data: {
          lastSyncAt: new Date(),
          lastError: null,
        },
      });
      return imported;
    } catch (error) {
      const lastError = this.formatError(error);
      await this.prisma.vkParsingSource.update({
        where: { id: source.id },
        data: {
          lastSyncAt: new Date(),
          lastError,
        },
      });
      this.logger.warn(
        { sourceId: source.id, chatId: source.chatId, err: error },
        'VK sync failed',
      );
      return 0;
    }
  }

  private async upsertPost(source: VkParsingSourceRow, post: NormalizedVkPost): Promise<boolean> {
    const existing = await this.prisma.vkParsingPost.findUnique({
      where: {
        chatId_vkOwnerId_vkPostId: {
          chatId: source.chatId,
          vkOwnerId: post.vkOwnerId,
          vkPostId: post.vkPostId,
        },
      },
      select: { id: true },
    });

    await this.prisma.vkParsingPost.upsert({
      where: {
        chatId_vkOwnerId_vkPostId: {
          chatId: source.chatId,
          vkOwnerId: post.vkOwnerId,
          vkPostId: post.vkPostId,
        },
      },
      create: {
        sourceId: source.id,
        chatId: source.chatId,
        vkOwnerId: post.vkOwnerId,
        vkPostId: post.vkPostId,
        vkPublishedAt: post.vkPublishedAt,
        text: post.text,
        url: post.url,
        photoUrls: post.photoUrls,
        linkUrls: post.linkUrls,
        attachments: this.toJsonInput(post.attachments),
        raw: this.toJsonInput(post.raw),
        status: VK_POST_STATUS_NEW,
      },
      update: {
        sourceId: source.id,
        vkPublishedAt: post.vkPublishedAt,
        text: post.text,
        url: post.url,
        photoUrls: post.photoUrls,
        linkUrls: post.linkUrls,
        attachments: this.toJsonInput(post.attachments),
        raw: this.toJsonInput(post.raw),
      },
    });

    return existing === null;
  }

  private normalizeSourceInput(input: string): NormalizedVkSourceInput {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new BadRequestException('Укажите ссылку на VK-сообщество.');
    }

    let sourcePath = trimmed;
    if (/^https?:\/\//iu.test(trimmed) || /^(?:www\.|m\.)?(?:vk\.com|vk\.ru)\//iu.test(trimmed)) {
      const url = new URL(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
      const host = url.hostname
        .replace(/^www\./iu, '')
        .replace(/^m\./iu, '')
        .toLowerCase();
      if (host !== 'vk.com' && host !== 'vk.ru') {
        throw new BadRequestException('Поддерживаются только ссылки vk.ru и vk.com.');
      }

      const segment = url.pathname
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)[0];
      if (!segment) {
        throw new BadRequestException('Укажите ссылку на VK-сообщество.');
      }
      sourcePath = segment;
    }

    const domain = sourcePath.replace(/^@/u, '').trim();
    if (/^(?:wall|photo|video|album|topic)-?\d+/iu.test(domain)) {
      throw new BadRequestException('Нужна ссылка на сообщество, не на отдельный материал.');
    }
    if (!/^[A-Za-z0-9_.-]{2,80}$/u.test(domain)) {
      throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
    }

    return {
      domain,
      url: `https://vk.ru/${domain}`,
    };
  }

  private resolveSourceInfo(
    input: NormalizedVkSourceInput,
    wall: VkWallGetResponse,
  ): NormalizedVkSourceInfo {
    const group = (wall.groups ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const firstPost = (wall.items ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const groupId = this.readNumber(group?.id) ?? this.resolveGroupIdFromPost(firstPost ?? null);
    if (!groupId) {
      throw new BadRequestException('VK-сообщество не найдено или недоступно.');
    }

    const screenName = this.readString(group?.screen_name) || input.domain;
    const title = this.readString(group?.name) || screenName;
    return {
      ownerId: groupId,
      wallOwnerId: -Math.abs(groupId),
      screenName,
      title,
      url: `https://vk.ru/${screenName}`,
    };
  }

  private resolveGroupIdFromPost(post: Record<string, unknown> | null): number | null {
    const ownerId = this.readNumber(post?.owner_id);
    if (typeof ownerId !== 'number' || ownerId >= 0) {
      return null;
    }

    return Math.abs(ownerId);
  }

  private normalizePost(value: unknown): NormalizedVkPost | null {
    const post = this.asRecord(value);
    if (!post) {
      return null;
    }

    const vkOwnerId = this.readNumber(post.owner_id);
    const vkPostId = this.readNumber(post.id);
    if (typeof vkOwnerId !== 'number' || typeof vkPostId !== 'number') {
      return null;
    }

    const attachments = this.readAttachments(post.attachments);
    const photoUrls = this.extractPhotoUrls(attachments);
    const linkUrls = this.extractLinkUrls(attachments);
    const text = this.readString(post.text);
    if (!text.trim() && photoUrls.length === 0 && linkUrls.length === 0) {
      return null;
    }

    const publishedSeconds = this.readNumber(post.date);
    const vkPublishedAt =
      typeof publishedSeconds === 'number' && publishedSeconds > 0
        ? new Date(publishedSeconds * 1_000)
        : null;

    return {
      vkOwnerId,
      vkPostId,
      vkPublishedAt,
      text,
      url: `https://vk.ru/wall${vkOwnerId}_${vkPostId}`,
      photoUrls,
      linkUrls,
      attachments,
      raw: post,
    };
  }

  private readAttachments(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private extractPhotoUrls(attachments: Array<Record<string, unknown>>): string[] {
    const urls = new Set<string>();
    for (const attachment of attachments) {
      if (this.readString(attachment.type) !== 'photo') {
        continue;
      }

      const photo = this.asRecord(attachment.photo);
      const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
      const best = sizes
        .map((item) => this.asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((size) => ({
          url: this.normalizeHttpUrl(this.readString(size.url)),
          area:
            Math.max(0, this.readNumber(size.width) ?? 0) *
            Math.max(0, this.readNumber(size.height) ?? 0),
        }))
        .filter((size): size is { url: string; area: number } => Boolean(size.url))
        .sort((left, right) => right.area - left.area)[0];

      if (best?.url) {
        urls.add(best.url);
      }
    }

    return [...urls].slice(0, VK_PARSING_MAX_PHOTOS);
  }

  private extractLinkUrls(attachments: Array<Record<string, unknown>>): string[] {
    const urls = new Set<string>();
    for (const attachment of attachments) {
      if (this.readString(attachment.type) !== 'link') {
        continue;
      }

      const link = this.asRecord(attachment.link);
      const url = this.normalizeHttpUrl(this.readString(link?.url));
      if (url) {
        urls.add(url);
      }
    }

    return [...urls];
  }

  private async fetchWall(options: {
    domain?: string;
    ownerId?: number;
    count: number;
  }): Promise<VkWallGetResponse> {
    const params: Record<string, string> = {
      count: String(Math.max(1, Math.min(options.count, 50))),
      filter: 'owner',
      extended: '1',
    };
    if (options.domain) {
      params.domain = options.domain;
    }
    if (typeof options.ownerId === 'number') {
      params.owner_id = String(options.ownerId);
    }

    const response = await this.requestVk('wall.get', params);
    if (!this.asRecord(response)) {
      throw new BadRequestException('VK вернул пустой ответ.');
    }

    return response as VkWallGetResponse;
  }

  private async requestVk(method: string, params: Record<string, string>): Promise<unknown> {
    const token = this.configService.get<string>('VK_SERVICE_TOKEN')?.trim();
    if (!token) {
      throw new ServiceUnavailableException('VK_SERVICE_TOKEN не настроен.');
    }

    const search = new URLSearchParams({
      ...params,
      v: this.vkApiVersion,
    });
    let response: Response;
    try {
      response = await fetch(`${this.vkApiBaseUrl}/method/${method}?${search.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new ServiceUnavailableException('VK API временно недоступен.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ServiceUnavailableException('VK API вернул нечитаемый ответ.');
    }

    const record = this.asRecord(payload);
    if (!response.ok) {
      throw new ServiceUnavailableException(`VK API вернул статус ${response.status}.`);
    }

    const error = this.asRecord(record?.error);
    if (error) {
      const code = this.readNumber(error.error_code);
      const message = this.readString(error.error_msg) || 'VK API отклонил запрос.';
      throw new BadRequestException(code ? `VK API: ${message} (${code})` : `VK API: ${message}`);
    }

    return record?.response;
  }

  private async downloadImage(
    imageUrl: string,
    index: number,
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Фото VK должно быть доступно по HTTPS.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed, { signal: controller.signal });
      if (!response.ok) {
        throw new BadRequestException('Не удалось скачать фото из VK.');
      }

      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > VK_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото из VK слишком большое.');
      }

      const mimeType = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
      if (!mimeType.toLowerCase().startsWith('image/')) {
        throw new BadRequestException('VK вернул не изображение.');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > VK_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото из VK слишком большое.');
      }

      return {
        buffer,
        fileName: this.resolveImageFileName(parsed, index),
        mimeType,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveImageFileName(url: URL, index: number): string {
    const rawName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 120);
    if (safeName && /\.[A-Za-z0-9]{2,6}$/u.test(safeName)) {
      return safeName;
    }

    return `vk-photo-${index + 1}.jpg`;
  }

  private composePublishText(text: string, linkUrls: string[]): string {
    const base = text.trim();
    const missingLinks = linkUrls.filter((url) => !base.includes(url));
    return [base, ...missingLinks].filter(Boolean).join('\n');
  }

  private assertSelectedUrls(selected: string[], stored: string[], label: string): string[] {
    const storedSet = new Set(stored);
    const normalized = [...new Set(selected.map((url) => url.trim()).filter(Boolean))];
    const forbidden = normalized.find((url) => !storedSet.has(url));
    if (forbidden) {
      throw new BadRequestException(`Нельзя опубликовать неизвестную ${label}.`);
    }

    return normalized;
  }

  private mapSource(source: VkParsingSourceRow): VkParsingSource {
    return {
      id: source.id,
      chatId: source.chatId,
      ownerId: source.ownerId,
      wallOwnerId: source.wallOwnerId,
      screenName: source.screenName,
      title: source.title,
      url: source.url,
      status: source.status === VK_SOURCE_STATUS_DISABLED ? 'DISABLED' : 'ACTIVE',
      lastSyncAt: source.lastSyncAt ? source.lastSyncAt.toISOString() : null,
      lastError: source.lastError,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    };
  }

  private mapPost(post: VkParsingPostWithSource): VkParsingPost {
    const status =
      post.status === VK_POST_STATUS_PUBLISHED
        ? 'PUBLISHED'
        : post.status === VK_POST_STATUS_FAILED
          ? 'FAILED'
          : 'NEW';
    return {
      id: post.id,
      sourceId: post.sourceId,
      chatId: post.chatId,
      sourceTitle: post.source.title,
      sourceUrl: post.source.url,
      vkOwnerId: post.vkOwnerId,
      vkPostId: post.vkPostId,
      vkPublishedAt: post.vkPublishedAt ? post.vkPublishedAt.toISOString() : null,
      text: post.text,
      url: post.url,
      photoUrls: this.readStringArray(post.photoUrls),
      linkUrls: this.readStringArray(post.linkUrls),
      status,
      publishedMessageId: post.publishedMessageId,
      publishedUrl: post.publishedUrl,
      publishedAtMax: post.publishedAtMax ? post.publishedAtMax.toISOString() : null,
      lastError: post.lastError,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
    };
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/u, '');
  }

  private normalizeHttpUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim().slice(0, 500);
    }

    return 'Неизвестная ошибка VK-парсинга.';
  }
}
