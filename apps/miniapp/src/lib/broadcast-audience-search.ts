import { normalizeBroadcastAudienceTargetChatIds } from './broadcast-audience';

export function orderBroadcastAudienceChoices<T extends { id: string }>(
  items: readonly T[],
  options: {
    currentChatId?: string | null;
    favoriteChatIds?: readonly string[];
  } = {},
): T[] {
  if (items.length === 0) {
    return [];
  }

  const itemById = new Map<string, T>();
  const orderedIds: string[] = [];
  for (const item of items) {
    const id = item.id.trim();
    if (!id) {
      continue;
    }

    if (!itemById.has(id)) {
      orderedIds.push(id);
    }
    itemById.set(id, item);
  }

  const result: T[] = [];
  const pickedIds = new Set<string>();
  const pick = (id: string) => {
    const normalizedId = id.trim();
    if (!normalizedId || pickedIds.has(normalizedId)) {
      return;
    }

    const item = itemById.get(normalizedId);
    if (!item) {
      return;
    }

    pickedIds.add(normalizedId);
    result.push(item);
  };

  for (const favoriteId of normalizeBroadcastAudienceTargetChatIds(options.favoriteChatIds ?? [])) {
    pick(favoriteId);
  }

  pick(options.currentChatId ?? '');

  for (const id of orderedIds) {
    pick(id);
  }

  return result;
}

export function filterBroadcastAudienceChoices<
  T extends { id: string; title: string; link?: string | null },
>(items: readonly T[], query: string): T[] {
  const queryTokenVariants = buildBroadcastAudienceSearchTextVariants(query).map((text) =>
    text.split(' ').filter(Boolean),
  );
  if (queryTokenVariants.length === 0) {
    return [...items];
  }

  return items.filter((item) => {
    const searchable = buildBroadcastAudienceSearchDocument(item);
    return queryTokenVariants.some((queryTokens) =>
      queryTokens.every(
        (token) =>
          searchable.texts.some((text) => text.includes(token)) ||
          searchable.compacts.some((compact) => compact.includes(token)),
      ),
    );
  });
}

const LATIN_TO_RUSSIAN_KEYBOARD: Record<string, string> = {
  '`': 'е',
  q: 'й',
  w: 'ц',
  e: 'у',
  r: 'к',
  t: 'е',
  y: 'н',
  u: 'г',
  i: 'ш',
  o: 'щ',
  p: 'з',
  '[': 'х',
  ']': 'ъ',
  a: 'ф',
  s: 'ы',
  d: 'в',
  f: 'а',
  g: 'п',
  h: 'р',
  j: 'о',
  k: 'л',
  l: 'д',
  ';': 'ж',
  "'": 'э',
  z: 'я',
  x: 'ч',
  c: 'с',
  v: 'м',
  b: 'и',
  n: 'т',
  m: 'ь',
  ',': 'б',
  '.': 'ю',
};

const RUSSIAN_TO_LATIN_KEYBOARD: Record<string, string> = Object.fromEntries(
  Object.entries(LATIN_TO_RUSSIAN_KEYBOARD).map(([latin, russian]) => [russian, latin]),
);

const RUSSIAN_TRANSLIT_PRIMARY: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const RUSSIAN_TRANSLIT_SECONDARY: Record<string, string> = {
  ...RUSSIAN_TRANSLIT_PRIMARY,
  ё: 'yo',
  й: 'i',
  х: 'kh',
  ц: 'ts',
  щ: 'shch',
  ы: 'i',
  ю: 'iu',
  я: 'ia',
};

function normalizeBroadcastAudienceSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[Ёё]/gu, 'е')
    .toLowerCase()
    .replace(/https?:\/\/|www\.max\.ru|max\.ru|maxru|@/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function buildBroadcastAudienceSearchTextVariants(value: string): string[] {
  const variants = new Set<string>();
  for (const rawValue of [
    value,
    convertKeyboardLayout(value, LATIN_TO_RUSSIAN_KEYBOARD),
    convertKeyboardLayout(value, RUSSIAN_TO_LATIN_KEYBOARD),
    transliterateRussianText(value, RUSSIAN_TRANSLIT_PRIMARY),
    transliterateRussianText(value, RUSSIAN_TRANSLIT_SECONDARY),
  ]) {
    const normalized = normalizeBroadcastAudienceSearchText(rawValue);
    if (normalized) {
      variants.add(normalized);
    }
  }

  return [...variants];
}

function convertKeyboardLayout(value: string, map: Readonly<Record<string, string>>): string {
  return Array.from(value)
    .map((character) => map[character.toLowerCase()] ?? character)
    .join('');
}

function transliterateRussianText(value: string, map: Readonly<Record<string, string>>): string {
  return Array.from(value)
    .map((character) => map[character.toLowerCase()] ?? character)
    .join('');
}

function buildBroadcastAudienceSearchDocument<
  T extends { id: string; title: string; link?: string | null },
>(item: T): { texts: string[]; compacts: string[] } {
  const texts = buildBroadcastAudienceSearchTextVariants(
    [item.title, item.id, item.link?.trim() ?? ''].join(' '),
  );
  return {
    texts,
    compacts: texts.map((text) => text.replace(/\s+/gu, '')),
  };
}
