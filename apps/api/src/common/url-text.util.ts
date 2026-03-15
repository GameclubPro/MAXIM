const URL_TEXT_PATTERN = /((https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}]{2,}))(\/\S*)?/giu;

function createUrlTextRegex(): RegExp {
  return new RegExp(URL_TEXT_PATTERN);
}

export function extractUrlsFromText(value: string): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  return [...value.matchAll(createUrlTextRegex())]
    .map((match) => match[0].trim().replace(/[),.;!?]+$/, ''))
    .filter((url) => url.length > 0);
}

export function stripUrlsFromText(value: string): string {
  if (!value) {
    return '';
  }

  return value.replace(createUrlTextRegex(), ' ').replace(/\s+/g, ' ').trim();
}
