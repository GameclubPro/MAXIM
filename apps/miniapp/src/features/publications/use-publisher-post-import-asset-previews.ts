import type { PublicationAsset } from '@maxim/contracts/publication';
import { useEffect, useMemo, useState } from 'react';
import { getPublisherPostImportAsset } from '../../lib/api/publisher-post-import-client';
import type { ApiTransport } from '../../lib/api/transport';

export type PublisherPostImportAssetPreview = {
  assetId: string;
  url: string;
};

export function usePublisherPostImportAssetPreviews(
  api: ApiTransport,
  sessionId: string | null,
  assets: readonly PublicationAsset[],
): PublisherPostImportAssetPreview[] {
  const imageAssetIds = useMemo(
    () => assets.filter((asset) => asset.type === 'image').map((asset) => asset.id),
    [assets],
  );
  const [previews, setPreviews] = useState<PublisherPostImportAssetPreview[]>([]);

  useEffect(() => {
    setPreviews([]);
    if (!sessionId || imageAssetIds.length === 0) {
      return undefined;
    }

    const controller = new AbortController();
    const objectUrls: string[] = [];
    let canceled = false;
    void (async () => {
      const loaded: Array<PublisherPostImportAssetPreview | null> = Array.from(
        { length: imageAssetIds.length },
        () => null,
      );
      let nextIndex = 0;
      const loadNext = async () => {
        while (!canceled) {
          const index = nextIndex;
          nextIndex += 1;
          const assetId = imageAssetIds[index];
          if (assetId === undefined) {
            return;
          }
          try {
            const blob = await getPublisherPostImportAsset(api, sessionId, assetId, {
              signal: controller.signal,
            });
            if (canceled) {
              return;
            }
            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            loaded[index] = { assetId, url };
          } catch {
            if (controller.signal.aborted) {
              return;
            }
            // A missing preview must not block editing or publishing the retained asset.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, imageAssetIds.length) }, () => loadNext()),
      );
      if (!canceled) {
        setPreviews(loaded.filter((preview) => preview !== null));
      }
    })();

    return () => {
      canceled = true;
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [api, imageAssetIds, sessionId]);

  return previews;
}
