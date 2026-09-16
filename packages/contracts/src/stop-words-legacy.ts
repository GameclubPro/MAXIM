import { normalizeAllowlistDomain } from './settings-utils.js';

export function normalizeMessageLimitsBlockedWordCandidate(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/ё/g, 'е');
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/\s+/u).filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }

  const fragments = parts[0].match(/[\p{L}\p{N}]+/gu);
  if (!fragments || fragments.length !== 1) {
    return null;
  }

  const [candidate] = fragments;
  return candidate.length >= 2 && candidate.length <= 32 ? candidate : null;
}

export function normalizeMessageLimitsBlockedDomainCandidate(value: string): string | null {
  const normalizedDomain = normalizeAllowlistDomain(value);
  if (!normalizedDomain) {
    return null;
  }

  const candidate = normalizedDomain
    .trim()
    .toLowerCase()
    .replace(/\.$/u, '')
    .replace(/^www\./u, '');
  if (candidate.length < 4 || candidate.length > 253 || !candidate.includes('.')) {
    return null;
  }

  const labels = candidate.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) {
    return null;
  }

  return candidate;
}
