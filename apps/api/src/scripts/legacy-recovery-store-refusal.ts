export type LegacyRecoveryStoreRefusal =
  | 'transaction_unavailable'
  | 'query_cancelled'
  | 'query_timeout'
  | 'pool_timeout'
  | 'lock_unavailable'
  | 'deadlock'
  | 'connection_unavailable'
  | 'query_failed';

// FLAG: Classify only fixed driver codes through bounded known adapter wrappers.
// Never serialize messages, query text, parameters, causes or unrecognized codes.
export function classifyLegacyRecoveryStoreRefusal(error: unknown): LegacyRecoveryStoreRefusal {
  const pending: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const { value, depth } = pending[index]!;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    for (const code of [row.code, row.originalCode]) {
      if (code === 'P2028') return 'transaction_unavailable';
      if (code === '57014') return 'query_cancelled';
      if (code === 'P1008') return 'query_timeout';
      if (code === 'P2024') return 'pool_timeout';
      if (code === '55P03') return 'lock_unavailable';
      if (code === '40P01') return 'deadlock';
      if (
        [
          'P1001',
          'P1002',
          'P1017',
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
        ].includes(typeof code === 'string' ? code : '')
      )
        return 'connection_unavailable';
    }
    if (depth < 3)
      for (const key of ['meta', 'cause', 'driverAdapterError'])
        pending.push({ value: row[key], depth: depth + 1 });
  }
  return 'query_failed';
}
