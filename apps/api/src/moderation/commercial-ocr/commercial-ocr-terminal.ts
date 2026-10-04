export const COMMERCIAL_OCR_TERMINAL_OUTCOMES = [
  'COMPLETE_KEEP',
  'COMPLETE_DELETE_CANDIDATE',
  'TECHNICAL_INCOMPLETE',
  'LEGITIMATE_SKIP',
  'EXPIRED',
] as const;

export const COMMERCIAL_OCR_TERMINAL_REASONS = [
  'complete',
  'expired',
  'invalid_job',
  'worker_failed',
  'policy_ineligible',
  'author_ineligible',
  'admission_missing',
  'admission_unavailable',
  'admission_suppressed',
  'source_receipt_unavailable',
  'source_receipt_missing',
  'source_receipt_terminal',
  'source_unavailable',
  'source_absent',
  'source_invalid',
  'source_changed',
  'source_author_ineligible',
  'source_not_ready',
  'governor_pressure',
  'native_backpressure',
  'admission_pending',
  'invalid_album',
  'job_deadline_exceeded',
  'missing_download_url',
  'download_failed',
  'image_rejected',
  'preprocess_timeout',
  'ocr_failed',
  'ocr_timeout',
  'ocr_request_timeout',
  'ocr_truncated',
  'invalid_ocr_output',
] as const;

export type CommercialOcrTerminalOutcome = (typeof COMMERCIAL_OCR_TERMINAL_OUTCOMES)[number];
export type CommercialOcrTerminalReason = (typeof COMMERCIAL_OCR_TERMINAL_REASONS)[number];
export type CommercialOcrTerminalResult = Readonly<{
  outcome: CommercialOcrTerminalOutcome;
  reason: CommercialOcrTerminalReason;
}>;

export function commercialOcrCompleted(
  outcome: CommercialOcrTerminalOutcome,
  reason: CommercialOcrTerminalReason,
): { kind: 'completed'; terminal: CommercialOcrTerminalResult } {
  return { kind: 'completed', terminal: { outcome, reason } };
}

export function isCommercialOcrTerminalResult(
  value: unknown,
): value is CommercialOcrTerminalResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    COMMERCIAL_OCR_TERMINAL_OUTCOMES.includes(row.outcome as CommercialOcrTerminalOutcome) &&
    COMMERCIAL_OCR_TERMINAL_REASONS.includes(row.reason as CommercialOcrTerminalReason)
  );
}
