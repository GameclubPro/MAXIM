import {
  marketplaceProfileMutationSchema,
  marketplaceButtonPolicyMutationSchema,
  type MarketplaceButtonPolicyState,
  type MarketplaceProfileState,
} from '@maxim/contracts/marketplace-integration';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';

const profiles = new WeakMap<PreviewState, Map<string, MarketplaceProfileState>>();
const requests = new WeakMap<PreviewState, Map<string, MarketplaceProfileState>>();
const policies = new WeakMap<PreviewState, Map<string, MarketplaceButtonPolicyState>>();
const policyRequests = new WeakMap<
  PreviewState,
  Map<string, { fingerprint: string; state: MarketplaceButtonPolicyState }>
>();
const pendingReadiness = new WeakSet<MarketplaceProfileState>();
const observedProfileRead = new WeakSet<MarketplaceProfileState>();

export const handleMarketplacePreviewRequest: PreviewRequestHandler = ({
  state,
  url,
  segments,
  method,
  init,
}) => {
  if (segments[0] !== 'marketplace') return PREVIEW_NOT_HANDLED;
  if (segments[1] === 'capability' && method === 'GET') return { available: true };
  if (segments[1] === 'launch' && method === 'POST') {
    const input: unknown = JSON.parse(String(init.body));
    if (!input || typeof input !== 'object' || !('target' in input))
      throw new Error('Неверный переход');
    const target = input.target;
    if (target === 'catalog')
      return { url: 'https://max.ru/id613000037577_3_bot?startapp=catalog' };
    if (!('kind' in input) || !['CHAT', 'CHANNEL'].includes(String(input.kind)))
      throw new Error('Неверная площадка');
    const id =
      target === 'connect'
        ? 'entityId' in input
          ? String(input.entityId)
          : ''
        : 'listingId' in input
          ? String(input.listingId)
          : '';
    if (!id || !['connect', 'manage', 'listing'].includes(String(target)))
      throw new Error('Неверный переход');
    return {
      url: `https://max.ru/id613000037577_3_bot?startapp=${String(target)}_${String(input.kind).toLowerCase()}_${id}`,
    };
  }
  if (segments[1] !== 'entities' || !['profile', 'entry', 'button-policy'].includes(segments[4]))
    return PREVIEW_NOT_HANDLED;
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
      listing: state.marketplacePublished
        ? {
            id,
            status: 'PUBLISHED',
            title: entity.title,
            description: 'Новости и обсуждения нашей площадки',
            topic: 'Новости и СМИ',
            region: 'Россия',
            publicUrl: null,
            profileOnly: true,
          }
        : null,
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
        statisticsConsent: state.marketplaceReadiness === 'ready',
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
    if (state.marketplaceReadiness === 'delayed') pendingReadiness.add(current);
  }
  const present = () => {
    const linked = !!current.listing;
    const publicNow = current.listing?.status === 'PUBLISHED' && current.binding.statisticsConsent;
    current.capabilities = {
      canEdit: true,
      canPublish: linked && current.binding.statisticsConsent,
      canPause: current.listing?.status === 'PUBLISHED',
      publicState: publicNow
        ? 'PUBLIC'
        : current.listing?.status === 'PUBLISHED'
          ? 'ACCESS_REQUIRED'
          : current.listing?.status === 'PAUSED'
            ? 'HIDDEN'
            : 'DRAFT',
      placementState: 'BOT_REQUIRED',
      connectUrl: `https://max.ru/id613000037577_3_bot?startapp=connect_${kind.toLowerCase()}_${current.entityId}`,
      manageUrl: current.listing
        ? `https://max.ru/id613000037577_3_bot?startapp=manage_${kind.toLowerCase()}_${current.listing.id}`
        : null,
    };
    if (current.listing)
      current.listing.publicUrl = publicNow
        ? `https://max.ru/id613000037577_3_bot?startapp=listing_${kind.toLowerCase()}_${current.listing.id}`
        : null;
    current.statistics = {
      state: current.binding.statisticsConsent ? 'AVAILABLE' : 'DISABLED',
      observedDays: current.binding.statisticsConsent ? 10 : 0,
      lastObservedAt: current.binding.statisticsConsent ? state.clock.now().toISOString() : null,
      from: null,
      to: null,
    };
    return structuredClone(current);
  };
  if (segments[4] === 'entry' && method === 'GET') {
    const snapshot = present();
    const publiclyVisible = snapshot.capabilities?.publicState === 'PUBLIC';
    const visible = state.marketplaceOwner || publiclyVisible;
    return {
      entityId: current.entityId,
      kind,
      profile,
      publicState: snapshot.listing ? snapshot.capabilities!.publicState : 'ABSENT',
      listing:
        visible && snapshot.listing
          ? {
              id: snapshot.listing.id,
              ownershipKey: 'a'.repeat(64),
              title: snapshot.listing.title,
              publicUrl: snapshot.listing.publicUrl,
              profileOnly: snapshot.listing.profileOnly,
            }
          : null,
      isOwner: state.marketplaceOwner && !!snapshot.listing,
      canCreate: state.marketplaceOwner && !snapshot.listing,
      manageUrl: state.marketplaceOwner ? snapshot.capabilities!.manageUrl : null,
      connectUrl: snapshot.capabilities!.connectUrl,
      checkedAt: state.clock.now().toISOString(),
      validUntil: new Date(state.clock.now().getTime() + 300_000).toISOString(),
    };
  }
  if (segments[4] === 'button-policy') {
    const byEntity = policies.get(state) ?? new Map<string, MarketplaceButtonPolicyState>();
    policies.set(state, byEntity);
    let policy = byEntity.get(key);
    if (!policy) {
      const contexts: MarketplaceButtonPolicyState['contexts'][number]['context'][] =
        profile === 'publisher'
          ? ['PUBLICATIONS']
          : kind === 'CHANNEL'
            ? ['CHANNEL_POSTS']
            : ['GREETINGS', 'MODERATION_NOTICES'];
      policy = {
        entityId: current.entityId,
        kind,
        profile,
        revision: 0,
        contexts: contexts.map((context) => ({
          context,
          enabled: false,
          effective: false,
          status: 'OFF',
          enabledAt: null,
        })),
        buttonDiagnostic: null,
      };
      byEntity.set(key, policy);
    }
    const visible = present().capabilities?.publicState === 'PUBLIC';
    const policyView = () => {
      for (const context of policy.contexts) {
        context.effective = context.enabled && visible;
        context.status = !context.enabled ? 'OFF' : visible ? 'READY' : 'PROFILE_UNAVAILABLE';
      }
      return structuredClone(policy);
    };
    if (method === 'GET') return policyView();
    if (method !== 'POST') return PREVIEW_NOT_HANDLED;
    const input = marketplaceButtonPolicyMutationSchema.parse(JSON.parse(String(init.body)));
    const saved =
      policyRequests.get(state) ??
      new Map<string, { fingerprint: string; state: MarketplaceButtonPolicyState }>();
    policyRequests.set(state, saved);
    const requestKey = `${key}:${input.requestId}`;
    const fingerprint = JSON.stringify(input);
    const previous = saved.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Запрос уже использован');
      return structuredClone(previous.state);
    }
    if (input.expectedRevision !== policy.revision)
      throw new Error('Настройки изменились. Обновите данные.');
    const context = policy.contexts.find((item) => item.context === input.context);
    if (!context) throw new Error('Это место показа недоступно');
    if (input.enabled && !visible) throw new Error('Сначала опубликуйте профиль');
    context.enabled = input.enabled;
    context.enabledAt = input.enabled ? state.clock.now().toISOString() : null;
    policy.revision++;
    const result = policyView();
    saved.set(requestKey, { fingerprint, state: result });
    return result;
  }
  if (!state.marketplaceOwner) throw new Error('Профиль изменяет владелец');
  if (method === 'GET') {
    // Preview models successful re-attestation, never consent restoration.
    current.binding.state = 'ACTIVE';
    if (observedProfileRead.has(current) && pendingReadiness.delete(current))
      current.binding.statisticsConsent = true;
    observedProfileRead.add(current);
    return present();
  }
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
    current.binding.state = 'ACTIVE';
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
    pendingReadiness.delete(current);
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
  const result = present();
  if (input.action === 'toggle' || input.action === 'revoke') {
    delete result.capabilities;
    delete result.statistics;
  }
  byRequest.set(`${key}:${input.requestId}`, result);
  return result;
};
