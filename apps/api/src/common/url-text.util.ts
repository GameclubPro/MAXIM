const URL_DELIMITER_PATTERN = /[\s<>"'`()[\]{}]/u;
const FORMAT_CONTROL_CHAR_PATTERN = /\p{Cf}/u;
const FORMAT_CONTROL_CHARS_PATTERN = /\p{Cf}+/gu;
const SCHEME_URL_PATTERN = /https?:\/\/[^\s<>"'`()[\]{}]+/giu;
const BARE_URL_PATTERN =
  /(?<![@\p{L}\p{N}\p{Cf}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,24}|рф)(?:[/?#][^\s<>"'`()[\]{}]+)?/giu;
const TRAILING_URL_PUNCTUATION_PATTERN = /[)\]},.;!?:]+$/u;
const COMMON_FILE_EXTENSION_TLDS = new Set([
  'avi',
  'csv',
  'doc',
  'docx',
  'gif',
  'jpeg',
  'jpg',
  'mkv',
  'mp3',
  'mp4',
  'odp',
  'ods',
  'odt',
  'ogg',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'rtf',
  'txt',
  'wav',
  'webm',
  'webp',
  'xls',
  'xlsx',
]);

type UrlMatch = {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  text: string;
};

type PreparedUrlText = {
  text: string;
  originalIndexBySourceIndex: number[] | null;
};

function createSchemeUrlRegex(): RegExp {
  return new RegExp(SCHEME_URL_PATTERN);
}

function createBareUrlRegex(): RegExp {
  return new RegExp(BARE_URL_PATTERN);
}

function normalizeMatchedUrl(value: string): string {
  return value
    .trim()
    .replace(FORMAT_CONTROL_CHARS_PATTERN, '')
    .replace(TRAILING_URL_PUNCTUATION_PATTERN, '');
}

function prepareTextForUrlMatching(value: string): PreparedUrlText {
  if (!FORMAT_CONTROL_CHAR_PATTERN.test(value)) {
    return {
      text: value,
      originalIndexBySourceIndex: null,
    };
  }

  let text = '';
  const originalIndexBySourceIndex: number[] = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    const char = String.fromCodePoint(codePoint ?? value.charCodeAt(index));
    const charLength = char.length;
    if (FORMAT_CONTROL_CHAR_PATTERN.test(char)) {
      index += charLength;
      continue;
    }

    for (let offset = 0; offset < charLength; offset += 1) {
      originalIndexBySourceIndex[text.length + offset] = index + offset;
    }
    text += char;
    index += charLength;
  }
  originalIndexBySourceIndex[text.length] = value.length;

  return {
    text,
    originalIndexBySourceIndex,
  };
}

function collectMatches(
  value: string,
  regex: RegExp,
  originalIndexBySourceIndex: number[] | null,
): UrlMatch[] {
  const matches: UrlMatch[] = [];

  for (const match of value.matchAll(regex)) {
    const raw = match[0];
    const text = normalizeMatchedUrl(raw);
    if (!text) {
      continue;
    }

    const sourceStart = match.index ?? 0;
    const sourceEnd = sourceStart + raw.length;
    const start = originalIndexBySourceIndex?.[sourceStart] ?? sourceStart;
    const end = originalIndexBySourceIndex?.[sourceEnd] ?? sourceEnd;
    matches.push({
      start,
      end,
      sourceStart,
      sourceEnd,
      text,
    });
  }

  return matches;
}

function rangesOverlap(left: UrlMatch, right: UrlMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

function isContainedWithin(left: UrlMatch, right: UrlMatch): boolean {
  return left.start >= right.start && left.end <= right.end;
}

function endsAtUrlDelimiter(value: string, index: number): boolean {
  if (index >= value.length) {
    return true;
  }

  const nextChar = value[index] ?? '';
  return URL_DELIMITER_PATTERN.test(nextChar) || TRAILING_URL_PUNCTUATION_PATTERN.test(nextChar);
}

function isLikelyNumberedListItem(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//iu.test(trimmed)) {
    return false;
  }

  const hostEnd = trimmed.search(/[/?#]/u);
  const host = hostEnd === -1 ? trimmed : trimmed.slice(0, hostEnd);
  const parts = host.split('.');
  if (parts.length !== 2) {
    return false;
  }

  return /^\d+$/u.test(parts[0]);
}

function isLikelyBareFileName(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed ||
    /^https?:\/\//iu.test(trimmed) ||
    /^www\./iu.test(trimmed) ||
    /[/?#]/u.test(trimmed)
  ) {
    return false;
  }

  const parts = trimmed.toLowerCase().split('.');
  const extension = parts[parts.length - 1] ?? '';
  return COMMON_FILE_EXTENSION_TLDS.has(extension);
}

function collectUrlMatches(value: string): UrlMatch[] {
  const prepared = prepareTextForUrlMatching(value);
  const schemeMatches = collectMatches(
    prepared.text,
    createSchemeUrlRegex(),
    prepared.originalIndexBySourceIndex,
  );
  const bareMatches = collectMatches(
    prepared.text,
    createBareUrlRegex(),
    prepared.originalIndexBySourceIndex,
  ).filter(
    (candidate) =>
      !schemeMatches.some(
        (existing) => rangesOverlap(candidate, existing) && isContainedWithin(candidate, existing),
      ) &&
      !isLikelyNumberedListItem(candidate.text) &&
      !isLikelyBareFileName(candidate.text),
  );

  return [...schemeMatches, ...bareMatches]
    .filter((candidate) =>
      endsAtUrlDelimiter(prepared.text, candidate.sourceStart + candidate.text.length),
    )
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

export function extractUrlsFromText(value: string): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const extracted: string[] = [];

  for (const match of collectUrlMatches(value)) {
    if (seen.has(match.text)) {
      continue;
    }

    seen.add(match.text);
    extracted.push(match.text);
  }

  return extracted;
}

export function stripUrlsFromText(value: string): string {
  if (!value) {
    return '';
  }

  const matches = collectUrlMatches(value);
  if (matches.length === 0) {
    return value.replace(/\s+/g, ' ').trim();
  }

  let cursor = 0;
  let result = '';

  for (const match of matches) {
    if (match.end <= cursor) {
      continue;
    }

    result += value.slice(cursor, match.start);
    result += ' ';
    cursor = match.end;
  }

  result += value.slice(cursor);
  return result.replace(/\s+/g, ' ').trim();
}
