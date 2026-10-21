import { createHash } from 'node:crypto';
import type { PublicModerator } from '@maxim/contracts';
import type { MaxBotDefinition } from './max-bot-registry.service';

const IDENTITIES: Readonly<Record<string, Pick<PublicModerator, 'name' | 'portrait'>>> = {
  id613002203036_bot: { name: 'Максимов', portrait: 'maximov' },
  id613070470872_9_bot: { name: 'Максимов 2', portrait: 'maximov' },
  id613002203036_4_bot: { name: 'Максимова', portrait: 'maximova' },
  id613070470872_5_bot: { name: 'Максимова 2', portrait: 'maximova' },
  id613002203036_5_bot: { name: 'Рэкс', portrait: 'rex' },
  id613070470872_6_bot: { name: 'Рэкс 2', portrait: 'rex' },
};

export function publicModerator(bot: Pick<MaxBotDefinition, 'id' | 'contactId'>): PublicModerator {
  const handle = bot.id.trim();
  const identity = IDENTITIES[handle];
  return {
    key: createHash('sha256').update(`moderator-v1:${bot.id}`).digest('hex').slice(0, 24),
    ...(identity ?? { name: 'Бот сообщества', portrait: 'neutral' as const }),
    url:
      /^[A-Za-z0-9_]+$/u.test(handle) && /[A-Za-z]/u.test(handle)
        ? `https://max.ru/${handle}`
        : null,
  };
}
