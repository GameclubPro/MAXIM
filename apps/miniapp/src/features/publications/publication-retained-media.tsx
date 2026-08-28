import type { PublicationAsset } from '@maxim/contracts/publication';
import { Xmark } from 'iconoir-react';
import { cn } from '../../lib/cn';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';

export function PublicationRetainedMedia({
  assets,
  previews,
  disabled,
  onClear,
}: {
  assets: readonly PublicationAsset[];
  previews: readonly PublisherPostImportAssetPreview[];
  disabled: boolean;
  onClear: () => void;
}) {
  if (assets.length === 0) {
    return null;
  }
  const hasVideo = assets.some((asset) => asset.type === 'video');
  const imageCount = assets.filter((asset) => asset.type === 'image').length;

  return (
    <div className={cn('publication-retained-media', previews.length > 0 && 'has-previews')}>
      {previews.length > 0 ? (
        <div className="publication-retained-media__previews" aria-hidden>
          {previews.map((preview) => (
            <img key={preview.assetId} src={preview.url} alt="" />
          ))}
        </div>
      ) : null}
      <span>{hasVideo ? 'Сохранено видео' : `Сохранено фото: ${imageCount}`}</span>
      <button
        type="button"
        onClick={onClear}
        disabled={disabled}
        aria-label="Убрать сохранённое медиа"
      >
        <Xmark aria-hidden />
      </button>
    </div>
  );
}
