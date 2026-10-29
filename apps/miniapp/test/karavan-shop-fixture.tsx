import '../src/styles.css';
import React from 'react';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { SettingsStorefrontSection } from '../src/pages/settings/settings-storefront-section';
import '../src/pages/settings-page';
import '../src/styles/moderation-workspace.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.maxTheme = params.get('theme') ?? 'light';
document.body.dataset.miniappProfile = 'moderation';
document.body.classList.add('settings-home-page-open');
const id = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const second = 'bb669048-0279-4a35-987c-60f94593163e';
const market = {
  id,
  networkId: second,
  publicSlug: 'synthetic-shop',
  name: 'Магазин соседей',
  description: null,
  kind: 'chat',
  status: 'active',
  admissionPolicy: 'applications',
  logoImageUrl: null,
  coverImageUrl: null,
  editRevision: 1,
  policyRevision: 1,
  orderRevision: 1,
  visibilityRevision: 1,
};
const rules = {
  id: second,
  text: 'Правила магазина',
  allowedCategoryIds: ['services', 'grocery'],
  allowedSubcategoryIds: ['services.repair', 'grocery.bread'],
  categoryOrder: ['services', 'grocery'],
  version: 1,
  effectiveAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  requiresAcceptance: true,
};
const binding = {
  id: second,
  chatId: '-123',
  chatTitle: 'Соседи',
  state: 'verified',
  generation: 1,
  revision: 1,
  verifiedAt: new Date().toISOString(),
};
const permissions = ['manage_marketplace', 'review_listing', 'arrange_listings', 'bind_chat'];
const counts = {
  listings: 2,
  readyListings: 0,
  approvedListings: 2,
  pendingApplications: 1,
  chats: 1,
};
const offer = {
  id,
  storeId: second,
  kind: 'product',
  title: 'Ремонт стиральной машины с выездом на дом',
  storeName: 'Мастерская соседей',
  imageUrl: null,
  available: true,
  allowedCategory: true,
  restriction: null,
};
const appearance = {
  name: market.name,
  description: null,
  logoImageUrl: null,
  coverImageUrl: null,
  accent: 'blue',
  blocks: [
    { id: 'categories', visible: true },
    { id: 'pinned', visible: true },
    { id: 'sellers', visible: true },
  ],
};
let design = { draft: appearance, published: appearance, revision: 1, hasChanges: false };
let pins = { revision: 1, offers: [] as (typeof offer)[] };
let catalogReads = 0;
let pendingApplication = true;
let rulesConflict = true;
const state = window as Window & {
  __shopRequests: Array<{ path: string; body: any }>;
  __shopOpened: string[];
  __shopPublished: typeof appearance;
  WebApp: unknown;
  __shopSaves: unknown[];
};
state.__shopRequests = [];
state.__shopOpened = [];
state.__shopPublished = appearance;
state.__shopSaves = [];
const bridge = (window as any).MAX?.WebApp ?? {};
Object.assign(bridge, {
  openMaxLink: (url: string) => state.__shopOpened.push(url),
  close: () => {},
});
state.WebApp = bridge;
const api = {
  request: async (path: string, init: { body?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    state.__shopRequests.push({ path, body });
    if (path.endsWith('/handoffs'))
      return {
        url: 'https://max.ru/synthetic_buyer_bot?startapp=mh_' + 'x'.repeat(43),
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };
    if (path.endsWith('/setup-options'))
      return {
        chatTitle: 'Соседи',
        categories: [
          {
            id: 'services',
            label: 'Услуги',
            subcategories: [
              { id: 'services.repair', label: 'Ремонт' },
              { id: 'services.beauty', label: 'Красота' },
            ],
          },
          {
            id: 'grocery',
            label: 'Продукты',
            subcategories: [{ id: 'grocery.bread', label: 'Хлеб' }],
          },
        ],
      };
    if (path.endsWith('/manage')) {
      const { operation, input } = body.command;
      let data;
      if (operation === 'detail')
        data = {
          marketplace: market,
          rules,
          scheduledRules: null,
          permissions,
          counts,
          bindings: [binding],
        };
      else if (operation === 'catalog') {
        if (params.get('scenario') === 'error' && catalogReads++ === 0) throw new Error('Offline');
        data = {
          items:
            params.get('scenario') === 'empty' ||
            (input.q && !offer.title.toLowerCase().includes(input.q.toLowerCase()))
              ? []
              : [offer],
          nextCursor: null,
        };
      } else if (operation === 'pins') data = pins;
      else if (operation === 'pins_save') {
        pins = { revision: pins.revision + 1, offers: input.offers.map(() => offer) };
        data = pins;
      } else if (operation === 'moderate_content') {
        offer.restriction = { revision: 1, active: input.active, reason: input.reason } as never;
        offer.available = !input.active;
        data = { restriction: { id, ...offer.restriction! }, visibilityRevision: 2 };
      } else if (operation === 'appearance') data = design;
      else if (operation === 'appearance_save') {
        design = {
          ...design,
          draft: input.appearance,
          hasChanges: true,
          revision: design.revision + 1,
        };
        data = design;
      } else if (operation === 'appearance_publish') {
        design = {
          ...design,
          published: design.draft,
          hasChanges: false,
          revision: design.revision + 1,
        };
        state.__shopPublished = design.published;
        data = design;
      } else if (operation === 'applications')
        data = {
          applications: pendingApplication
            ? [
                {
                  id,
                  listingId: second,
                  marketplaceId: id,
                  storeId: second,
                  storeName: 'Мастерская',
                  revision: 1,
                  attempt: 1,
                  state: 'pending',
                  profileVersionId: id,
                  profile: {
                    name: 'Мастерская',
                    description: 'Ремонт техники',
                    logoImageUrl: null,
                    coverImageUrl: null,
                  },
                  publishedProfile: null,
                  rulesVersion: rules,
                  submittedAt: new Date().toISOString(),
                  decidedAt: null,
                  reason: null,
                  canReview: true,
                },
              ]
            : [],
          nextCursor: null,
        };
      else if (operation === 'decide') {
        pendingApplication = false;
        counts.pendingApplications = 0;
        data = {
          listing: {
            id: second,
            marketplaceId: id,
            storeId: second,
            storeName: 'Мастерская',
            marketplaceName: market.name,
            revision: 2,
            reviewState: 'approved',
            sellerState: 'enabled',
            publicationReason: 'published',
            rank: '1',
            approvedProfileVersionId: id,
            pendingApplicationId: null,
            acceptedRulesVersion: 1,
            requiredRulesVersion: 1,
            decisionReason: null,
          },
        };
      } else if (operation === 'listings')
        data = { listings: [], nextCursor: null, orderRevision: 1, total: 0, orderableTotal: 0 };
      else if (operation === 'rules_preview')
        data = {
          fingerprint: 'a'.repeat(64),
          calculatedAt: new Date().toISOString(),
          hiddenOffers: 1,
          affectedStores: 1,
          emptiedStores: 0,
          affectedChats: 1,
          stores: [],
          hasMoreStores: false,
        };
      else if (operation === 'rules_update') {
        if (rulesConflict) {
          rulesConflict = false;
          market.policyRevision++;
          throw new ApiRequestError(409, '{}', 'Правила изменились. Обновите данные.');
        }
        Object.assign(rules, input.rules);
        data = {
          rules: { ...rules, version: 2, effectiveAt: input.effectiveAt },
          policyRevision: 2,
        };
      } else throw new Error('Unexpected operation: ' + operation);
      return { operation, data };
    }
    if (path.endsWith('/karavan-marketplace'))
      return {
        enabled: true,
        actorMaxUserId: '777',
        sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
        marketplace: market,
        binding,
        permissions,
        counts,
        canManage: true,
        buyerUrl: 'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop',
        previewUrl: 'https://max.ru/synthetic_buyer_bot?startapp=mp_synthetic-shop',
        bindings: [binding],
        publicationChoices: [],
        setupOperation: null,
      };
    throw new Error('Unexpected request: ' + path);
  },
  requestKeepalive: () => {},
};
const initial = {
  karavanStorefrontEnabled: true,
  karavanStorefrontAdminsOnly: false,
  karavanStorefrontMessageText: '',
  karavanStorefrontOpenButtonText: '',
  karavanStorefrontCatalogButtonText: '',
  karavanStorefrontCreateButtonText: '',
};
function Harness() {
  const [open, setOpen] = React.useState(false),
    [draft, setDraft] = React.useState(initial),
    [saved, setSaved] = React.useState(initial);
  const change = (key: string, value: unknown) => setDraft((old) => ({ ...old, [key]: value }));
  return (
    <SettingsStorefrontSection
      api={api}
      chatId="-123"
      draft={draft}
      expanded={open}
      summary=""
      status=""
      hasChanges={JSON.stringify(draft) !== JSON.stringify(saved)}
      onToggleSection={() => setOpen(!open)}
      onDiscardChanges={() => setDraft(saved)}
      onFieldChange={(value) => change('karavanStorefrontEnabled', value)}
      onAdminsOnlyChange={(value) => change('karavanStorefrontAdminsOnly', value)}
      onTextChange={change}
      footer={
        <button
          type="button"
          onClick={() => {
            state.__shopSaves.push(draft);
            setSaved(draft);
          }}
        >
          Сохранить
        </button>
      }
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <ToastProvider>
      <Harness />
    </ToastProvider>
  </QueryClientProvider>,
);
