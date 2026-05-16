import type { ChatSettings } from '../prisma/prisma-client';
import { normalizeMixedWriting } from './rule-engine-normalization';

const THEMATIC_CODEWORD_MIN_LENGTH = 90;

export type TopicFilterDetection = {
  mode: 'CODEWORD';
  messageLength: number;
  requiredCodeword: string;
  messageFirstToken: string | null;
};

export function detectTopicFilterMismatch(params: {
  rawText: string;
  measuredLength: number;
  settings: ChatSettings;
}): TopicFilterDetection | null {
  const { rawText, measuredLength, settings } = params;
  const requiredCodeword = resolveRequiredThematicCodeword(settings);
  if (!requiredCodeword || measuredLength < THEMATIC_CODEWORD_MIN_LENGTH) {
    return null;
  }

  const messageFirstToken = extractFirstThematicCodewordToken(rawText);
  if (messageFirstToken === requiredCodeword) {
    return null;
  }

  return {
    mode: 'CODEWORD',
    messageLength: measuredLength,
    requiredCodeword,
    messageFirstToken,
  };
}

function resolveRequiredThematicCodeword(settings: ChatSettings): string | null {
  if (!settings.thematicCodewordEnabled) {
    return null;
  }

  return normalizeThematicCodeword(settings.thematicCodeword);
}

function normalizeThematicCodeword(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeMixedWriting(value.toLowerCase()).replace(/ё/g, 'е').trim();
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/\s+/u).filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }

  const canonical = canonicalizeThematicCodewordToken(parts[0]);
  if (!canonical || canonical.length < 2 || canonical.length > 32) {
    return null;
  }

  return canonical;
}

function extractFirstThematicCodewordToken(value: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeMixedWriting(value.toLowerCase()).replace(/ё/g, 'е');
  const match = normalized.match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/u);
  if (!match) {
    return null;
  }

  return canonicalizeThematicCodewordToken(match[0]);
}

function canonicalizeThematicCodewordToken(value: string): string | null {
  const fragments = value.match(/[\p{L}\p{N}]+/gu);
  if (!fragments || fragments.length === 0) {
    return null;
  }

  return fragments.join('');
}
