import type { GlobalSpammerReviewMetrics } from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getGlobalSpammerReviewMetrics(
  api: ApiTransport,
  chatId: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<GlobalSpammerReviewMetrics> {
  const response = await api.request(`/chats/${chatId}/spammer-review/metrics`, request);
  return response as GlobalSpammerReviewMetrics;
}
