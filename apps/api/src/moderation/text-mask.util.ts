export function maskText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= 4) {
    return '*'.repeat(normalized.length);
  }

  return `${normalized.slice(0, 2)}${'*'.repeat(normalized.length - 4)}${normalized.slice(-2)}`;
}
