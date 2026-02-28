import type { ChatSettings } from '@maxim/contracts';

export type SettingsSectionId =
  | 'links'
  | 'toxicity'
  | 'flood'
  | 'duplicates'
  | 'sanctions'
  | 'logs';

export type SettingsSection = {
  id: SettingsSectionId;
  title: string;
  description: string;
};

type SelectFieldKey = 'profanityLevel' | 'linkPolicy';
type NumericFieldKey = Exclude<keyof ChatSettings, SelectFieldKey>;

type BaseFieldConfig<K extends keyof ChatSettings> = {
  key: K;
  section: SettingsSectionId;
  label: string;
  hint: string;
};

type SelectFieldConfig<K extends SelectFieldKey> = BaseFieldConfig<K> & {
  input: 'select';
  options: Array<{ value: ChatSettings[K]; label: string }>;
};

type NumberFieldConfig<K extends NumericFieldKey> = BaseFieldConfig<K> & {
  input: 'number';
  min: number;
  max: number;
  step?: number;
  unit?: string;
};

export type SettingsFieldConfig =
  | SelectFieldConfig<SelectFieldKey>
  | NumberFieldConfig<NumericFieldKey>;

export const settingsSections: SettingsSection[] = [
  {
    id: 'links',
    title: 'Ссылки',
    description: 'Как бот реагирует на сообщения с URL.',
  },
  {
    id: 'toxicity',
    title: 'Токсичность',
    description: 'Контроль агрессии и Caps Lock.',
  },
  {
    id: 'flood',
    title: 'Флуд',
    description: 'Ограничение частоты сообщений в коротком окне.',
  },
  {
    id: 'duplicates',
    title: 'Дубликаты',
    description: 'Наказания за повтор одинакового текста.',
  },
  {
    id: 'sanctions',
    title: 'Санкции',
    description: 'Порог предупреждений и окно повторного бана.',
  },
  {
    id: 'logs',
    title: 'Логи',
    description: 'Срок хранения событий модерации.',
  },
];

export const settingsFieldConfig: SettingsFieldConfig[] = [
  {
    key: 'linkPolicy',
    section: 'links',
    label: 'Политика ссылок',
    hint: 'Выберите режим реакции на URL.',
    input: 'select',
    options: [
      { value: 'ALERT_ONLY', label: 'Только предупреждать' },
      { value: 'ALLOWLIST_ONLY', label: 'Удалять, кроме разрешенных' },
      { value: 'BLOCKLIST_ONLY', label: 'Удалять все ссылки' },
    ],
  },
  {
    key: 'profanityLevel',
    section: 'toxicity',
    label: 'Уровень фильтра мата',
    hint: 'Чем выше уровень, тем строже фильтрация.',
    input: 'select',
    options: [
      { value: 'LOW', label: 'Низкий' },
      { value: 'MEDIUM', label: 'Средний' },
      { value: 'HIGH', label: 'Высокий' },
    ],
  },
  {
    key: 'capsThreshold',
    section: 'toxicity',
    label: 'Порог Caps',
    hint: 'Процент заглавных букв, после которого срабатывает правило.',
    input: 'number',
    min: 0,
    max: 100,
    unit: '%',
  },
  {
    key: 'floodWindowSec',
    section: 'flood',
    label: 'Окно флуда',
    hint: 'Сколько секунд учитывается при подсчете сообщений.',
    input: 'number',
    min: 1,
    max: 120,
    unit: 'сек',
  },
  {
    key: 'floodMaxMessages',
    section: 'flood',
    label: 'Лимит сообщений',
    hint: 'Максимум сообщений в окне флуда.',
    input: 'number',
    min: 1,
    max: 50,
    unit: 'шт',
  },
  {
    key: 'duplicateWindowSec',
    section: 'duplicates',
    label: 'Окно дубликатов',
    hint: 'Период, в котором считаются одинаковые сообщения.',
    input: 'number',
    min: 5,
    max: 3600,
    unit: 'сек',
  },
  {
    key: 'duplicateMaxCount',
    section: 'duplicates',
    label: 'Лимит повторов',
    hint: 'Количество одинаковых сообщений до срабатывания.',
    input: 'number',
    min: 2,
    max: 20,
    unit: 'шт',
  },
  {
    key: 'warnThreshold',
    section: 'sanctions',
    label: 'Порог предупреждений',
    hint: 'После скольких предупреждений применяются более строгие меры.',
    input: 'number',
    min: 1,
    max: 10,
    unit: 'шт',
  },
  {
    key: 'repeatBanWindowDays',
    section: 'sanctions',
    label: 'Окно повторного бана',
    hint: 'Сколько дней учитывается история нарушений.',
    input: 'number',
    min: 1,
    max: 30,
    unit: 'дн',
  },
  {
    key: 'logRetentionDays',
    section: 'logs',
    label: 'Хранение логов',
    hint: 'Сколько дней хранить события модерации.',
    input: 'number',
    min: 7,
    max: 365,
    unit: 'дн',
  },
];
