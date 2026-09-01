import type { PublicationAsset } from '@maxim/contracts/publication';
import { Xmark } from 'iconoir-react';
import { cn } from '../../lib/cn';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import './publication-retained-media.css';

export function PublicationRetainedMedia({
  assets,
  previews,
  disabled,
  onRemove,
}: {
  assets: readonly PublicationAsset[];
  previews: readonly PublisherPostImportAssetPreview[];
  disabled: boolean;
  onRemove: (assetId: string) => void;
}) {
  if (assets.length === 0) {
    return null;
  }
  const previewByAssetId = new Map(previews.map((preview) => [preview.assetId, preview.url]));

  return (
    <>
      {assets.map((asset, index) => {
        const previewUrl = previewByAssetId.get(asset.id);
        const label =
          asset.fileName.trim() || (asset.type === 'video' ? 'Видео' : `Фото ${index + 1}`);
        return (
          <div
            key={asset.id}
            className={cn('publication-retained-media', previewUrl && 'has-previews')}
          >
            {previewUrl ? (
              <div className="publication-retained-media__previews" aria-hidden>
                <img src={previewUrl} alt="" />
              </div>
            ) : null}
            <span>{label}</span>
            <button
              type="button"
              onClick={() => onRemove(asset.id)}
              disabled={disabled}
              aria-label={
                asset.type === 'video' ? 'Убрать видео' : `Убрать сохранённое фото ${index + 1}`
              }
              title="Убрать"
            >
              <Xmark aria-hidden />
            </button>
          </div>
        );
      })}
    </>
  );
}
