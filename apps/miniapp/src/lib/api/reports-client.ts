import {
  reportDetailSchema,
  reportJournalFiltersSchema,
  reportsPageSchema,
  type ReportJournalFilters,
} from '@maxim/contracts/reports';
import type { ApiTransport } from './transport';

const path = (chatId: string) => `/chats/${encodeURIComponent(chatId)}/reports`;
export async function getReports(
  api: ApiTransport,
  chatId: string,
  cursor?: string | null,
  signal?: AbortSignal,
  filters?: ReportJournalFilters,
) {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (filters) {
    for (const [key, value] of Object.entries(reportJournalFiltersSchema.parse(filters))) {
      if (value) query.set(key, value);
    }
  }
  const suffix = query.size ? `?${query}` : '';
  return reportsPageSchema.parse(await api.request(`${path(chatId)}${suffix}`, { signal }));
}
export async function getReport(
  api: ApiTransport,
  chatId: string,
  reportId: string,
  signal?: AbortSignal,
) {
  return reportDetailSchema.parse(
    await api.request(`${path(chatId)}/${encodeURIComponent(reportId)}`, { signal }),
  );
}
export async function dismissReport(api: ApiTransport, chatId: string, reportId: string) {
  return reportDetailSchema.parse(
    await api.request(`${path(chatId)}/${encodeURIComponent(reportId)}/dismiss`, {
      method: 'POST',
      retryMutationOnTransportError: false,
    }),
  );
}

export { getReportAvailability } from './report-availability-client';
