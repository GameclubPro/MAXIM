import {
  publicationPostActionRequestSchema,
  type PublicationPostActionRequest,
} from '@maxim/contracts/publication-post-action-request';
import {
  publicationPostActionsSchema,
  type PublicationPostActions,
} from '@maxim/contracts/publication';
import type { ApiTransport } from './transport';

export async function executePublicationPostAction(
  api: ApiTransport,
  publicationId: string,
  deliveryId: string,
  payload: PublicationPostActionRequest,
): Promise<PublicationPostActions> {
  const response = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/deliveries/${encodeURIComponent(deliveryId)}/post-actions`,
    {
      method: 'POST',
      body: JSON.stringify(publicationPostActionRequestSchema.parse(payload)),
    },
  );
  return publicationPostActionsSchema.parse(response);
}
