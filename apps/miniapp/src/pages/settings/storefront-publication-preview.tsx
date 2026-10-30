import { createContext, useContext } from 'react';
import type { KaravanPublicationPreview } from '@maxim/contracts/karavan-marketplace';

export const StorefrontPublicationPreviewContext = createContext<KaravanPublicationPreview | null>(
  null,
);
export function useStorefrontPublicationPreview() {
  return useContext(StorefrontPublicationPreviewContext);
}
