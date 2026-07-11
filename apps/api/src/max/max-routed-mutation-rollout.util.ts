import { createHash } from 'node:crypto';

export type MaxRoutedMutationMode = 'off' | 'shadow' | 'canary' | 'on';

export function normalizeMaxRoutedMutationMode(value: unknown): MaxRoutedMutationMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'off' ||
    normalized === 'shadow' ||
    normalized === 'canary' ||
    normalized === 'on'
    ? normalized
    : 'shadow';
}

export function normalizeMaxRoutedMutationCanaryPercent(value: unknown): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, Math.min(100, numericValue)) : 1;
}

export function parseMaxRoutedMutationCanaryEntityIds(value: unknown): ReadonlySet<string> {
  const raw = typeof value === 'string' ? value : '';
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function shouldEnforceMaxRoutedMutation(params: {
  mode: MaxRoutedMutationMode;
  canaryPercent: number;
  canaryEntityIds: ReadonlySet<string>;
  entityId: string;
  rolloutKey: string;
}): boolean {
  if (params.mode === 'on') {
    return true;
  }
  if (params.mode !== 'canary' || params.canaryPercent <= 0) {
    return false;
  }

  const normalizedEntityId = params.entityId.trim();
  if (
    !normalizedEntityId ||
    (!params.canaryEntityIds.has('*') && !params.canaryEntityIds.has(normalizedEntityId))
  ) {
    return false;
  }
  if (params.canaryPercent >= 100) {
    return true;
  }

  const bucket = createHash('sha256').update(params.rolloutKey).digest().readUInt32BE(0) % 10_000;
  return bucket < Math.round(params.canaryPercent * 100);
}
