import {
  PhotoDecodeBudget,
  PhotoDecodePipelineCapacityError,
  PhotoDecodePipelineGate,
} from './photo-decode-resource';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PhotoDecodeBudget', () => {
  it('bounds cumulative encoded bytes and pixels without consuming a rejected reservation', () => {
    const budget = new PhotoDecodeBudget({ maxEncodedBytes: 10, maxPixels: 20 });

    expect(budget.tryReserve({ encodedBytes: 6, pixels: 12 })).toBe(true);
    expect(budget.tryReserve({ encodedBytes: 5, pixels: 1 })).toBe(false);
    expect(budget.tryReserve({ encodedBytes: 4, pixels: 8 })).toBe(true);
    expect(budget.usage()).toEqual({
      encodedBytes: 10,
      pixels: 20,
      maxEncodedBytes: 10,
      maxPixels: 20,
    });
  });
});

describe('PhotoDecodePipelineGate', () => {
  it('holds a bounded number of native pipelines and rejects excess queued work', async () => {
    const gate = new PhotoDecodePipelineGate(2, 1);
    const first = deferred();
    const second = deferred();
    let active = 0;
    let maximumActive = 0;
    const runBlocked = (blocker: Promise<void>) =>
      gate.run(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await blocker;
        active -= 1;
      });

    const firstRun = runBlocked(first.promise);
    const secondRun = runBlocked(second.promise);
    await Promise.resolve();
    const queuedRun = gate.run(async () => undefined);
    await Promise.resolve();

    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(
      PhotoDecodePipelineCapacityError,
    );
    expect(maximumActive).toBe(2);

    first.resolve();
    second.resolve();
    await expect(Promise.all([firstRun, secondRun, queuedRun])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
