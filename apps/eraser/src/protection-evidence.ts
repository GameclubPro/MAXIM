import { createHash } from 'node:crypto';
import { record, integer, ServiceError } from './types.js';

export type ProtectionEvidence = {
  version: 1;
  source: 'ownership_capture_v1';
  chatId: string;
  sourceRevision: number;
  completeFrom: string;
  completeThrough: string;
  catalogDigest: string;
  referenceCount: number;
  checksum: string;
};

// FLAG: Authentication identifies the control source. The checksum binds its complete
// interval to one exact catalogue revision; audit-import completion alone is not such proof.
export function readProtectionEvidence(value: unknown): ProtectionEvidence {
  const row = record(value);
  const iso = (input: unknown): input is string =>
    typeof input === 'string' &&
    Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input;
  if (
    !row ||
    row.version !== 1 ||
    row.source !== 'ownership_capture_v1' ||
    typeof row.chatId !== 'string' ||
    !/^-[1-9]\d*$/.test(row.chatId) ||
    !integer(row.sourceRevision) ||
    !integer(row.referenceCount) ||
    !iso(row.completeFrom) ||
    !iso(row.completeThrough) ||
    row.completeFrom > row.completeThrough ||
    typeof row.catalogDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.catalogDigest) ||
    typeof row.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.checksum)
  )
    throw new ServiceError(
      400,
      'INVALID_PROTECTION_EVIDENCE',
      'Некорректное подтверждение защиты.',
    );
  const evidence = {
    version: 1 as const,
    source: 'ownership_capture_v1' as const,
    chatId: row.chatId,
    sourceRevision: row.sourceRevision,
    completeFrom: row.completeFrom,
    completeThrough: row.completeThrough,
    catalogDigest: row.catalogDigest,
    referenceCount: row.referenceCount,
  };
  if (createHash('sha256').update(JSON.stringify(evidence)).digest('hex') !== row.checksum)
    throw new ServiceError(
      400,
      'INVALID_PROTECTION_EVIDENCE',
      'Контрольная сумма защиты не совпадает.',
    );
  return { ...evidence, checksum: row.checksum };
}
