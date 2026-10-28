import {
  marketplaceLaunchInputSchema,
  marketplaceLaunchResponseSchema,
} from '@maxim/contracts/marketplace-integration';
import type { ApiTransport } from './api/transport';
import { openMaxBotLink } from './max-bridge';

export const BIRZHIK_BOT_URL = 'https://max.ru/id613000037577_3_bot';
export const BIRZHIK_CATALOG_URL = `${BIRZHIK_BOT_URL}?startapp=catalog`;
export type MarketplaceLaunchTarget = {
  target: 'catalog' | 'listing' | 'manage' | 'connect';
  kind?: 'CHAT' | 'CHANNEL';
  entityId?: string;
  listingId?: string;
};

export function marketplaceTargetFromLink(
  value: string,
  kind: 'CHAT' | 'CHANNEL',
  entityId: string,
): MarketplaceLaunchTarget | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin + url.pathname !== BIRZHIK_BOT_URL || url.username || url.password) return null;
  const payload = url.searchParams.get('startapp');
  const listing =
    /^(listing|manage)_(channel|chat)_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.exec(
      payload ?? '',
    );
  if (listing && listing[2].toUpperCase() === kind)
    return {
      target: listing[1].toLowerCase() as 'listing' | 'manage',
      kind,
      entityId,
      listingId: listing[3],
    };
  if (payload === `connect_${kind.toLowerCase()}_${entityId}`)
    return { target: 'connect', kind, entityId };
  return null;
}

export async function openMarketplace(api: ApiTransport, target: MarketplaceLaunchTarget) {
  const result = marketplaceLaunchResponseSchema.parse(
    await api.request('/marketplace/launch', {
      method: 'POST',
      body: JSON.stringify(marketplaceLaunchInputSchema.parse(target)),
    }),
  );
  const url = new URL(result.url);
  if (
    url.origin + url.pathname !== BIRZHIK_BOT_URL ||
    url.username ||
    url.password ||
    !url.searchParams.get('startapp') ||
    url.searchParams.get('startapp')!.length > 128
  )
    throw new Error('Не удалось открыть Биржик. Повторите переход.');
  openMaxBotLink(url.href);
}
