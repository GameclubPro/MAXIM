import type { ChatSettings } from '@maxim/contracts/settings';

export type DuplicateDetectionPreset = ChatSettings['duplicateDetectionPreset'];
export type ProfanitySensitivity = ChatSettings['profanitySensitivity'];

export const PROFANITY_SENSITIVITY_OPTIONS: Array<{
  value: ProfanitySensitivity;
  label: string;
}> = [
  {
    value: 'CORE_ONLY',
    label: 'Только мат',
  },
  {
    value: 'BALANCED',
    label: 'Баланс',
  },
  {
    value: 'STRICT',
    label: 'Строго',
  },
];

export const PROFANITY_SENSITIVITY_LABELS: Record<ProfanitySensitivity, string> = {
  CORE_ONLY: 'Только мат',
  BALANCED: 'Баланс',
  STRICT: 'Строго',
};

export const PROFANITY_SENSITIVITY_HINTS: Record<ProfanitySensitivity, string> = {
  CORE_ONLY: 'Удаляет сообщения с явным матом и его маскировками.',
  BALANCED: 'Удаляет мат и тяжёлые оскорбления, бытовые ругательства пропускает.',
  STRICT: 'Также удаляет адресные бытовые оскорбления.',
};

export const DUPLICATE_DETECTION_OPTIONS: Array<{
  value: DuplicateDetectionPreset;
  label: string;
}> = [
  {
    value: 'STRICT',
    label: 'Похожие',
  },
  {
    value: 'STANDARD',
    label: 'Точно',
  },
  {
    value: 'CUSTOM',
    label: 'Настроить',
  },
];

export const DUPLICATE_DETECTION_LABELS: Record<DuplicateDetectionPreset, string> = {
  STANDARD: 'Точно',
  STRICT: 'Похожие',
  CUSTOM: 'Настроено',
};

export type NumericChatSettingKey =
  | 'linkEscalationWindowHours'
  | 'linkWarnMaxCount'
  | 'linkMuteMaxCount'
  | 'linkBanMaxCount'
  | 'phoneNumbersEscalationWindowHours'
  | 'phoneNumbersWarnMaxCount'
  | 'phoneNumbersMuteMaxCount'
  | 'phoneNumbersBanMaxCount';

export type StopWordsMode = 'words' | 'domains';
