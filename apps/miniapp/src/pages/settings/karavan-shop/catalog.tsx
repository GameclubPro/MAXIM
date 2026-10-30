import { MoveHandle } from './move-handle';
import { useEffect, useState } from 'react';
import { useStorefrontDirty } from '../storefront-workspace';
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
} from './runtime';

const publicationReasons = {
  published: 'В магазине',
  marketplace_unavailable: 'Магазин закрыт для покупателей',
  chat_unavailable: 'Чат магазина недоступен',
  store_unavailable: 'Витрина продавца недоступна',
  awaiting_review: 'Заявка на проверке',
  changes_requested: 'Требуется доработка заявки',
  rejected: 'Заявка отклонена',
  suspended: 'Скрыт администратором',
  seller_paused: 'Приостановлено продавцом',
  withdrawn: 'Продавец отозвал размещение',
  platform_review: 'Витрина на проверке Каравана',
  rules_acceptance_required: 'Продавец ещё не принял правила',
  category_not_allowed: 'Категория не разрешена',
  no_published_offers: 'Нет опубликованных объявлений',
} satisfies Record<MarketplaceListing['publicationReason'], string>;

function Sellers({ search, canArrange }: { search: string; canArrange: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null),
    [reason, setReason] = useState('');
  const [selected, setSelected] = useState<MarketplaceListing | null>(null);
  useStorefrontDirty('catalog-seller', !!selected && !!reason.trim());
  const query = useShopQuery<'listings'>({
    operation: 'listings',
    input: { cursor, limit: 24, q: search, visibility: 'all', orderableOnly: false },
  });
  const mutation = useShopMutation((command) => {
    if (command.operation === 'moderate_listing' || command.operation === 'moderate_content')
      setSelected(null);
  });
  useEffect(() => setCursor(null), [search]);
  if (query.isPending) return <ShopLoading />;
  if (query.isError) return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      <MutationFailure mutation={mutation} />
      {query.data.listings.length ? (
        query.data.listings.map((listing, index, list) => (
          <article
            className="karavan-shop__row"
            key={listing.id}
            data-sort-group="sellers"
            data-sort-index={index}
          >
            <div className="karavan-shop__identity">
              <strong>{listing.storeName}</strong>
              {canArrange && listing.position ? (
                <MoveHandle
                  label={listing.storeName}
                  index={index}
                  group="sellers"
                  disabled={mutation.isPending}
                  move={(_from, to) => {
                    const position = list[to]?.position;
                    if (position)
                      mutation.mutate({
                        operation: 'reorder_listings',
                        input: {
                          commandId: crypto.randomUUID(),
                          expectedOrderRevision: query.data.orderRevision,
                          moves: [{ listingId: listing.id, position }],
                        },
                      });
                  }}
                />
              ) : null}
            </div>
            <p>{publicationReasons[listing.publicationReason]}</p>
            {['approved', 'suspended'].includes(listing.reviewState) ? (
              <>
                <div className="karavan-module__entry-actions">
                  <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => {
                      setSelected(listing);
                      setReason('');
                    }}
                  >
                    {listing.reviewState === 'suspended' ? 'Показать' : 'Скрыть'}
                  </button>
                </div>
                {canArrange ? (
                  <details className="karavan-shop__reorder">
                    <summary>Порядок продавца</summary>
                    <div className="karavan-module__entry-actions">
                      <button
                        type="button"
                        disabled={!canArrange || mutation.isPending || listing.position === 1}
                        onClick={() =>
                          mutation.mutate({
                            operation: 'reorder_listings',
                            input: {
                              commandId: crypto.randomUUID(),
                              expectedOrderRevision: query.data.orderRevision,
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
                          disabled={mutation.isPending}
                          onClick={() =>
                            mutation.mutate({
                              operation: 'reorder_listings',
                              input: {
                                commandId: crypto.randomUUID(),
                                expectedOrderRevision: query.data.orderRevision,
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
                      listing.position < (query.data.orderableTotal ?? 0) ? (
                        <button
                          type="button"
                          aria-label={`Ниже: ${listing.storeName}`}
                          disabled={mutation.isPending}
                          onClick={() =>
                            mutation.mutate({
                              operation: 'reorder_listings',
                              input: {
                                commandId: crypto.randomUUID(),
                                expectedOrderRevision: query.data.orderRevision,
                                moves: [{ listingId: listing.id, position: listing.position! + 1 }],
                              },
                            })
                          }
                        >
                          Ниже
                        </button>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}
            {selected?.id === listing.id ? (
              <div className="karavan-module__actions">
                <label className="karavan-module__field">
                  Причина
                  <textarea
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!reason.trim() || mutation.isPending}
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
                  Подтвердить
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  Отмена
                </button>
              </div>
            ) : null}
          </article>
        ))
      ) : (
        <p>Продавцов пока нет</p>
      )}
      {query.data.nextCursor ? (
        <button type="button" onClick={() => setCursor(query.data.nextCursor)}>
          Следующие продавцы
        </button>
      ) : null}
      {cursor ? (
        <button type="button" onClick={() => setCursor(null)}>
          В начало списка
        </button>
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
  useStorefrontDirty('catalog-offer', !!selected && !!reason.trim());
  const query = useShopQuery<'catalog'>({
    operation: 'catalog',
    input: { q: search, cursor, limit: 24, kind, visibility },
  });
  const pins = useShopQuery<'pins'>({ operation: 'pins' }, canArrange);
  const mutation = useShopMutation((command) => {
    if (command.operation === 'moderate_listing' || command.operation === 'moderate_content')
      setSelected(null);
  });
  useEffect(() => setCursor(null), [search, kind, visibility]);
  const savePins = (offers: MarketplaceOfferCard[]) => {
    if (pins.data)
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
      <MutationFailure mutation={mutation} />
      {pins.isError ? <ShopFailure error={pins.error} retry={() => void pins.refetch()} /> : null}
      {pins.data?.offers.length ? (
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
                  disabled={mutation.isPending}
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
                  disabled={index === 0 || mutation.isPending}
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
                  disabled={index === list.length - 1 || mutation.isPending}
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
                disabled={mutation.isPending}
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
                      disabled={mutation.isPending}
                      onClick={() => {
                        setSelected(offer);
                        setReason('');
                      }}
                    >
                      {offer.restriction?.active ? 'Показать' : 'Скрыть'}
                    </button>
                    <button
                      type="button"
                      disabled={
                        !canArrange ||
                        mutation.isPending ||
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
                        Причина
                        <textarea
                          value={reason}
                          maxLength={2000}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={mutation.isPending || !reason.trim()}
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
                        Подтвердить
                      </button>
                      <button type="button" onClick={() => setSelected(null)}>
                        Отмена
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })
          ) : (
            <p>Объявлений пока нет</p>
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
  const [tab, setTab] = useState<'offers' | 'sellers'>('offers');
  const [visited, setVisited] = useState({ offers: true, sellers: false });
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
        aria-label="Каталог"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'offers'
              : event.key === 'End'
                ? 'sellers'
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
          id="shop-tab-offers"
          aria-controls="shop-tabpanel-offers"
          tabIndex={tab === 'offers' ? 0 : -1}
          aria-selected={tab === 'offers'}
          onClick={() => selectTab('offers')}
        >
          Объявления
        </button>
        <button
          type="button"
          role="tab"
          id="shop-tab-sellers"
          aria-controls="shop-tabpanel-sellers"
          tabIndex={tab === 'sellers' ? 0 : -1}
          aria-selected={tab === 'sellers'}
          onClick={() => selectTab('sellers')}
        >
          Продавцы
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
        {visited.sellers ? <Sellers search={query} canArrange={canArrange} /> : null}
      </div>
    </>
  );
}
