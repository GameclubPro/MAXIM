import { isNativeTesseractWorkerRequest } from './native-tesseract-worker-validation';

const limits = { maxImageBytes: 8, maxTimeoutMs: 5_000 };
const validRecognize = {
  type: 'recognize',
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  image: Buffer.from('image'),
  psm: 11,
  timeoutMs: 1_000,
};

describe('native Tesseract worker IPC validation', () => {
  it('accepts only bounded shutdown and recognize requests', () => {
    expect(isNativeTesseractWorkerRequest({ type: 'shutdown' }, limits)).toBe(true);
    expect(isNativeTesseractWorkerRequest(validRecognize, limits)).toBe(true);
    expect(isNativeTesseractWorkerRequest({ ...validRecognize, psm: 6 }, limits)).toBe(true);
  });

  it.each([
    null,
    { type: 'shutdown', extra: true },
    { ...validRecognize, jobId: 'not-a-v4-uuid' },
    { ...validRecognize, image: new Uint8Array([1]) },
    { ...validRecognize, image: Buffer.alloc(0) },
    { ...validRecognize, image: Buffer.alloc(9) },
    { ...validRecognize, psm: 3 },
    { ...validRecognize, timeoutMs: 0 },
    { ...validRecognize, timeoutMs: 5_001 },
    { ...validRecognize, timeoutMs: 1.5 },
  ])('rejects malformed or unbounded IPC: %#', (request) => {
    expect(isNativeTesseractWorkerRequest(request, limits)).toBe(false);
  });
});
