import { useCallback, useState } from 'react';
import type { BroadcastImage } from '@maxim/contracts/broadcast';
import { normalizeBroadcastImageList } from './settings-page-helpers';

export function useBroadcastImageDraft() {
  const [mailingImageEnabled, setMailingImageEnabled] = useState(false);
  const [mailingImageBase64, setMailingImageBase64] = useState('');
  const [mailingImageMimeType, setMailingImageMimeType] = useState('');
  const [mailingImageFileName, setMailingImageFileName] = useState('');
  const [mailingImages, setMailingImages] = useState<BroadcastImage[]>([]);
  const [mailingImagesPreparing, setMailingImagesPreparing] = useState(false);

  const applyMailingImages = useCallback((nextImages: BroadcastImage[]) => {
    const normalizedImages = normalizeBroadcastImageList(nextImages);
    const firstImage = normalizedImages[0];
    setMailingImages(normalizedImages);
    setMailingImagesPreparing(false);
    setMailingImageEnabled(normalizedImages.length > 0);
    setMailingImageBase64(firstImage?.base64 ?? '');
    setMailingImageMimeType(firstImage?.mimeType ?? '');
    setMailingImageFileName(firstImage?.fileName ?? '');
  }, []);

  const resetMailingImages = useCallback(() => {
    applyMailingImages([]);
  }, [applyMailingImages]);

  return {
    mailingImageEnabled,
    mailingImageBase64,
    mailingImageMimeType,
    mailingImageFileName,
    mailingImages,
    mailingImagesPreparing,
    applyMailingImages,
    resetMailingImages,
    setMailingImagesPreparing,
  };
}
