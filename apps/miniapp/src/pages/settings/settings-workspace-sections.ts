import type { NetworkSettingsSection } from '@maxim/contracts/network-settings-read';
import type {
  SettingsSectionIconName,
  SettingsSectionTone,
} from '../../components/ui/settings-section-toggle';

export type SettingsWorkspaceSection = {
  section: NetworkSettingsSection;
  title: string;
  icon: SettingsSectionIconName;
  tone: SettingsSectionTone;
  panelClassName: string;
  panelIcon?: boolean;
  overview?: boolean;
  order: number;
  entryVariant?: 'priority' | 'list' | 'plain';
  entryClassName?: string;
  variant?: 'sheet' | 'screen';
  overlayClassName?: string;
  plainEntry?: boolean;
};
export const NETWORK_CHAT_SETTINGS_SECTIONS = [
  {
    section: 'rules',
    entryVariant: 'list',
    title: 'Правила',
    icon: 'rules',
    tone: 'ink',
    order: 21,
    variant: 'screen',
    panelClassName:
      'settings-drilldown__panel--campaign settings-drilldown__panel--rules settings-drilldown__panel--broadcast-screen settings-drilldown__panel--rules-screen',
  },
  {
    section: 'advertising',
    entryVariant: 'list',
    title: 'Рекламная площадка',
    icon: 'ads',
    tone: 'sky',
    order: 32,
    variant: 'screen',
    panelClassName: '',
  },
  {
    section: 'speechStyle',
    entryVariant: 'plain',
    title: 'Стиль речи',
    icon: 'comments',
    tone: 'mint',
    order: 33,
    panelClassName: 'settings-drilldown__panel--notice settings-drilldown__panel--speech',
  },
  {
    section: 'links',
    entryVariant: 'priority',
    title: 'Ссылки',
    icon: 'links',
    tone: 'sky',
    order: 1,
    panelClassName: 'settings-drilldown__panel--board settings-drilldown__panel--links',
  },
  {
    section: 'limits',
    entryVariant: 'priority',
    title: 'Ограничения',
    icon: 'shield',
    tone: 'ink',
    order: 2,
    panelClassName: 'settings-drilldown__panel--ladder settings-drilldown__panel--limits',
  },
  {
    section: 'requiredSubscription',
    entryClassName: 'settings-home-entry--wide',
    entryVariant: 'priority',
    title: 'Подписка',
    icon: 'subscription',
    tone: 'sky',
    order: 4,
    panelClassName:
      'settings-drilldown__panel--ladder settings-drilldown__panel--required-subscription',
  },
  {
    section: 'profanityFilter',
    title: 'Мат и оскорбления',
    icon: 'warning',
    tone: 'rose',
    order: 11,
    panelClassName: 'settings-drilldown__panel--ladder settings-drilldown__panel--profanity',
  },
  {
    section: 'commercialFilter',
    title: 'Коммерческая реклама',
    icon: 'ads',
    tone: 'amber',
    order: 12,
    panelClassName: 'settings-drilldown__panel--ladder settings-drilldown__panel--commercial',
  },
  {
    section: 'reports',
    plainEntry: true,
    title: 'Система жалоб',
    icon: 'warning',
    tone: 'rose',
    order: 13,
    panelClassName: 'settings-drilldown__panel--reports',
  },
  {
    section: 'stopWords',
    title: 'Стоп-слова',
    icon: 'keywords',
    tone: 'rose',
    order: 13,
    panelClassName: 'settings-drilldown__panel--board settings-drilldown__panel--stop-words',
  },
  {
    section: 'duplicates',
    title: 'Антидубль',
    icon: 'repeat',
    tone: 'rose',
    order: 15,
    panelClassName: 'settings-drilldown__panel--ladder settings-drilldown__panel--duplicates',
  },
  {
    section: 'messageRetention',
    title: 'Удаление старых сообщений',
    icon: 'clock',
    tone: 'sky',
    order: 15,
    plainEntry: true,
    panelClassName: 'message-retention-panel',
  },
  {
    section: 'night',
    entryClassName: 'settings-home-entry--wide',
    title: 'Ночной режим',
    icon: 'moon',
    tone: 'ink',
    order: 16,
    panelClassName: 'settings-drilldown__panel--time settings-drilldown__panel--night',
  },
  {
    section: 'greeting',
    title: 'Приветствие',
    icon: 'greeting',
    tone: 'mint',
    order: 22,
    panelClassName: 'settings-drilldown__panel--notice settings-drilldown__panel--greeting',
  },
  {
    section: 'commands',
    title: 'Команды',
    icon: 'commands',
    tone: 'ink',
    order: 30,
    panelClassName: 'settings-drilldown__panel--notice settings-drilldown__panel--commands',
  },
  {
    section: 'storefront',
    entryVariant: 'priority',
    title: 'Магазин чата',
    icon: 'storefront',
    tone: 'sky',
    order: 31,
    panelClassName: 'settings-drilldown__panel--notice',
  },
  {
    section: 'extra',
    title: 'Сообщения и боты',
    icon: 'tools',
    tone: 'amber',
    order: 32,
    panelClassName: 'settings-drilldown__panel--notice settings-drilldown__panel--extra',
  },
  {
    section: 'phones',
    overview: false,
    panelIcon: false,
    title: 'Телефоны',
    icon: 'tools',
    tone: 'sky',
    order: 0,
    panelClassName: '',
  },
  {
    section: 'invitationAccess',
    overview: false,
    panelIcon: false,
    title: 'Настройки',
    icon: 'tools',
    tone: 'sky',
    order: 0,
    panelClassName: '',
  },
] as const satisfies readonly SettingsWorkspaceSection[];

export const NETWORK_CHANNEL_SETTINGS_SECTIONS = [
  {
    section: 'postSignature',
    title: 'Действие под публикацией',
    icon: 'links',
    tone: 'sky',
    order: 1,
    panelClassName: 'settings-drilldown__panel--signature',
  },
  {
    section: 'quickButtons',
    title: 'Быстрые кнопки',
    icon: 'links',
    tone: 'sky',
    order: 2,
    panelClassName: '',
  },
  {
    section: 'comments',
    title: 'Комментарии в приложении',
    icon: 'comments',
    tone: 'sky',
    order: 3,
    panelClassName: 'settings-drilldown__panel--board settings-drilldown__panel--channel-comments',
  },
  {
    section: 'postSuggestions',
    title: 'Предложения',
    icon: 'spark',
    tone: 'mint',
    order: 4,
    variant: 'screen',
    panelClassName:
      'settings-drilldown__panel--notice settings-drilldown__panel--post-suggestions settings-drilldown__panel--post-suggestions-screen',
    overlayClassName: 'settings-drilldown--post-suggestions-screen',
  },
] as const satisfies readonly SettingsWorkspaceSection[];

export function getNetworkSettingsSections(
  entityType: 'chat' | 'channel',
): readonly SettingsWorkspaceSection[] {
  return entityType === 'chat' ? NETWORK_CHAT_SETTINGS_SECTIONS : NETWORK_CHANNEL_SETTINGS_SECTIONS;
}

export function getNetworkSettingsSectionPresentation(
  entityType: 'chat' | 'channel',
  section: NetworkSettingsSection,
): SettingsWorkspaceSection {
  const presentation = getNetworkSettingsSections(entityType).find(
    (item) => item.section === section,
  );
  if (!presentation) throw new Error('Раздел не относится к выбранному типу сообщества.');
  return presentation;
}
