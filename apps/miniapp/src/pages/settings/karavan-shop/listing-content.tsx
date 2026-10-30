import { useState } from 'react';
import { ShopFailure, ShopLoading, useShopQuery } from './runtime';

export default function ListingContent({
  listingId,
  enabled,
}: {
  listingId: string;
  enabled: boolean;
}) {
  const [page, setPage] = useState<{ kind: 'product' | 'property'; cursor: string | null }>({
    kind: 'product',
    cursor: null,
  });
  const query = useShopQuery<'content'>(
    { operation: 'content', listingId, input: { ...page, limit: 24 } },
    enabled,
  );
  return (
    <div className="karavan-module__actions">
      <div className="karavan-shop__filters">
        <label>
          Раздел
          <select
            value={page.kind}
            onChange={(event) =>
              setPage({ kind: event.target.value as typeof page.kind, cursor: null })
            }
          >
            <option value="product">Товары и услуги</option>
            <option value="property">Недвижимость</option>
          </select>
        </label>
      </div>
      {query.isPending ? (
        <ShopLoading />
      ) : query.isError ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            query.data.items.map((item) => (
              <div className="karavan-shop__row" key={`${item.kind}:${item.id}`}>
                <div className="karavan-shop__identity">
                  {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : null}
                  <strong>{item.title}</strong>
                </div>
                {!item.allowedCategory ? <p>Категория отключена</p> : null}
                {item.restriction?.active ? (
                  <p>Скрыто администратором: {item.restriction.reason}</p>
                ) : null}
              </div>
            ))
          ) : (
            <p>Объявлений пока нет</p>
          )}
          <div className="karavan-module__entry-actions">
            {query.data.nextCursor ? (
              <button
                type="button"
                onClick={() => setPage({ ...page, cursor: query.data.nextCursor })}
              >
                Далее
              </button>
            ) : null}
            {page.cursor ? (
              <button type="button" onClick={() => setPage({ ...page, cursor: null })}>
                В начало
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
