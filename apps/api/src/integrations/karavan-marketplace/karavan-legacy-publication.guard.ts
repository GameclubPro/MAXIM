import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MaxActionJob } from '../../max/max-client.service';

const legacyContext = z.object({
  storefrontOwnerUserId: z.string().min(1).max(100),
  storeId: z.string().nullable(),
  variant: z.enum(['storefront', 'directory']),
});
const legacyLookup = z.object({
  exists: z.boolean(),
  store: z.object({ id: z.string(), url: z.string().url() }).nullable(),
});

export async function assertKaravanLegacyPublication(
  config: ConfigService,
  prisma: PrismaService,
  job: MaxActionJob,
): Promise<void> {
  const context = legacyContext.safeParse(job.ledgerContext?.karavanStorefrontRelay);
  if (!context.success || config.get<boolean>('KARAVAN_STOREFRONT_RELAY_ENABLED') !== true)
    throw new ConflictException('Публикация магазина больше недоступна.');
  // FLAG: Enrollment and the remote retirement decision fence old jobs at the actual SEND boundary.
  if (
    await prisma.karavanMarketplaceChatEnrollment.findUnique({
      where: { chatId: job.chatId },
      select: { chatId: true },
    })
  )
    throw new ConflictException('Для этого чата требуется ссылка его магазина.');
  const base = config.get<string>('KARAVAN_API_BASE_URL')?.replace(/\/+$/u, '');
  const token = config.get<string>('KARAVAN_INTEGRATION_TOKEN');
  if (!base || !token) throw new ServiceUnavailableException('Проверка магазина недоступна.');
  let response: Response;
  try {
    response = await fetch(
      `${base}/v1/integrations/maxim/storefronts/by-max-user/${encodeURIComponent(context.data.storefrontOwnerUserId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch {
    throw new ServiceUnavailableException('Не удалось проверить магазин.');
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 429)
      throw new ServiceUnavailableException('Не удалось проверить магазин.');
    throw new ConflictException('Для публикации выберите магазин чата.');
  }
  const parsed = legacyLookup.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ServiceUnavailableException('Не удалось проверить магазин.');
  const buttons = job.options?.buttons?.flat() ?? [];
  if (context.data.variant === 'storefront') {
    const store = parsed.data.exists ? parsed.data.store : null;
    if (
      !store ||
      store.id !== context.data.storeId ||
      !buttons.length ||
      buttons.some((button) => !('url' in button) || button.url !== store.url)
    )
      throw new ConflictException('Витрина изменилась. Повторите публикацию из чата.');
  }
  // FLAG: A binding may be committed while the authoritative lookup is in flight.
  if (
    await prisma.karavanMarketplaceChatEnrollment.findUnique({
      where: { chatId: job.chatId },
      select: { chatId: true },
    })
  )
    throw new ConflictException('Для этого чата требуется ссылка его магазина.');
}
