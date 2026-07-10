export const PUBLICATION_MAX_VIDEO_BYTES = 24_000_000;

export const PUBLICATION_VIDEO_ASSET_ID_FIELD = '__publicationVideoAssetId';
export const PUBLICATION_VIDEO_INLINE_BASE64_FIELD = '__publicationVideoInlineBase64';

export function hasPublicationVideoInternalMarker(value: Record<string, unknown>): boolean {
  return (
    PUBLICATION_VIDEO_ASSET_ID_FIELD in value || PUBLICATION_VIDEO_INLINE_BASE64_FIELD in value
  );
}
