import { lazy, Suspense, useState } from 'react';
import { ShopLoading } from './runtime';

const ListingContent = lazy(() => import('./listing-content'));

export function ListingContentDisclosure({ listingId }: { listingId: string }) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return (
    <details
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setVisited(true);
      }}
    >
      <summary>Товары и услуги</summary>
      {visited ? (
        <Suspense fallback={<ShopLoading />}>
          <ListingContent listingId={listingId} enabled={open} />
        </Suspense>
      ) : null}
    </details>
  );
}
