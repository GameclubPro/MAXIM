import {
  channelStatsRangeSchema,
  channelStatsResponseSchema,
  type ChannelStatsRange,
  type ChannelStatsResponse,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getChannelStats(
  api: ApiTransport,
  chatId: string,
  range: ChannelStatsRange = '7d',
): Promise<ChannelStatsResponse> {
  const validatedRange = channelStatsRangeSchema.parse(range);
  const response = await api.request(
    `/channels/${chatId}/stats?range=${encodeURIComponent(validatedRange)}`,
  );
  return channelStatsResponseSchema.parse(response);
}
