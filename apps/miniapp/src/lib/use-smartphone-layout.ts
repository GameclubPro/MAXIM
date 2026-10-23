import { useSyncExternalStore } from 'react';

const SMARTPHONE_LAYOUT_QUERY = '(max-width: 600px)';

function readSmartphoneLayout(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(SMARTPHONE_LAYOUT_QUERY).matches
    : false;
}

function subscribeToSmartphoneLayout(changed: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia(SMARTPHONE_LAYOUT_QUERY);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}

export function useSmartphoneLayout(): boolean {
  return useSyncExternalStore(subscribeToSmartphoneLayout, readSmartphoneLayout, () => false);
}
