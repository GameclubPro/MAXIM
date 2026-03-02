export function maskText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  const symbols = Array.from(normalized);
  if (symbols.length <= 4) {
    return '*'.repeat(symbols.length);
  }

  return `${symbols.slice(0, 2).join('')}${'*'.repeat(symbols.length - 4)}${symbols
    .slice(-2)
    .join('')}`;
}
