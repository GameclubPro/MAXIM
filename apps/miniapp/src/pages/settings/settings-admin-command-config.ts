import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
} from '@maxim/contracts/settings';
import type { HintKey } from './settings-page-helpers';

export type AdminCommandNameKey =
  | 'adminBanCommandName'
  | 'adminBanAllCommandName'
  | 'adminMuteCommandName'
  | 'adminPermanentMuteCommandName'
  | 'adminRulesCommandName'
  | 'adminSilenceCommandName'
  | 'adminOpenChatCommandName';

type AdminCommandConfig = {
  key: AdminCommandNameKey;
  title: string;
  caption: string;
  hintKey: HintKey;
  defaultValue: string;
};

type AdminCommandCategory = {
  title: string;
  items: AdminCommandConfig[];
};

export const commandCategories: AdminCommandCategory[] = [
  {
    title: 'Модерация',
    items: [
      {
        key: 'adminBanCommandName',
        title: 'Заблокировать',
        caption: 'Блокирует участника в текущем чате. В остальных чатах его доступ не меняется.',
        hintKey: 'adminBanCommand',
        defaultValue: ADMIN_BAN_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminBanAllCommandName',
        title: 'Заблокировать во всех чатах',
        caption:
          'Блокирует участника во всех подключённых чатах, где у вас есть права администратора. Это действие затрагивает не только текущий чат.',
        hintKey: 'adminBanAllCommand',
        defaultValue: ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminMuteCommandName',
        title: 'Запретить писать',
        caption:
          'Временно запрещает участнику писать. По умолчанию запрет действует 6 часов, при этом участник остаётся в чате.',
        hintKey: 'adminMuteCommand',
        defaultValue: ADMIN_MUTE_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminPermanentMuteCommandName',
        title: 'Запретить писать навсегда',
        caption:
          'Запрещает участнику писать без автоматического окончания. Участник остаётся в чате.',
        hintKey: 'adminPermanentMuteCommand',
        defaultValue: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminSilenceCommandName',
        title: 'Закрыть чат',
        caption:
          'Временно закрывает чат: бот удаляет новые сообщения участников. Администраторы могут продолжать писать.',
        hintKey: 'adminSilenceCommand',
        defaultValue: ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminOpenChatCommandName',
        title: 'Открыть чат',
        caption:
          'Отменяет ручное закрытие чата. Ночное расписание, если оно включено, продолжает действовать.',
        hintKey: 'adminOpenChatCommand',
        defaultValue: ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
      },
    ],
  },
  {
    title: 'Правила',
    items: [
      {
        key: 'adminRulesCommandName',
        title: 'Сохранить правила',
        caption: 'Сохраняет сообщение как правила чата.',
        hintKey: 'adminRulesCommand',
        defaultValue: ADMIN_RULES_COMMAND_NAME_DEFAULT,
      },
    ],
  },
];
