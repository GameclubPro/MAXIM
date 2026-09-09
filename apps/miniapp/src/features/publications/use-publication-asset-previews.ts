import type { PublicationAsset } from '@maxim/contracts/publication';
import { useEffect, useMemo, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';

export function usePublicationAssetPreviews(
  api: ApiTransport,
  publicationId: string | null,
  assets: readonly PublicationAsset[],
) {
  const key = useMemo(() => assets.map((asset) => asset.id).join(','), [assets]);
  const [previews, setPreviews] = useState<PublisherPostImportAssetPreview[]>([]);
  useEffect(() => {
    setPreviews([]);
    if (!publicationId || !key) return;
    const abort = new AbortController();
    const urls: string[] = [];
    const ids = key.split(',');
    let next = 0;
    async function load() {
      const { getPublicationAsset } = await import('../../lib/api/publication-drafts-client');
      while (!abort.signal.aborted) {
        const assetId = ids[next++];
        if (!assetId) return;
        try {
          const blob = await getPublicationAsset(api, publicationId!, assetId, abort.signal);
          if (abort.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPreviews((current) => [...current, { assetId, url }]);
        } catch {
          /* Preview failure does not invalidate a retained asset. */
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, ids.length) }, load));
    return () => {
      abort.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [api, key, publicationId]);
  return previews;
}
