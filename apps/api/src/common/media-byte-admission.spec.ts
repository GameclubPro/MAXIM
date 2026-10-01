import { MediaByteAdmission, MediaByteAdmissionError } from './media-byte-admission';

describe('MediaByteAdmission', () => {
  afterEach(() => jest.useRealTimers());

  it('reserves bytes before work and releases an active permit exactly once', () => {
    const admission = new MediaByteAdmission(10, 2);
    const first = admission.tryAcquire(6)!;
    expect(admission.tryAcquire(5)).toBeNull();
    const second = admission.tryAcquire(4)!;
    expect(admission.getSnapshot()).toMatchObject({ reservedBytes: 10, active: 2 });
    first.release();
    first.release();
    second.release();
    expect(admission.getSnapshot()).toMatchObject({
      reservedBytes: 0,
      active: 0,
      peakReservedBytes: 10,
    });
  });

  it('keeps FIFO admission and does not let fresh smaller work starve a waiting reservation', async () => {
    const admission = new MediaByteAdmission(10, 2);
    const held = admission.tryAcquire(6)!;
    const order: number[] = [];
    const first = admission.acquire(8, { deadlineAtMs: Date.now() + 1_000 }).then((permit) => {
      order.push(1);
      return permit;
    });
    const second = admission.acquire(2, { deadlineAtMs: Date.now() + 1_000 }).then((permit) => {
      order.push(2);
      return permit;
    });
    expect(admission.tryAcquire(1)).toBeNull();
    expect(admission.getSnapshot()).toMatchObject({ waiting: 2, reservedBytes: 6 });
    held.release();
    const permits = await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(admission.getSnapshot()).toMatchObject({ waiting: 0, reservedBytes: 10 });
    permits.forEach((permit) => permit.release());
  });

  it('rejects bounded metadata queue overflow without reserving payload bytes', async () => {
    const admission = new MediaByteAdmission(10, 1);
    const held = admission.tryAcquire(10)!;
    const pending = admission.acquire(1, { deadlineAtMs: Date.now() + 1_000 });
    await expect(admission.acquire(1, { deadlineAtMs: Date.now() + 1_000 })).rejects.toMatchObject({
      reason: 'queue_full',
    });
    expect(admission.getSnapshot()).toMatchObject({ waiting: 1, reservedBytes: 10 });
    held.release();
    (await pending).release();
  });

  it('removes an aborted head so a fitting live waiter can proceed', async () => {
    const admission = new MediaByteAdmission(10, 2);
    const held = admission.tryAcquire(8)!;
    const controller = new AbortController();
    const rejected = admission.acquire(5, {
      deadlineAtMs: Date.now() + 1_000,
      signal: controller.signal,
    });
    const rejection = expect(rejected).rejects.toMatchObject({ reason: 'aborted' });
    const next = admission.acquire(2, { deadlineAtMs: Date.now() + 1_000 });
    controller.abort();
    await rejection;
    const permit = await next;
    expect(admission.getSnapshot()).toMatchObject({ waiting: 0, reservedBytes: 10 });
    permit.release();
    held.release();
  });

  it('expires waiting work at its absolute deadline without leaking its permit', async () => {
    jest.useFakeTimers();
    const admission = new MediaByteAdmission(10, 2);
    const held = admission.tryAcquire(10)!;
    const pending = admission.acquire(8, { deadlineAtMs: Date.now() + 25 });
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'deadline' });
    await jest.advanceTimersByTimeAsync(25);
    await rejection;
    held.release();
    expect(admission.getSnapshot()).toMatchObject({ waiting: 0, reservedBytes: 0, active: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rechecks deadlines before granting after event-loop delay', async () => {
    jest.useFakeTimers();
    const admission = new MediaByteAdmission(10, 2);
    const held = admission.tryAcquire(10)!;
    const pending = admission.acquire(8, { deadlineAtMs: Date.now() + 25 });
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'deadline' });
    jest.setSystemTime(Date.now() + 100);
    held.release();
    await rejection;
    expect(admission.getSnapshot()).toMatchObject({ waiting: 0, reservedBytes: 0 });
  });

  it('rejects waiting work when stopping and allows active consumers to settle', async () => {
    jest.useFakeTimers();
    const admission = new MediaByteAdmission(10, 2);
    const held = admission.tryAcquire(10)!;
    const pending = admission.acquire(8, { deadlineAtMs: Date.now() + 100 });
    const rejection = expect(pending).rejects.toBeInstanceOf(MediaByteAdmissionError);
    admission.close();
    await rejection;
    expect(admission.getSnapshot()).toMatchObject({ waiting: 0, active: 1, stopping: true });
    expect(jest.getTimerCount()).toBe(0);
    expect(admission.tryAcquire(1)).toBeNull();
    await expect(admission.acquire(1, { deadlineAtMs: Date.now() + 100 })).rejects.toMatchObject({
      reason: 'stopping',
    });
    held.release();
    expect(admission.getSnapshot()).toMatchObject({ reservedBytes: 0, active: 0 });
  });

  it('rejects elapsed deadlines and pre-aborted signals before any allocation', async () => {
    const admission = new MediaByteAdmission(10, 2);
    await expect(admission.acquire(5, { deadlineAtMs: Date.now() })).rejects.toMatchObject({
      reason: 'deadline',
    });
    await expect(
      admission.acquire(5, { deadlineAtMs: Date.now() + 100, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ reason: 'aborted' });
    expect(admission.getSnapshot()).toMatchObject({ waiting: 0, reservedBytes: 0, active: 0 });
  });

  it.each([0, -1, 11, 0.5, NaN])('rejects a reservation %s that cannot fit', (bytes) => {
    const admission = new MediaByteAdmission(10, 2);
    expect(() => admission.tryAcquire(bytes)).toThrow(RangeError);
  });
});
