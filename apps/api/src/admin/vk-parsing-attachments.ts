import { createHash } from 'node:crypto';

export type VkParsingUnsupportedAttachmentSummary = {
  type: string;
  label: string;
  title: string | null;
  url: string | null;
  count: number;
  reason: string | null;
};

export type VkParsingPhotoMediaIdentity = {
  url: string;
  mediaIdentity: string;
};

export type VkParsingAttachmentRegistryResult = {
  attachmentTypes: string[];
  photoUrls: string[];
  linkUrls: string[];
  unsupportedAttachments: VkParsingUnsupportedAttachmentSummary[];
  hasUnsupportedAttachments: boolean;
  advertisingMarkers: string[];
  isAdvertising: boolean;
  photoMedia: VkParsingPhotoMediaIdentity[];
  copyHistoryText: string[];
};

const VK_AD_DISCLOSURE_PATTERNS = [
  /(^|[\s#(.,;:!?-])реклама($|[\s#).,;:!?-])/iu,
  /на\s+правах\s+рекламы/iu,
  /рекламодатель/iu,
  /рекламн(?:ый|ая|ое|ые)\s+(?:материал|пост|публикац)/iu,
  /партн[её]рск(?:ий|ая|ое|ие)\s+(?:материал|пост|публикац)/iu,
  /\berid\s*[:=]?\s*[A-Za-zА-Яа-я0-9_-]{4,}/iu,
  /токен\s+рекламы/iu,
] as const;

const VK_UNSUPPORTED_ATTACHMENT_LABELS: Record<string, string> = {
  article: 'Статья',
  audio: 'Аудио',
  audio_playlist: 'Плейлист',
  clip: 'Клип',
  copy_history: 'Репост',
  doc: 'Документ',
  event: 'Событие',
  market: 'Товар',
  market_album: 'Подборка товаров',
  page: 'Страница',
  photo: 'Фото',
  photos_list: 'Список фото',
  podcast: 'Подкаст',
  poll: 'Опрос',
  video: 'Видео',
  video_playlist: 'Плейлист видео',
};

export function parseVkWallPostAttachments(params: {
  attachments: unknown;
  rawPost: Record<string, unknown>;
  text: string;
  maxPhotos: number;
  maxLinks: number;
  includeCopyHistoryMedia?: boolean;
}): VkParsingAttachmentRegistryResult {
  const accumulator = createAttachmentAccumulator(params.maxPhotos, params.maxLinks);
  collectAttachments({
    attachments: params.attachments,
    rawPost: params.rawPost,
    accumulator,
    includeCopyHistoryMedia: params.includeCopyHistoryMedia ?? true,
  });

  const advertisingMarkers = detectVkAdvertisingMarkers({
    text: [params.text, ...accumulator.copyHistoryText].join('\n'),
    attachments: readAttachments(params.attachments),
    rawPost: params.rawPost,
  });

  return {
    attachmentTypes: [...accumulator.attachmentTypes],
    photoUrls: [...accumulator.photoUrls.keys()].slice(0, params.maxPhotos),
    linkUrls: [...accumulator.linkUrls].slice(0, params.maxLinks),
    unsupportedAttachments: [...accumulator.unsupportedByKey.values()],
    hasUnsupportedAttachments: accumulator.unsupportedByKey.size > 0,
    advertisingMarkers,
    isAdvertising: advertisingMarkers.length > 0,
    photoMedia: [...accumulator.photoUrls.entries()].map(([url, mediaIdentity]) => ({
      url,
      mediaIdentity,
    })),
    copyHistoryText: accumulator.copyHistoryText,
  };
}

export function detectVkAdvertisingMarkers(params: {
  text: string;
  attachments: Array<Record<string, unknown>>;
  rawPost: Record<string, unknown>;
}): string[] {
  const markers = new Set<string>();
  if (readBooleanFlag(params.rawPost.marked_as_ads)) {
    markers.add('VK marked_as_ads');
  }

  const haystack = [params.text, ...extractAttachmentText(params.attachments)]
    .filter(Boolean)
    .join('\n');
  for (const pattern of VK_AD_DISCLOSURE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = haystack.match(pattern);
    if (match?.[0]) {
      markers.add(match[0].trim());
    }
  }

  return [...markers];
}

function createAttachmentAccumulator(maxPhotos: number, maxLinks: number) {
  return {
    maxPhotos,
    maxLinks,
    attachmentTypes: new Set<string>(),
    photoUrls: new Map<string, string>(),
    linkUrls: new Set<string>(),
    unsupportedByKey: new Map<string, VkParsingUnsupportedAttachmentSummary>(),
    copyHistoryText: [] as string[],
  };
}

function collectAttachments(params: {
  attachments: unknown;
  rawPost: Record<string, unknown>;
  accumulator: ReturnType<typeof createAttachmentAccumulator>;
  includeCopyHistoryMedia: boolean;
}): void {
  const attachments = readAttachments(params.attachments);
  for (const attachment of attachments) {
    const type = readString(attachment.type).toLowerCase();
    if (!type) {
      continue;
    }
    params.accumulator.attachmentTypes.add(type);

    if (type === 'photo') {
      collectPhotoAttachment(attachment, params.accumulator);
      continue;
    }
    if (type === 'link') {
      collectLinkAttachment(attachment, params.accumulator);
      continue;
    }

    collectUnsupportedAttachment(type, attachment, params.accumulator);
  }

  const copyHistory = Array.isArray(params.rawPost.copy_history) ? params.rawPost.copy_history : [];
  if (copyHistory.length === 0) {
    return;
  }

  collectUnsupportedAttachment(
    'copy_history',
    { type: 'copy_history', copy_history: copyHistory },
    params.accumulator,
  );

  for (const item of copyHistory) {
    const post = asRecord(item);
    if (!post) {
      continue;
    }
    const text = readString(post.text).trim();
    if (text) {
      params.accumulator.copyHistoryText.push(text);
    }
    if (params.includeCopyHistoryMedia) {
      collectAttachments({
        attachments: post.attachments,
        rawPost: post,
        accumulator: params.accumulator,
        includeCopyHistoryMedia: false,
      });
    }
  }
}

function collectPhotoAttachment(
  attachment: Record<string, unknown>,
  accumulator: ReturnType<typeof createAttachmentAccumulator>,
): void {
  const photo = asRecord(attachment.photo);
  const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
  const best = sizes
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((size) => ({
      url: normalizeHttpUrl(readString(size.url) || readString(size.src)),
      area: Math.max(0, readNumber(size.width) ?? 0) * Math.max(0, readNumber(size.height) ?? 0),
    }))
    .filter((size): size is { url: string; area: number } => Boolean(size.url))
    .sort((left, right) => right.area - left.area)[0];

  if (!best?.url) {
    collectUnsupportedAttachment('photo', attachment, accumulator, 'Нет доступного URL фото');
    return;
  }

  if (accumulator.photoUrls.size >= accumulator.maxPhotos && !accumulator.photoUrls.has(best.url)) {
    return;
  }
  accumulator.photoUrls.set(best.url, resolvePhotoMediaIdentity(photo, best.url));
}

function collectLinkAttachment(
  attachment: Record<string, unknown>,
  accumulator: ReturnType<typeof createAttachmentAccumulator>,
): void {
  const link = asRecord(attachment.link);
  const url = normalizeHttpUrl(readString(link?.url));
  if (!url) {
    return;
  }
  if (accumulator.linkUrls.size < accumulator.maxLinks || accumulator.linkUrls.has(url)) {
    accumulator.linkUrls.add(url);
  }
}

function collectUnsupportedAttachment(
  type: string,
  attachment: Record<string, unknown>,
  accumulator: ReturnType<typeof createAttachmentAccumulator>,
  reason: string | null = null,
): void {
  const payload = asRecord(attachment[type]) ?? attachment;
  const title =
    readString(payload.title) ||
    readString(payload.name) ||
    readString(payload.question) ||
    readString(payload.text);
  const url = normalizeHttpUrl(readString(payload.url) || readString(payload.link));
  const key = `${type}:${title || ''}:${url || ''}:${reason || ''}`;
  const existing = accumulator.unsupportedByKey.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }

  accumulator.unsupportedByKey.set(key, {
    type,
    label: VK_UNSUPPORTED_ATTACHMENT_LABELS[type] ?? type,
    title: title || null,
    url: url || null,
    count: 1,
    reason,
  });
}

function resolvePhotoMediaIdentity(photo: Record<string, unknown> | null, url: string): string {
  const ownerId = readNumber(photo?.owner_id);
  const id = readNumber(photo?.id);
  const accessKey = readString(photo?.access_key);
  if (typeof ownerId === 'number' && typeof id === 'number') {
    return ['vk-photo', ownerId, id, accessKey].filter((part) => String(part).length > 0).join(':');
  }

  return `vk-photo-url:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}

function extractAttachmentText(attachments: Array<Record<string, unknown>>): string[] {
  const values: string[] = [];
  for (const attachment of attachments) {
    const type = readString(attachment.type).toLowerCase();
    const payload = asRecord(attachment[type]) ?? asRecord(attachment.link);
    if (!payload) {
      continue;
    }
    values.push(
      readString(payload.title),
      readString(payload.description),
      readString(payload.caption),
      readString(payload.text),
      readString(payload.name),
      readString(payload.question),
    );
  }

  return values.filter((value) => value.trim().length > 0);
}

function readAttachments(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readBooleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeHttpUrl(value: string): string {
  if (!value) {
    return '';
  }
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}
