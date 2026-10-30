import '../../../styles/karavan-shop.css';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  StorefrontScreen,
  useStorefrontWorkspace,
  type StorefrontPage,
} from '../storefront-workspace';
import {
  SettingsSectionToggle,
  type SettingsSectionIconName,
} from '../../../components/ui/settings-section-toggle';
import { ShopContext, ShopLoading, useShopMutation, MutationFailure } from './runtime';
const Catalog = lazy(() => import('./catalog'));
const Applications = lazy(() => import('./applications'));
const Appearance = lazy(() => import('./appearance'));
const Categories = lazy(() => import('./categories'));
const entries: Array<{ id: StorefrontPage; label: string; icon: SettingsSectionIconName }> = [
  { id: 'catalog', label: 'Каталог', icon: 'storefront' },
  { id: 'applications', label: 'Заявки', icon: 'comments' },
  { id: 'appearance', label: 'Оформление', icon: 'spark' },
  { id: 'categories', label: 'Категории и правила', icon: 'tools' },
  { id: 'chats', label: 'Чаты', icon: 'links' },
  { id: 'publications', label: 'Кнопка в чате', icon: 'send' },
];
type Props = {
  api: ApiTransport;
  chatId: string;
  module: KaravanMarketplaceModule;
  busy: boolean;
  open: () => void;
  chats: ReactNode;
  publications?: ReactNode;
  publicationsFooter?: ReactNode;
  publicationsDirty?: boolean;
  discardPublications?: () => void;
};
function Workspace({ module, busy, open, chats, publications }: Props) {
  const workspace = useStorefrontWorkspace();
  const section = workspace?.page ?? 'home';
  const [statusConfirm, setStatusConfirm] = useState(false);
  const mutation = useShopMutation();
  const market = module.marketplace!;
  const canManage = module.permissions.includes('manage_marketplace');
  const menu = entries.filter((item) =>
    item.id === 'publications'
      ? !!publications
      : item.id === 'applications'
        ? module.permissions.includes('review_listing')
        : item.id === 'catalog'
          ? module.permissions.includes('review_listing')
          : item.id === 'chats'
            ? module.permissions.includes('bind_chat')
            : canManage,
  );
  return (
    <>
      <StorefrontScreen page="home">
        <div className="karavan-shop__hero">
          {market.coverImageUrl ? (
            <img className="karavan-shop__cover" src={market.coverImageUrl} alt="" />
          ) : null}
          <div className="karavan-module__identity">
            {market.logoImageUrl ? (
              <img className="karavan-shop__logo" src={market.logoImageUrl} alt="" />
            ) : null}
            <h3>{market.name}</h3>
            <p>
              {market.status === 'active'
                ? 'Открыт'
                : market.status === 'draft'
                  ? 'Черновик'
                  : market.status === 'paused'
                    ? 'На паузе'
                    : 'В архиве'}
              {module.counts.chats > 1 ? ` · Чаты: ${module.counts.chats}` : ''}
              {module.counts.pendingApplications > 0
                ? ` · Заявки: ${module.counts.pendingApplications}`
                : ''}
            </p>
          </div>
          {market.status === 'active' && module.buyerUrl ? (
            <button
              type="button"
              className="karavan-module__primary"
              disabled={busy}
              onClick={open}
            >
              Посмотреть магазин
            </button>
          ) : null}
        </div>
        <div className="karavan-shop__menu">
          {menu.map((item) => (
            <SettingsSectionToggle
              key={item.id}
              title={item.label}
              icon={item.icon}
              tone="sky"
              open={section === item.id}
              controls={`karavan-shop-${item.id}`}
              onClick={() => workspace?.navigate(item.id)}
            />
          ))}
        </div>
        <MutationFailure mutation={mutation} />
        {canManage && market.status !== 'archived' ? (
          <details>
            <summary>Доступность магазина</summary>
            {statusConfirm ? (
              <div className="karavan-shop__row">
                <p>
                  {market.status === 'active'
                    ? 'Приостановить просмотр магазина покупателями?'
                    : module.counts.listings === 0
                      ? 'Открыть магазин без продавцов?'
                      : 'Открыть магазин покупателям?'}
                </p>
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() =>
                    void mutation
                      .mutateAsync({
                        operation: 'status',
                        input: {
                          commandId: crypto.randomUUID(),
                          expectedRevision: market.editRevision,
                          status: market.status === 'active' ? 'paused' : 'active',
                          allowEmpty: module.counts.listings === 0,
                        },
                      })
                      .then(() => setStatusConfirm(false))
                      .catch(() => {})
                  }
                >
                  {market.status === 'active' ? 'Приостановить магазин' : 'Открыть для покупателей'}
                </button>
                <button type="button" onClick={() => setStatusConfirm(false)}>
                  Отмена
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setStatusConfirm(true)}>
                {market.status === 'active' ? 'Приостановить магазин' : 'Открыть для покупателей'}
              </button>
            )}
          </details>
        ) : null}
      </StorefrontScreen>
      {menu.map((entry) => (
        <StorefrontScreen key={entry.id} page={entry.id}>
          <div id={`karavan-shop-${entry.id}`} className="karavan-shop">
            {module.counts.chats > 1 && entry.id !== 'publications' && entry.id !== 'chats' ? (
              <p className="karavan-shop__scope">Общий магазин · Чаты: {module.counts.chats}</p>
            ) : null}
            <Suspense fallback={<ShopLoading />}>
              {entry.id === 'catalog' ? (
                <Catalog canArrange={module.permissions.includes('arrange_listings')} />
              ) : null}
              {entry.id === 'applications' ? <Applications canInvite={canManage} /> : null}
              {entry.id === 'appearance' ? (
                <Appearance
                  onView={market.status === 'active' && module.buyerUrl ? open : undefined}
                />
              ) : null}
              {entry.id === 'categories' ? <Categories /> : null}
              {entry.id === 'chats' ? chats : null}
              {entry.id === 'publications' ? publications : null}
            </Suspense>
          </div>
        </StorefrontScreen>
      ))}
    </>
  );
}
export default function KaravanShopManager(props: Props) {
  if (!props.module.marketplace || !props.module.binding) return null;
  return (
    <ShopContext.Provider
      value={{
        api: props.api,
        scope: {
          chatId: props.chatId,
          marketplaceId: props.module.marketplace.id,
          expectedBindingGeneration: props.module.binding.generation,
        },
      }}
    >
      <Workspace {...props} />
    </ShopContext.Provider>
  );
}
