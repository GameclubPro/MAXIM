import {
  StopWordsDeleteGuardRejectedError,
  type StopWordsDeleteGuardService,
} from './stop-words-delete-guard.service';

export function createStopWordsSanctionGuard(
  guard: StopWordsDeleteGuardService | undefined,
  params: {
    hasPolicy: boolean;
    chatId: string;
    messageId: string;
    senderId: string;
    ruleCode: string;
    metadata: unknown;
    action: string;
  },
): (() => Promise<void>) | undefined {
  if (params.ruleCode !== 'MESSAGE_BLOCKED_WORD' && params.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN')
    return undefined;
  return async () => {
    if (!guard) {
      if (params.hasPolicy) throw new Error('Stop-list sanction guard unavailable');
      return;
    }
    const action = params.action;
    if (action === 'WARN' || action === 'MUTE' || action === 'BAN') {
      await guard.assertSanctionStillActionable({
        chatId: params.chatId,
        messageId: params.messageId,
        subjectUserId: params.senderId,
        ruleCode: params.ruleCode,
        metadata: params.metadata,
        action,
      });
    }
  };
}

export async function verifyStopWordsSanction(
  guard: (() => Promise<void>) | undefined,
): Promise<boolean> {
  try {
    await guard?.();
    return true;
  } catch (error) {
    if (error instanceof StopWordsDeleteGuardRejectedError) return false;
    throw error;
  }
}
