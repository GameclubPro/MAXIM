import { mapCommercialOcrEvalWithConcurrency } from './commercial-ocr-eval-runner';

describe('commercial OCR eval runner concurrency', () => {
  it('bounds concurrent cases and keeps manifest order in the result', async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await mapCommercialOcrEvalWithConcurrency([4, 1, 3, 2], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 10;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([40, 10, 30, 20]);
  });

  it.each([0, 5, 1.5])('rejects invalid concurrency %p', async (concurrency) => {
    await expect(
      mapCommercialOcrEvalWithConcurrency([1], concurrency, async (value) => value),
    ).rejects.toThrow(/concurrency must be between 1 and 4/u);
  });
});
