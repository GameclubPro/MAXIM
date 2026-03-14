import {
  logsDashboardRangeSchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getLogsDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
): Promise<LogsDashboardResponse> {
  const validatedRange = logsDashboardRangeSchema.parse(range);
  const response = await api.request(
    `/chats/${chatId}/logs-dashboard?range=${encodeURIComponent(validatedRange)}`,
  );
  return logsDashboardResponseSchema.parse(response);
}

export async function applyManualModerationAction(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ManualModerationActionRequest,
): Promise<ManualModerationActionResult> {
  const requestBody = manualModerationActionRequestSchema.parse(payload);
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/moderation-action`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return manualModerationActionResultSchema.parse(response);
}
