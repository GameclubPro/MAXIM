import type { VkParsingPostFilterStatus } from '@maxim/contracts';

export type PublishPayload = {
  postId: string;
  text: string;
  photoUrls: string[];
  linkUrls: string[];
};

export type VkParsingSettingKey = 'autoPublishEnabled' | 'stripLinksEnabled' | 'skipAdsEnabled';
export type VkParsingHintKey = VkParsingSettingKey | 'source';

export const VK_PARSING_PAGE_SIZE = 50;

export const VK_PARSING_STATUS_FILTERS: Array<{
  value: VkParsingPostFilterStatus;
  label: string;
}> = [
  { value: 'ALL', label: 'Все' },
  { value: 'NEW', label: 'Новые' },
  { value: 'QUEUED', label: 'Очередь' },
  { value: 'PUBLISHED', label: 'Опубл.' },
  { value: 'FAILED', label: 'Ошибка' },
  { value: 'SKIPPED', label: 'Пропущ.' },
  { value: 'CHANGED_AFTER_PUBLISH', label: 'Измен.' },
];

export const VK_PARSING_SETTING_TOGGLES: Array<{
  key: VkParsingSettingKey;
  label: string;
  hint: string;
}> = [
  {
    key: 'autoPublishEnabled',
    label: 'Автопостинг',
    hint: 'Новые посты из подключенных источников выходят в чат или канал после очередного обновления.',
  },
  {
    key: 'stripLinksEnabled',
    label: 'Ссылки',
    hint: 'Перед публикацией ссылки удаляются из текста, а вложения-ссылки не прикладываются.',
  },
  {
    key: 'skipAdsEnabled',
    label: 'Без рекламы',
    hint: 'Посты с рекламной маркировкой или явными рекламными признаками остаются в ленте как пропущенные.',
  },
];

export const SOURCE_HINT =
  'Подключайте публичные сообщества VK. Первичный импорт не автопубликует старые посты.';
