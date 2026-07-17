import type { ChatSettings } from '@maxim/contracts/settings';

export type DuplicateDetectionPreset = ChatSettings['duplicateDetectionPreset'];

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
    label: 'Одинаковые',
  },
  {
    value: 'CUSTOM',
    label: 'Настроить',
  },
];

export const DUPLICATE_DETECTION_LABELS: Record<DuplicateDetectionPreset, string> = {
  STANDARD: 'Одинаковые',
  STRICT: 'Похожие',
  CUSTOM: 'Настроить',
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
