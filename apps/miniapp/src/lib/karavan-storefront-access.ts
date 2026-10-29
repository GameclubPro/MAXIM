import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';

export function karavanAccessMessage(module: KaravanMarketplaceModule): string {
  if (module.binding?.state === 'disconnected') return 'Чат отключён от магазина.';
  switch (module.access?.reason) {
    case 'not_admin':
      return 'Для управления нужны права администратора чата.';
    case 'bot_unavailable':
      return 'Майор потерял доступ к чату. Проверьте его права администратора.';
    case 'binding_changed':
      return 'Подключение магазина требует обновления.';
    default:
      if (module.binding?.state !== 'verified') return 'Подключение чата требует восстановления.';
      return 'Управление магазином сейчас недоступно.';
  }
}
