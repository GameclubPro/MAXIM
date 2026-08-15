import type { MaxValidatedMediaUpload } from './max-media-upload-validation';
import { MaxMediaUploadValidationCache } from './max-media-upload-validation-cache';

const VALIDATED_IMAGE: MaxValidatedMediaUpload = {
  uploadType: 'image',
  format: 'jpeg',
  extension: 'jpg',
  mimeType: 'image/jpeg',
  width: 8,
  height: 6,
};

describe('MaxMediaUploadValidationCache', () => {
  it('deduplicates concurrent validation for equal payload bytes', async () => {
    let resolveValidation!: (value: MaxValidatedMediaUpload) => void;
    const validator = jest.fn(
      () =>
        new Promise<MaxValidatedMediaUpload>((resolve) => {
          resolveValidation = resolve;
        }),
    );
    const cache = new MaxMediaUploadValidationCache({ validator });

    const first = cache.validate('image', Buffer.from('same payload'));
    const second = cache.validate('image', Buffer.from('same payload'));
    await Promise.resolve();
    expect(validator).toHaveBeenCalledTimes(1);

    resolveValidation(VALIDATED_IMAGE);
    await expect(Promise.all([first, second])).resolves.toEqual([VALIDATED_IMAGE, VALIDATED_IMAGE]);
  });

  it('returns a completed validation from cache', async () => {
    const validator = jest.fn().mockResolvedValue(VALIDATED_IMAGE);
    const cache = new MaxMediaUploadValidationCache({ validator });

    await cache.validate('image', Buffer.from('same payload'));
    await cache.validate('image', Buffer.from('same payload'));

    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('revalidates after the TTL expires', async () => {
    let nowMs = 1_000;
    const validator = jest.fn().mockResolvedValue(VALIDATED_IMAGE);
    const cache = new MaxMediaUploadValidationCache({
      now: () => nowMs,
      ttlMs: 100,
      validator,
    });

    await cache.validate('image', Buffer.from('payload'));
    nowMs = 1_099;
    await cache.validate('image', Buffer.from('payload'));
    nowMs = 1_100;
    await cache.validate('image', Buffer.from('payload'));

    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used completed validation', async () => {
    const validator = jest.fn().mockResolvedValue(VALIDATED_IMAGE);
    const cache = new MaxMediaUploadValidationCache({ maxEntries: 2, validator });

    await cache.validate('image', Buffer.from('first'));
    await cache.validate('image', Buffer.from('second'));
    await cache.validate('image', Buffer.from('first'));
    await cache.validate('image', Buffer.from('third'));
    await cache.validate('image', Buffer.from('second'));

    expect(validator).toHaveBeenCalledTimes(4);
  });

  it('removes a rejected in-flight validation and retries it', async () => {
    const validationError = new Error('invalid media');
    const validator = jest
      .fn()
      .mockRejectedValueOnce(validationError)
      .mockResolvedValueOnce(VALIDATED_IMAGE);
    const cache = new MaxMediaUploadValidationCache({ validator });

    const first = cache.validate('image', Buffer.from('payload'));
    const second = cache.validate('image', Buffer.from('payload'));
    await expect(Promise.all([first, second])).rejects.toBe(validationError);
    expect(validator).toHaveBeenCalledTimes(1);

    await expect(cache.validate('image', Buffer.from('payload'))).resolves.toBe(VALIDATED_IMAGE);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('bounds actual validation concurrency under unique-key saturation', async () => {
    const resolvers: Array<(value: MaxValidatedMediaUpload) => void> = [];
    let activeValidations = 0;
    let maxActiveValidations = 0;
    const validator = jest.fn(
      () =>
        new Promise<MaxValidatedMediaUpload>((resolve) => {
          activeValidations += 1;
          maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
          resolvers.push((value) => {
            activeValidations -= 1;
            resolve(value);
          });
        }),
    );
    const cache = new MaxMediaUploadValidationCache({ maxInFlight: 1, validator });
    const buildKeySpy = jest.spyOn(
      cache as unknown as {
        buildKey(uploadType: 'image' | 'video', data: Buffer): Promise<string>;
      },
      'buildKey',
    );

    const first = cache.validate('image', Buffer.from('first'));
    const second = cache.validate('image', Buffer.from('second'));
    const third = cache.validate('image', Buffer.from('third'));
    const firstDuplicate = cache.validate('image', Buffer.from('first'));
    const secondDuplicate = cache.validate('image', Buffer.from('second'));
    await Promise.resolve();
    expect(validator).toHaveBeenCalledTimes(1);

    resolvers[0]?.(VALIDATED_IMAGE);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(validator).toHaveBeenCalledTimes(2);
    expect(activeValidations).toBe(1);

    resolvers[1]?.(VALIDATED_IMAGE);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(validator).toHaveBeenCalledTimes(3);
    expect(activeValidations).toBe(1);

    resolvers[2]?.(VALIDATED_IMAGE);
    await Promise.all([first, second, third, firstDuplicate, secondDuplicate]);
    expect(activeValidations).toBe(0);
    expect(maxActiveValidations).toBe(1);
    expect(buildKeySpy).toHaveBeenCalledTimes(5);
  });

  it('defaults to at most two concurrent validators', async () => {
    const resolvers: Array<(value: MaxValidatedMediaUpload) => void> = [];
    let activeValidations = 0;
    let maxActiveValidations = 0;
    const validator = jest.fn(
      () =>
        new Promise<MaxValidatedMediaUpload>((resolve) => {
          activeValidations += 1;
          maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
          resolvers.push((value) => {
            activeValidations -= 1;
            resolve(value);
          });
        }),
    );
    const cache = new MaxMediaUploadValidationCache({ validator });

    const first = cache.validate('image', Buffer.from('first'));
    const second = cache.validate('image', Buffer.from('second'));
    const third = cache.validate('image', Buffer.from('third'));
    await Promise.resolve();
    expect(validator).toHaveBeenCalledTimes(2);

    resolvers[0]?.(VALIDATED_IMAGE);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(validator).toHaveBeenCalledTimes(3);
    expect(maxActiveValidations).toBe(2);

    resolvers[1]?.(VALIDATED_IMAGE);
    resolvers[2]?.(VALIDATED_IMAGE);
    await Promise.all([first, second, third]);
    expect(activeValidations).toBe(0);
  });

  it('yields the event loop while hashing large payloads', async () => {
    const validator = jest.fn().mockResolvedValue(VALIDATED_IMAGE);
    const cache = new MaxMediaUploadValidationCache({ validator });

    const validation = cache.validate('image', Buffer.alloc(8 * 1024 * 1024 + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(validator).not.toHaveBeenCalled();
    await expect(validation).resolves.toBe(VALIDATED_IMAGE);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('does not let a validation that completes after clear repopulate the cache', async () => {
    let resolveValidation!: (value: MaxValidatedMediaUpload) => void;
    const validator = jest.fn(
      () =>
        new Promise<MaxValidatedMediaUpload>((resolve) => {
          resolveValidation = resolve;
        }),
    );
    const cache = new MaxMediaUploadValidationCache({ validator });

    const pending = cache.validate('image', Buffer.from('payload'));
    await Promise.resolve();
    cache.clear();
    resolveValidation(VALIDATED_IMAGE);
    await pending;

    const next = cache.validate('image', Buffer.from('payload'));
    await Promise.resolve();
    expect(validator).toHaveBeenCalledTimes(2);
    resolveValidation(VALIDATED_IMAGE);
    await next;
  });
});
