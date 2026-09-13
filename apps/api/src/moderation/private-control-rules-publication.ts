import { BadRequestException } from '@nestjs/common';
import type { PublishChatRulesResult } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';

export async function publishPrivateRules(
  publisher: {
    publishRules: (
      chatId: string,
      actor: AuthUser,
      source: 'private_bot',
      mode: 'new_message',
    ) => Promise<PublishChatRulesResult>;
  },
  chatId: string,
  actor: AuthUser,
) {
  const result = await publisher.publishRules(chatId, actor, 'private_bot', 'new_message');
  if (!result?.messageId?.trim()) {
    throw new BadRequestException('Не удалось подтвердить публикацию правил.');
  }
  const updated = result.operation === 'updated';
  return {
    text: updated
      ? '✅ Правила обновлены в прежнем сообщении. Новое сообщение в группу не отправлялось.'
      : '✅ Правила опубликованы новым сообщением.',
    notification: updated ? '✅ Правила обновлены' : '✅ Правила опубликованы',
  };
}
