import { reportDetailSchema, reportsPageSchema } from '@maxim/contracts/settings';
import type { ApiTransport } from './transport';

const path = (chatId: string) => `/chats/${encodeURIComponent(chatId)}/reports`;
export async function getReports(
  api: ApiTransport,
  chatId: string,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return reportsPageSchema.parse(await api.request(`${path(chatId)}${query}`, { signal }));
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
    }),
  );
}
