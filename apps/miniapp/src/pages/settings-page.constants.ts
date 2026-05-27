import type { ChatSettings } from '@maxim/contracts/settings';

export type DuplicateDetectionPreset = ChatSettings['duplicateDetectionPreset'];

export const DUPLICATE_DETECTION_OPTIONS: Array<{
  value: DuplicateDetectionPreset;
  label: string;
}> = [
  {
    value: 'STRICT',
    label: 'Строгий',
  },
  {
    value: 'STANDARD',
    label: 'Точный',
  },
  {
    value: 'CUSTOM',
    label: 'Свой',
  },
];

export const DUPLICATE_DETECTION_LABELS: Record<DuplicateDetectionPreset, string> = {
  STANDARD: 'Точный',
  STRICT: 'Строгий',
  CUSTOM: 'Свой',
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
