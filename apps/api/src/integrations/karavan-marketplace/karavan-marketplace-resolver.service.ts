import { PrismaService } from '../../prisma/prisma.service';
import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  karavanMarketplaceResolveSchema,
  karavanMarketplaceResolveResultSchema,
  type KaravanMarketplaceResolveResult,
} from '@maxim/contracts/karavan-marketplace';
import type { MaxActionJob } from '../../max/max-client.service';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
} from './karavan-marketplace-authority.service';

export const karavanScopedPublicationSchema = z
  .object({
    chatId: z.string(),
    actorMaxUserId: z.string(),
    subjectMaxUserId: z.string(),
    sourceMessageId: z.string(),
    botId: z.string(),
    marketplaceId: z.string().uuid(),
    bindingGeneration: z.number().int().positive(),
    storeId: z.string().uuid().nullable(),
    url: z.string().url(),
    sourceFingerprint: z.string().length(64),
  })
  .strict();
export type KaravanScopedPublication = z.infer<typeof karavanScopedPublicationSchema>;

@Injectable()
export class KaravanMarketplaceResolverService {
  constructor(
    private readonly config: ConfigService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly prisma: PrismaService,
  ) {}
  async shouldUseScopedRelay(chatId: string): Promise<boolean> {
    // FLAG: Enrollment is durable even when the binding is disconnected or the feature is disabled.
    return !!(await this.prisma.karavanMarketplaceChatEnrollment.findUnique({
      where: { chatId },
      select: { chatId: true },
    }));
  }
  enabled(): boolean {
    return this.config.get<boolean>('KARAVAN_MARKETPLACE_ENABLED') === true;
  }

  private buyerUrl(publicSlug: string, storeSlug?: string): string {
    const base = new URL(this.config.getOrThrow<string>('KARAVAN_STOREFRONT_CATALOG_URL'));
    if (base.protocol !== 'https:' || base.hostname !== 'max.ru' || base.username || base.password)
      throw new ServiceUnavailableException('Ссылка магазина не настроена.');
    base.search = '';
    base.hash = '';
    base.searchParams.set('startapp', `m_${publicSlug}${storeSlug ? `__s_${storeSlug}` : ''}`);
    return base.href;
  }

  async resolve(
    input: {
      chatId: string;
      actorMaxUserId: string;
      subjectMaxUserId: string;
      sourceMessageId: string;
      botId: string;
    },
    expected?: KaravanScopedPublication,
  ): Promise<{
    result: KaravanMarketplaceResolveResult;
    publication: KaravanScopedPublication | null;
  }> {
    this.authority.assertEnabled();
    const payload = karavanMarketplaceResolveSchema.parse({
      commandId: `publication:${randomUUID()}`,
      chatId: input.chatId,
      subjectMaxUserId: input.subjectMaxUserId,
      sourceMessageId: input.sourceMessageId,
      storeId: expected?.storeId ?? null,
    });
    const issued = await this.authority.issuePublication(
      {
        actorMaxUserId: input.actorMaxUserId,
        chatId: input.chatId,
        commandId: payload.commandId,
        action: 'resolve_publication',
        marketplaceId: expected?.marketplaceId ?? null,
        expectedBindingGeneration: expected?.bindingGeneration ?? null,
        payloadHash: karavanHash(payload),
      },
      input,
    );
    if (expected && expected.sourceFingerprint !== issued.sourceFingerprint)
      throw new ConflictException('Исходное сообщение изменилось.');
    let result: KaravanMarketplaceResolveResult;
    try {
      const response = await fetch(
        `${this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_API_BASE_URL').replace(/\/$/u, '')}/api/v1/integrations/maxim/marketplaces/resolve`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_COMMAND_TOKEN')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ authority: issued.authority, payload }),
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) throw new Error('Resolver rejected publication');
      result = karavanMarketplaceResolveResultSchema.parse(await response.json());
    } catch {
      throw new ServiceUnavailableException('Не удалось подтвердить витрину в этом чате.');
    }
    if (result.status === 'unbound') return { result, publication: null };
    if (
      !result.marketplace ||
      !result.binding ||
      result.marketplace.status !== 'active' ||
      result.marketplace.kind !== 'chat'
    )
      throw new ConflictException('Магазин недоступен.');
    const store = result.status === 'published' ? result.stores[0] : null;
    if (result.status === 'published' && (result.stores.length !== 1 || !store))
      throw new ConflictException('Витрина не определена.');
    const url = this.buyerUrl(result.marketplace.publicSlug, store?.slug);
    if (store && store.url !== url)
      throw new ConflictException('Адрес витрины не соответствует магазину.');
    const publication: KaravanScopedPublication = {
      ...input,
      marketplaceId: result.marketplace.id,
      bindingGeneration: result.binding.generation,
      storeId: store?.id ?? null,
      url,
      sourceFingerprint: issued.sourceFingerprint,
    };
    if (
      expected &&
      (expected.marketplaceId !== publication.marketplaceId ||
        expected.bindingGeneration !== publication.bindingGeneration ||
        (expected.storeId !== null &&
          (expected.storeId !== publication.storeId || expected.url !== publication.url)))
    )
      throw new ConflictException('Привязка или витрина изменились.');
    return { result, publication };
  }

  async assertDispatch(job: MaxActionJob, candidateBotId: string | null): Promise<void> {
    const raw = job.ledgerContext?.karavanMarketplacePublication;
    if (raw === undefined) return;
    const publication = karavanScopedPublicationSchema.parse(raw);
    if (
      !this.enabled() ||
      this.config.get<boolean>('KARAVAN_STOREFRONT_RELAY_ENABLED') !== true ||
      job.actionType !== 'SEND_MESSAGE' ||
      publication.chatId !== job.chatId ||
      candidateBotId !== publication.botId ||
      job.routing?.requiredBotId !== publication.botId
    )
      throw new ConflictException('Публикация больше недоступна.');
    const result = await this.resolve(publication, publication);
    if (!result.publication) throw new ConflictException('Чат отключён от магазина.');
    // FLAG: The persisted button target is immutable: revalidation cannot silently retarget a queued send.
    const buttons = job.options?.buttons?.flat() ?? [];
    if (!buttons.some((button) => 'url' in button && button.url === publication.url))
      throw new ConflictException('Кнопка магазина изменилась.');
  }
}
