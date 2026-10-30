import { MoveHandle } from './move-handle';
import { ListingContentDisclosure } from './listing-content-disclosure';
import { useEffect, useState } from 'react';
import { useStorefrontDirty, useStorefrontWorkspace } from '../storefront-workspace';
import type {
  MarketplaceOfferCard,
  MarketplaceListing,
} from '@maxim/contracts/karavan-marketplace-management';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShopMutation,
  useShopQuery,
  useShopPages,
  useShop,
} from './runtime';

import { publicationReasons } from './listing-status';
import { SellerAccessAction } from './seller-access';
import { uniqueShopItems } from './shop-journey';

function Sellers({
  search,
  canArrange,
  onEmpty,
}: {
  search: string;
  canArrange: boolean;
  onEmpty: () => void;
}) {
  const { module } = useShop();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<MarketplaceListing | null>(null);
  const [arranging, setArranging] = useState(false);
  useStorefrontDirty('catalog-seller', !!selected && !!reason.trim());
  const query = useShopPages<'listings'>({
    operation: 'listings',
    input: { cursor: null, limit: 24, q: search, visibility: 'all', orderableOnly: false },
  });
  const mutation = useShopMutation((command) => {
    if (command.operation === 'moderate_listing') {
      setSelected(null);
      setReason('');
      setNotice(command.input.action === 'resume' ? 'Ограничение витрины снято' : 'Витрина скрыта');
    }
  });
  if (query.isPending) return <ShopLoading />;
  if (!query.data) return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  const listings = uniqueShopItems(query.data.pages.map((page) => page.listings));
  const meta = query.data.pages[0]!;
  const selectedVisible = selected && listings.some((listing) => listing.id === selected.id);
  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}
      {!selectedVisible ? <MutationFailure mutation={mutation} /> : null}
      {canArrange &&
      (meta.orderableTotal ?? listings.length) > 1 &&
      listings.some((listing) => listing.position) ? (
        <button type="button" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
          {arranging ? 'Готово' : 'Изменить порядок'}
        </button>
      ) : null}
      {listings.length ? (
        listings.map((listing, index, list) => (
          <article
            className="karavan-shop__row"
            key={listing.id}
            data-sort-group="sellers"
            data-sort-index={index}
          >
            <div className="karavan-shop__identity">
              <strong>{listing.storeName}</strong>
              {canArrange && arranging && listing.position ? (
                <MoveHandle
                  label={listing.storeName}
                  index={index}
                  group="sellers"
                  disabled={mutation.isPending || mutation.isError}
                  move={(_from, to) => {
                    const position = list[to]?.position;
                    if (position)
                      mutation.mutate({
                        operation: 'reorder_listings',
                        input: {
                          commandId: crypto.randomUUID(),
                          expectedOrderRevision: meta.orderRevision,
                          moves: [{ listingId: listing.id, position }],
                        },
                      });
                  }}
                />
              ) : null}
            </div>
            <p>{publicationReasons[listing.publicationReason]}</p>
            <ListingContentDisclosure listingId={listing.id} />
            {['approved', 'suspended'].includes(listing.reviewState) ? (
              <>
                <div className="karavan-module__entry-actions">
                  <button
                    type="button"
                    disabled={mutation.isPending || mutation.isError}
                    onClick={() => {
                      setSelected(listing);
                      setReason('');
                    }}
                  >
                    {listing.reviewState === 'suspended' ? 'Снять ограничение' : 'Скрыть'}
                  </button>
                </div>
                {canArrange && arranging ? (
                  <div className="karavan-shop__reorder">
                    <div className="karavan-module__entry-actions">
                      <button
                        type="button"
                        disabled={
                          !canArrange ||
                          mutation.isPending ||
                          mutation.isError ||
                          listing.position === 1
                        }
                        onClick={() =>
                          mutation.mutate({
                            operation: 'reorder_listings',
                            input: {
                              commandId: crypto.randomUUID(),
                              expectedOrderRevision: meta.orderRevision,
                              moves: [{ listingId: listing.id, position: 1 }],
                            },
                          })
                        }
                      >
                        Поднять вверх
                      </button>
                      {canArrange && listing.position && listing.position > 1 ? (
                        <button
                          type="button"
                          aria-label={`Выше: ${listing.storeName}`}
                          disabled={mutation.isPending || mutation.isError}
                          onClick={() =>
                            mutation.mutate({
                              operation: 'reorder_listings',
                              input: {
                                commandId: crypto.randomUUID(),
                                expectedOrderRevision: meta.orderRevision,
                                moves: [{ listingId: listing.id, position: listing.position! - 1 }],
                              },
                            })
                          }
                        >
                          Выше
                        </button>
                      ) : null}
                      {canArrange &&
                      listing.position &&
                      listing.position < (meta.orderableTotal ?? 0) ? (
                        <button
                          type="button"
                          aria-label={`Ниже: ${listing.storeName}`}
                          disabled={mutation.isPending || mutation.isError}
                          onClick={() =>
                            mutation.mutate({
                              operation: 'reorder_listings',
                              input: {
                                commandId: crypto.randomUUID(),
                                expectedOrderRevision: meta.orderRevision,
                                moves: [{ listingId: listing.id, position: listing.position! + 1 }],
                              },
                            })
                          }
                        >
                          Ниже
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
            {selected?.id === listing.id ? (
              <div className="karavan-module__actions">
                <label className="karavan-module__field">
                  {listing.reviewState === 'suspended'
                    ? 'Комментарий к восстановлению'
                    : 'Причина скрытия'}
                  <textarea
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!reason.trim() || mutation.isPending || mutation.isError}
                  onClick={() =>
                    void mutation
                      .mutateAsync({
                        operation: 'moderate_listing',
                        listingId: listing.id,
                        input: {
                          commandId: crypto.randomUUID(),
                          expectedRevision: listing.revision,
                          action: listing.reviewState === 'suspended' ? 'resume' : 'suspend',
                          reason: reason.trim(),
                        },
                      })
                      .then(() => setSelected(null))
                      .catch(() => {})
                  }
                >
                  {mutation.isPending
                    ? 'Сохраняем…'
                    : listing.reviewState === 'suspended'
                      ? 'Снять ограничение'
                      : 'Скрыть витрину'}
                </button>
                <MutationFailure mutation={mutation} />
                <button
                  type="button"
                  disabled={mutation.isPending || mutation.isError}
                  onClick={() => setSelected(null)}
                >
                  Отмена
                </button>
              </div>
            ) : null}
          </article>
        ))
      ) : (
        <div className="karavan-module__actions">
          <p>{search ? 'Ничего не найдено' : 'Витрин пока нет'}</p>
          {!search ? (
            <>
              <SellerAccessAction />
              {module.counts.pendingApplications > 0 ? (
                <button type="button" onClick={onEmpty}>
                  Посмотреть заявки
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
      {query.isFetchNextPageError ? (
        <ShopFailure error={query.error} retry={() => void query.fetchNextPage()} />
      ) : null}
    </>
  );
}
function Offers({ search, canArrange }: { search: string; canArrange: boolean }) {
  const [kind, setKind] = useState<'product' | 'property'>('product'),
    [visibility, setVisibility] = useState<'all' | 'visible' | 'hidden'>('all');
  const [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<MarketplaceOfferCard | null>(null),
    [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  useStorefrontDirty('catalog-offer', !!selected && !!reason.trim());
  const query = useShopQuery<'catalog'>({
    operation: 'catalog',
    input: { q: search, cursor, limit: 24, kind, visibility },
  });
  const pins = useShopQuery<'pins'>({ operation: 'pins' }, canArrange);
  const mutation = useShopMutation((command) => {
    if (command.operation === 'moderate_content') {
      setSelected(null);
      setReason('');
      setNotice(command.input.active ? 'Объявление скрыто' : 'Ограничение объявления снято');
    }
  });
  useEffect(() => setCursor(null), [search, kind, visibility]);
  const savePins = (offers: MarketplaceOfferCard[]) => {
    if (!canArrange || mutation.isPending || mutation.isError || !pins.data) return;
    mutation.mutate({
      operation: 'pins_save',
      input: {
        commandId: crypto.randomUUID(),
        expectedRevision: pins.data.revision,
        offers: offers.map(({ id, storeId, kind: type }) => ({ id, storeId, kind: type })),
      },
    });
  };
  return (
    <>
      <div className="karavan-shop__filters">
        <label>
          Тип
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="product">Товары и услуги</option>
            <option value="property">Недвижимость</option>
          </select>
        </label>
        <label>
          Показ
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as typeof visibility)}
          >
            <option value="all">Все</option>
            <option value="visible">Разрешённые</option>
            <option value="hidden">Скрытые</option>
          </select>
        </label>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {!selected || !query.data?.items.some((item) => item.id === selected.id) ? (
        <MutationFailure mutation={mutation} />
      ) : null}
      {canArrange && pins.isError ? (
        <ShopFailure error={pins.error} retry={() => void pins.refetch()} />
      ) : null}
      {canArrange && pins.data?.offers.length ? (
        <details>
          <summary>Закреплённые · {pins.data.offers.length}</summary>
          {pins.data.offers.map((offer, index, list) => (
            <div
              className="karavan-shop__row"
              key={`${offer.kind}:${offer.id}`}
              data-sort-group="pins"
              data-sort-index={index}
            >
              <div className="karavan-shop__identity">
                <strong>{offer.title}</strong>
                <MoveHandle
                  label={offer.title}
                  index={index}
                  group="pins"
                  disabled={mutation.isPending || mutation.isError}
                  move={(from, to) => {
                    if (to >= list.length) return;
                    const next = [...list];
                    next.splice(to, 0, ...next.splice(from, 1));
                    savePins(next);
                  }}
                />
              </div>
              {!offer.available ? <p>Сейчас не показывается</p> : null}
              <div className="karavan-module__entry-actions">
                <button
                  type="button"
                  disabled={index === 0 || mutation.isPending || mutation.isError}
                  aria-label={`Выше: ${offer.title}`}
                  onClick={() => {
                    const next = [...list];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    savePins(next);
                  }}
                >
                  Выше
                </button>
                <button
                  type="button"
                  disabled={index === list.length - 1 || mutation.isPending || mutation.isError}
                  aria-label={`Ниже: ${offer.title}`}
                  onClick={() => {
                    const next = [...list];
                    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                    savePins(next);
                  }}
                >
                  Ниже
                </button>
              </div>
              <button
                type="button"
                disabled={mutation.isPending || mutation.isError}
                onClick={() => savePins(list.filter((row) => row !== offer))}
              >
                Открепить
              </button>
            </div>
          ))}
        </details>
      ) : null}
      {query.isPending ? (
        <ShopLoading />
      ) : query.isError ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            query.data.items.map((offer) => {
              const pinned = pins.data?.offers.some(
                (row) => row.id === offer.id && row.kind === offer.kind,
              );
              return (
                <article className="karavan-shop__row" key={offer.id}>
                  <div className="karavan-shop__identity">
                    {offer.imageUrl ? <img src={offer.imageUrl} alt="" loading="lazy" /> : null}
                    <div>
                      <strong>{offer.title}</strong>
                      <p>{offer.storeName}</p>
                    </div>
                  </div>
                  {!offer.allowedCategory ? (
                    <p>Категория отключена</p>
                  ) : offer.restriction?.active ? (
                    <p>Скрыто администратором: {offer.restriction.reason}</p>
                  ) : null}
                  <div className="karavan-module__entry-actions">
                    <button
                      type="button"
                      disabled={mutation.isPending || mutation.isError}
                      onClick={() => {
                        setSelected(offer);
                        setReason('');
                      }}
                    >
                      {offer.restriction?.active ? 'Снять ограничение' : 'Скрыть'}
                    </button>
                    <button
                      type="button"
                      disabled={
                        !canArrange ||
                        mutation.isPending ||
                        mutation.isError ||
                        !pins.data ||
                        (!pinned && (!offer.available || pins.data.offers.length >= 24))
                      }
                      onClick={() =>
                        savePins(
                          pinned
                            ? pins.data!.offers.filter(
                                (row) => row.id !== offer.id || row.kind !== offer.kind,
                              )
                            : [offer, ...pins.data!.offers],
                        )
                      }
                    >
                      {pinned ? 'Открепить' : 'Закрепить'}
                    </button>
                  </div>
                  {selected?.id === offer.id ? (
                    <div className="karavan-module__actions">
                      <label className="karavan-module__field">
                        {offer.restriction?.active
                          ? 'Комментарий к восстановлению'
                          : 'Причина скрытия'}
                        <textarea
                          value={reason}
                          maxLength={2000}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={mutation.isPending || mutation.isError || !reason.trim()}
                        onClick={() =>
                          void mutation
                            .mutateAsync({
                              operation: 'moderate_content',
                              input: {
                                commandId: crypto.randomUUID(),
                                storeId: offer.storeId,
                                productId: offer.kind === 'product' ? offer.id : null,
                                propertyId: offer.kind === 'property' ? offer.id : null,
                                expectedRevision: offer.restriction?.revision ?? null,
                                active: !offer.restriction?.active,
                                reason: reason.trim(),
                              },
                            })
                            .then(() => setSelected(null))
                            .catch(() => {})
                        }
                      >
                        {mutation.isPending
                          ? 'Сохраняем…'
                          : offer.restriction?.active
                            ? 'Снять ограничение'
                            : 'Скрыть объявление'}
                      </button>
                      <MutationFailure mutation={mutation} />
                      <button
                        type="button"
                        disabled={mutation.isPending || mutation.isError}
                        onClick={() => setSelected(null)}
                      >
                        Отмена
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })
          ) : (
            <p>{search ? 'Ничего не найдено' : 'Товаров и услуг пока нет'}</p>
          )}
          {query.data.nextCursor ? (
            <button type="button" onClick={() => setCursor(query.data.nextCursor)}>
              Следующие объявления
            </button>
          ) : null}
          {cursor ? (
            <button type="button" onClick={() => setCursor(null)}>
              В начало списка
            </button>
          ) : null}
        </>
      )}
    </>
  );
}
export default function ShopCatalog({ canArrange }: { canArrange: boolean }) {
  const workspace = useStorefrontWorkspace();
  const [tab, setTab] = useState<'offers' | 'sellers'>('sellers');
  const [visited, setVisited] = useState({ offers: false, sellers: true });
  const selectTab = (next: 'offers' | 'sellers') => {
    setTab(next);
    setVisited((value) => ({ ...value, [next]: true }));
  };
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  return (
    <>
      <div
        className="karavan-module__entry-actions"
        role="tablist"
        aria-label="Витрины и предложения"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'sellers'
              : event.key === 'End'
                ? 'offers'
                : tab === 'offers'
                  ? 'sellers'
                  : 'offers';
          selectTab(next);
          document.getElementById(`shop-tab-${next}`)?.focus();
        }}
      >
        <button
          type="button"
          role="tab"
          id="shop-tab-sellers"
          aria-controls="shop-tabpanel-sellers"
          tabIndex={tab === 'sellers' ? 0 : -1}
          aria-selected={tab === 'sellers'}
          onClick={() => selectTab('sellers')}
        >
          Витрины
        </button>
        <button
          type="button"
          role="tab"
          id="shop-tab-offers"
          aria-controls="shop-tabpanel-offers"
          tabIndex={tab === 'offers' ? 0 : -1}
          aria-selected={tab === 'offers'}
          onClick={() => selectTab('offers')}
        >
          Товары и услуги
        </button>
      </div>
      <label className="karavan-module__field">
        <input
          type="search"
          aria-label="Поиск в каталоге"
          placeholder="Поиск"
          value={search}
          maxLength={120}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div
        role="tabpanel"
        id="shop-tabpanel-offers"
        aria-labelledby="shop-tab-offers"
        hidden={tab !== 'offers'}
        tabIndex={0}
      >
        {visited.offers ? <Offers search={query} canArrange={canArrange} /> : null}
      </div>
      <div
        role="tabpanel"
        id="shop-tabpanel-sellers"
        aria-labelledby="shop-tab-sellers"
        hidden={tab !== 'sellers'}
        tabIndex={0}
      >
        {visited.sellers ? (
          <Sellers
            search={query}
            canArrange={canArrange}
            onEmpty={() => workspace?.navigate('applications')}
          />
        ) : null}
      </div>
    </>
  );
}
