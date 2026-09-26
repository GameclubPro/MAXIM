import type { LogsDashboardRange } from '@maxim/contracts';
import { chatParticipantDetailsSchema } from '@maxim/contracts/participant-details';
import type { ApiTransport } from './transport';

export async function getChatParticipantDetails(
  api: ApiTransport,
  chatId: string,
  userId: string,
  range: LogsDashboardRange,
  signal?: AbortSignal,
) {
  const response = await api.request(
    `/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}?${new URLSearchParams({ range })}`,
    { signal },
  );
  const details = chatParticipantDetailsSchema.parse(response);
  if (details.userId !== userId) throw new Error('Не удалось подтвердить участника.');
  return details;
}
