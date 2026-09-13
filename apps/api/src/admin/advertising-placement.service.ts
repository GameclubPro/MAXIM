import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  advertisingChatIdSchema,
  advertisingLookupSchema,
  advertisingSendInputSchema,
  advertisingSettingsInputSchema,
  type AdvertisingSend,
  type AdvertisingState,
} from '@maxim/contracts/advertising-placement';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { AdvertisingPlacementSend } from '../prisma/prisma-client';
import { MaxClientService, wasMaxMessageSendAttempted } from '../max/max-client.service';
import { ManagedEntitiesService } from './managed-entities.service';

const PILOT_USER_ID = '323459159';
const MARKET_BOT = 'https://max.ru/id613000037577_3_bot';
const LOOKUP_URL = 'https://major-maksimov.ru/market/api/integrations/major/listing';
const UNCERTAIN_AFTER_MS = 90_000;

@Injectable()
export class AdvertisingPlacementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entities: ManagedEntitiesService,
    private readonly max: MaxClientService,
    private readonly config: ConfigService,
  ) {}

  isPilot(user: AuthUser): boolean {
    return user.userId === PILOT_USER_ID;
  }

  private async authorize(chatId: string, user: AuthUser) {
    // FLAG: Client capabilities and launch hints never grant pilot or chat access.
    if (!this.isPilot(user)) throw new ForbiddenException('Модуль пока недоступен');
    advertisingChatIdSchema.parse(chatId);
    await this.entities.assertChatAdminAccess(chatId, user);
  }

  private connectUrl(chatId: string) {
    return `${MARKET_BOT}?startapp=connect_chat_${chatId}`;
  }

  private async lookup(chatId: string) {
    const token = this.config.get<string>('SVYAZKA_INTEGRATION_TOKEN');
    if (!token) throw new ServiceUnavailableException('Связка пока не подключена');
    try {
      const url = new URL(LOOKUP_URL);
      url.searchParams.set('chatId', chatId);
      url.searchParams.set('userId', PILOT_USER_ID);
      const response = await fetch(url, {
        headers: { authorization: `Major ${token}` },
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Lookup rejected');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty lookup');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 8192) throw new Error('Lookup too large');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const result = advertisingLookupSchema.parse(JSON.parse(text));
      if (
        result.connectUrl !== this.connectUrl(chatId) ||
        (result.listing &&
          (result.listing.chatId !== chatId ||
            result.listing.url !== `${MARKET_BOT}?startapp=listing_${result.listing.id}`))
      ) {
        throw new Error('Lookup binding mismatch');
      }
      return result.listing;
    } catch {
      // FLAG: Do not include external bodies, credentials, or raw transport errors.
      throw new ServiceUnavailableException('Не удалось проверить площадку. Повторите проверку');
    }
  }

  private presentSend(row: AdvertisingPlacementSend | null): AdvertisingSend | null {
    if (!row) return null;
    const status =
      row.status === 'SENT'
        ? 'SENT'
        : row.status === 'FAILED'
          ? 'FAILED'
          : row.status === 'SENDING' && Date.now() - row.createdAt.getTime() < UNCERTAIN_AFTER_MS
            ? 'SENDING'
            : 'UNCERTAIN';
    return { id: row.id, status, createdAt: row.createdAt.toISOString() };
  }

  async state(chatId: string, user: AuthUser): Promise<AdvertisingState> {
    await this.authorize(chatId, user);
    const row = await this.prisma.advertisingPlacement.findUnique({ where: { chatId } });
    let lookupFailed = false;
    const listing = await this.lookup(chatId).catch(() => {
      lookupFailed = true;
      return null;
    });
    const lastSend = row?.lastSendId
      ? await this.prisma.advertisingPlacementSend.findUnique({ where: { id: row.lastSendId } })
      : null;
    return {
      enabled: row?.enabled ?? false,
      bindingCurrent: Boolean(listing && row?.listingId === listing.id),
      revision: row?.revision ?? 0,
      listing,
      connectUrl: this.connectUrl(chatId),
      lookupFailed,
      lastSend: this.presentSend(lastSend),
    };
  }

  async update(chatId: string, user: AuthUser, body: unknown) {
    await this.authorize(chatId, user);
    const input = advertisingSettingsInputSchema.parse(body);
    const listing = input.enabled ? await this.lookup(chatId) : null;
    if (input.enabled && !listing)
      throw new ConflictException('Сначала подключите активную площадку в Связке');
    await this.prisma.$transaction(async (tx) => {
      await tx.advertisingPlacement.upsert({ where: { chatId }, create: { chatId }, update: {} });
      const changed = await tx.advertisingPlacement.updateMany({
        where: { chatId, revision: input.revision },
        data: {
          enabled: input.enabled,
          listingId: listing?.id ?? null,
          revision: { increment: 1 },
        },
      });
      if (!changed.count) throw new ConflictException('Настройки изменились. Обновите экран');
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'ADVERTISING_PLACEMENT_SETTINGS',
          payload: { enabled: input.enabled, revision: input.revision + 1 },
        },
      });
    });
    return this.state(chatId, user);
  }

  async send(chatId: string, user: AuthUser, body: unknown): Promise<AdvertisingSend> {
    await this.authorize(chatId, user);
    const input = advertisingSendInputSchema.parse(body);
    const existing = await this.prisma.advertisingPlacementSend.findUnique({
      where: { id: input.requestId },
    });
    if (existing) {
      if (existing.chatId !== chatId)
        throw new ConflictException('Запрос относится к другому чату');
      return this.presentSend(existing)!;
    }
    const listing = await this.lookup(chatId);
    if (!listing) throw new ConflictException('Активная площадка не найдена');
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT chat_id FROM advertising_placements WHERE chat_id=${chatId} FOR UPDATE`;
      const duplicate = await tx.advertisingPlacementSend.findUnique({
        where: { id: input.requestId },
      });
      if (duplicate) {
        if (duplicate.chatId !== chatId)
          throw new ConflictException('Запрос относится к другому чату');
        return { row: duplicate, created: false };
      }
      const settings = await tx.advertisingPlacement.findUnique({ where: { chatId } });
      if (
        !settings?.enabled ||
        settings.revision !== input.revision ||
        settings.listingId !== listing.id ||
        settings.lastSendId !== input.previousSendId
      )
        throw new ConflictException('Настройки изменились. Обновите экран');
      const previous = settings.lastSendId
        ? await tx.advertisingPlacementSend.findUnique({ where: { id: settings.lastSendId } })
        : null;
      const previousStatus = this.presentSend(previous)?.status;
      if (
        previousStatus === 'SENDING' ||
        (previousStatus === 'UNCERTAIN' && !input.acknowledgeUncertain)
      )
        throw new ConflictException('Сначала проверьте результат предыдущей отправки');
      const row = await tx.advertisingPlacementSend.create({
        data: {
          id: input.requestId,
          chatId,
          listingId: listing.id,
          settingsRevision: settings.revision,
        },
      });
      await tx.advertisingPlacement.update({ where: { chatId }, data: { lastSendId: row.id } });
      return { row, created: true };
    });
    if (!claimed.created) return this.presentSend(claimed.row)!;
    let result: Awaited<ReturnType<MaxClientService['sendMessage']>>;
    let dispatchGuardPassed = false;
    try {
      result = await this.max.sendMessage(
        chatId,
        'Реклама и взаимопиар в этом чате',
        {
          buttons: [[{ type: 'link', text: 'Рекламная площадка', url: listing.url }]],
        },
        {
          immediate: true,
          trafficClass: 'interactive',
          sourceTag: 'advertising_placement',
          timeoutMs: 15_000,
          idempotencyKey: `advertising-placement:${input.requestId}`,
          beforeImmediateSendMutation: async () => {
            // FLAG: Check again after routing/rate waits. Disable fences every unattempted send.
            await this.authorize(chatId, user);
            const fresh = await this.lookup(chatId);
            const settings = await this.prisma.advertisingPlacement.findUnique({
              where: { chatId },
            });
            if (
              !fresh ||
              fresh.id !== listing.id ||
              !settings?.enabled ||
              settings.revision !== input.revision ||
              settings.lastSendId !== input.requestId ||
              settings.listingId !== listing.id ||
              Date.now() - claimed.row.createdAt.getTime() >= UNCERTAIN_AFTER_MS
            )
              throw new ConflictException('Отправка отменена: настройки или доступ изменились');
            dispatchGuardPassed = true;
          },
        },
      );
    } catch (error) {
      const row = await this.prisma.advertisingPlacementSend.update({
        where: { id: input.requestId },
        data: {
          status: dispatchGuardPassed || wasMaxMessageSendAttempted(error) ? 'UNCERTAIN' : 'FAILED',
        },
      });
      return this.presentSend(row)!;
    }
    // FLAG: A confirmed send must never enter the failure/retry branch after a database error.
    // The transport ledger retains its receipt; an unfinished local row remains uncertain.
    const row = await this.prisma.advertisingPlacementSend.update({
      where: { id: input.requestId },
      data: result?.messageId
        ? { status: 'SENT', remoteMessageId: result.messageId }
        : { status: 'UNCERTAIN' },
    });
    return this.presentSend(row)!;
  }
}
