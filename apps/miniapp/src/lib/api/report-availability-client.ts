import { reportAvailabilitySchema } from '@maxim/contracts/reports';
import type { ApiTransport } from './transport';

export async function getReportAvailability(
  api: ApiTransport,
  chatId: string,
  signal?: AbortSignal,
) {
  return reportAvailabilitySchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/reports/availability`, { signal }),
  );
}
