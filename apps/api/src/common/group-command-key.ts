import { createHash } from 'node:crypto';

// FLAG: Shared command identity has no runtime authority or effect-service dependencies.
export function buildGroupCommandKey(chatId: string, messageId: string): string {
  if (!chatId.trim() || !messageId.trim())
    throw new Error('Group command requires chat/message identity');
  return `group-command:v1:${createHash('sha256')
    .update(JSON.stringify([chatId, messageId]))
    .digest('hex')}`;
}
