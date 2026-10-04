import {
  marketplaceProfileMutationSchema,
  type MarketplaceProfileState,
} from '@maxim/contracts/marketplace-integration';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';

const profiles = new WeakMap<PreviewState, Map<string, MarketplaceProfileState>>();
const requests = new WeakMap<PreviewState, Map<string, MarketplaceProfileState>>();

export const handleMarketplacePreviewRequest: PreviewRequestHandler = ({
  state,
  url,
  segments,
  method,
  init,
}) => {
  if (segments[0] !== 'marketplace') return PREVIEW_NOT_HANDLED;
  if (segments[1] === 'capability' && method === 'GET')
    return { available: state.marketplacePilot };
  if (!state.marketplacePilot) throw new Error('Модуль пока недоступен');
  if (segments[1] !== 'entities' || segments[4] !== 'profile') return PREVIEW_NOT_HANDLED;
  const kind = segments[2] === 'CHANNEL' ? 'CHANNEL' : 'CHAT';
  const entity = (kind === 'CHANNEL' ? state.channels : state.chats).find(
    (item) => item.id === decodeURIComponent(segments[3]),
  );
  if (!entity) throw new Error('Площадка не найдена');
  const profile = url.searchParams.get('profile') === 'publisher' ? 'publisher' : 'moderation';
  const key = `${profile}:${kind}:${entity.id}`;
  const store = profiles.get(state) ?? new Map<string, MarketplaceProfileState>();
  profiles.set(state, store);
  let current = store.get(key);
  if (!current) {
    const now = state.clock.now().toISOString();
    const id =
      kind === 'CHANNEL'
        ? '10000000-0000-4000-8000-000000000002'
        : '10000000-0000-4000-8000-000000000001';
    current = {
      bindingId: id,
      entityId: '-100',
      kind,
      revision: 0,
      listing: null,
      binding: {
        id,
        actorUserId: '100',
        entityId: '-100',
        kind,
        profile,
        state: 'ACTIVE',
        revision: 1,
        checkedAt: now,
        validUntil: new Date(state.clock.now().getTime() + 300_000).toISOString(),
        updatedAt: now,
        generationId: null,
        historyComplete: false,
        historyFrom: null,
        collectionOwner: 'SHADOW',
        collectionMetrics: [],
        statisticsConsent: false,
        statisticsCheckedAt: null,
        metadata: {
          title: entity.title,
          description: 'Новости и обсуждения нашей площадки',
          imageUrl: null,
          publicUrl: null,
          audience: 2500,
          isPublic: true,
        },
      },
      choices: { topics: ['Новости и СМИ', 'Бизнес'], regions: ['Россия', 'Москва'] },
      appendEnabled: false,
      appendRevision: 0,
      available: true,
      buttonDiagnostic: null,
    };
    store.set(key, current);
  }
  if (method === 'GET') return structuredClone(current);
  if (method !== 'POST') return PREVIEW_NOT_HANDLED;
  const input = marketplaceProfileMutationSchema.parse(JSON.parse(String(init.body)));
  const byRequest = requests.get(state) ?? new Map<string, MarketplaceProfileState>();
  requests.set(state, byRequest);
  const prior = byRequest.get(`${key}:${input.requestId}`);
  if (prior) return structuredClone(prior);
  if (
    input.expectedRevision !==
    (input.action === 'toggle' || input.action === 'revoke'
      ? current.appendRevision
      : current.revision)
  )
    throw new Error('Настройки изменились. Обновите данные.');
  if (input.action === 'save') {
    if (!input.details || (!current.binding.statisticsConsent && !input.statisticsConsent))
      throw new Error('Подтвердите передачу статистики');
    current.binding.statisticsConsent = true;
    current.listing = {
      id: current.binding.id,
      status: current.listing?.status ?? 'DRAFT',
      ...input.details,
      publicUrl: current.listing?.publicUrl ?? null,
      profileOnly: true,
    };
    current.revision++;
  } else if (input.action === 'toggle') {
    if (input.appendEnabled && current.listing?.status !== 'PUBLISHED')
      throw new Error('Сначала опубликуйте профиль');
    current.appendEnabled = input.appendEnabled === true;
    current.appendRevision++;
  } else if (input.action === 'revoke') {
    current.binding.statisticsConsent = false;
    current.binding.state = 'REVOKED';
    current.binding.revision++;
    current.appendEnabled = false;
    current.appendRevision++;
    if (current.listing) {
      current.listing.publicUrl = null;
    }
  } else if (current.listing) {
    current.listing.status = input.action === 'publish' ? 'PUBLISHED' : 'PAUSED';
    current.listing.publicUrl =
      input.action === 'publish'
        ? `https://max.ru/svyazka_bot?startapp=listing_${kind.toLowerCase()}_${current.listing.id}`
        : null;
    if (input.action === 'pause') {
      current.appendEnabled = false;
      current.appendRevision++;
    }
    current.revision++;
  }
  const result = structuredClone(current);
  byRequest.set(`${key}:${input.requestId}`, result);
  return result;
};
