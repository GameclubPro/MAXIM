import type {
  NativeTesseractWorkerRecognizeRequest,
  NativeTesseractWorkerRequest,
} from './native-tesseract-worker.protocol';

export function isNativeTesseractWorkerRequest(
  value: unknown,
  limits: { maxImageBytes: number; maxTimeoutMs: number },
): value is NativeTesseractWorkerRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return isShutdownRequest(value) || isRecognizeRequest(value, limits);
}

function isShutdownRequest(
  value: object,
): value is Extract<NativeTesseractWorkerRequest, { type: 'shutdown' }> {
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'shutdown' && Object.keys(candidate).length === 1;
}

function isRecognizeRequest(
  value: object,
  limits: { maxImageBytes: number; maxTimeoutMs: number },
): value is NativeTesseractWorkerRecognizeRequest {
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'recognize' &&
    typeof candidate.jobId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.jobId,
    ) &&
    Buffer.isBuffer(candidate.image) &&
    candidate.image.byteLength >= 1 &&
    candidate.image.byteLength <= limits.maxImageBytes &&
    (candidate.psm === 6 || candidate.psm === 11) &&
    Number.isSafeInteger(candidate.timeoutMs) &&
    (candidate.timeoutMs as number) >= 1 &&
    (candidate.timeoutMs as number) <= limits.maxTimeoutMs
  );
}
