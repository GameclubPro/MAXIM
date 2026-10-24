import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxClientService } from '../max/max-client.service';
import { readTrimmedString } from './admin-value-readers';

export async function resolveAdminBotUserId(params: {
  chatId: string;
  botId?: string | null;
  registry?: Pick<MaxBotRegistryService, 'getBotById'>;
  maxClient: Pick<MaxClientService, 'getCurrentChatMemberAccess'>;
  onUnavailable: (error: unknown) => void;
}): Promise<string | null> {
  // FLAG: Configured exact-bot contact identity only filters bot recipients. It grants
  // no chat membership or administrator rights; those checks retain their fresh reads.
  const contactId = params.botId ? params.registry?.getBotById(params.botId)?.contactId : null;
  if (
    typeof contactId === 'string' &&
    contactId.trim() === contactId &&
    /^[0-9]+$/u.test(contactId)
  )
    return contactId;
  try {
    const access = await params.maxClient.getCurrentChatMemberAccess(params.chatId, {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ...(params.botId ? { botId: params.botId } : {}),
    });
    return readTrimmedString(access.userId);
  } catch (error: unknown) {
    params.onUnavailable(error);
    return null;
  }
}
