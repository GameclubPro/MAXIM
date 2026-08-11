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
