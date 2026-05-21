export function readPositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export function resolveModerationConcurrencySplit(total: number): {
  critical: number;
  default: number;
  background: number;
} {
  if (total <= 2) {
    return {
      critical: 1,
      default: 1,
      background: 1,
    };
  }

  if (total === 3) {
    return {
      critical: 1,
      default: 1,
      background: 1,
    };
  }

  const background = total >= 8 ? 2 : 1;
  const critical = Math.max(1, Math.ceil(total * 0.35));
  const defaultQueue = Math.max(1, total - critical - background);

  return {
    critical,
    default: defaultQueue,
    background,
  };
}

export function resolveShardConcurrencyDistribution(total: number, shardCount: number): number[] {
  if (shardCount <= 1) {
    return [Math.max(1, total)];
  }

  const normalizedTotal = Math.max(1, total);
  const base = Math.floor(normalizedTotal / shardCount);
  let remainder = normalizedTotal % shardCount;

  return Array.from({ length: shardCount }, () => {
    const next = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) {
      remainder -= 1;
    }
    return Math.max(1, next);
  });
}
