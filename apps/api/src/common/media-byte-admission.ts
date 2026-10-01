export type MediaByteAdmissionFailure = 'deadline' | 'aborted' | 'queue_full' | 'stopping';

export class MediaByteAdmissionError extends Error {
  constructor(readonly reason: MediaByteAdmissionFailure) {
    super(`Media preparation admission ${reason}`);
    this.name = 'MediaByteAdmissionError';
  }
}

export interface MediaBytePermit {
  release(): void;
}

type Waiter = {
  bytes: number;
  deadlineAtMs: number;
  resolve(permit: MediaBytePermit): void;
  reject(error: MediaByteAdmissionError): void;
  cleanup(): void;
};

// FLAG: Acquire before allocating media. A permit must cover all sibling work through
// the last consumer, including error settlement. This bounds reserved encoded bytes;
// native raster memory and unrelated callers require their own independent limits.
export class MediaByteAdmission {
  private reservedBytes = 0;
  private active = 0;
  private peakReservedBytes = 0;
  private peakWaiting = 0;
  private stopping = false;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly budgetBytes: number,
    private readonly maxWaiters: number,
  ) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
      throw new RangeError('Media byte budget must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0) {
      throw new RangeError('Media waiter limit must be a nonnegative safe integer');
    }
  }

  tryAcquire(bytes: number): MediaBytePermit | null {
    this.assertReservation(bytes);
    if (this.stopping || this.waiters.length > 0 || bytes > this.budgetBytes - this.reservedBytes) {
      return null;
    }
    return this.grant(bytes);
  }

  acquire(
    bytes: number,
    options: { deadlineAtMs: number; signal?: AbortSignal },
  ): Promise<MediaBytePermit> {
    this.assertReservation(bytes);
    if (!Number.isSafeInteger(options.deadlineAtMs)) {
      throw new RangeError('Media admission requires an absolute millisecond deadline');
    }
    if (this.stopping) return Promise.reject(new MediaByteAdmissionError('stopping'));
    if (options.signal?.aborted) return Promise.reject(new MediaByteAdmissionError('aborted'));
    if (options.deadlineAtMs <= Date.now()) {
      return Promise.reject(new MediaByteAdmissionError('deadline'));
    }
    const permit = this.tryAcquire(bytes);
    if (permit) return Promise.resolve(permit);
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(new MediaByteAdmissionError('queue_full'));
    }

    return new Promise<MediaBytePermit>((resolve, reject) => {
      const fail = (reason: MediaByteAdmissionFailure) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.cleanup();
        reject(new MediaByteAdmissionError(reason));
        this.drain();
      };
      const onAbort = () => fail('aborted');
      const timer = setTimeout(
        () => fail('deadline'),
        Math.min(options.deadlineAtMs - Date.now(), 2_147_483_647),
      );
      timer.unref?.();
      const waiter: Waiter = {
        bytes,
        deadlineAtMs: options.deadlineAtMs,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        },
      };
      this.waiters.push(waiter);
      this.peakWaiting = Math.max(this.peakWaiting, this.waiters.length);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    this.stopping = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(new MediaByteAdmissionError('stopping'));
    }
  }

  getSnapshot() {
    return {
      budgetBytes: this.budgetBytes,
      reservedBytes: this.reservedBytes,
      active: this.active,
      waiting: this.waiters.length,
      peakReservedBytes: this.peakReservedBytes,
      peakWaiting: this.peakWaiting,
      stopping: this.stopping,
    };
  }

  private assertReservation(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.budgetBytes) {
      throw new RangeError('Media reservation must fit its byte budget');
    }
  }

  private grant(bytes: number): MediaBytePermit {
    this.reservedBytes += bytes;
    this.active += 1;
    this.peakReservedBytes = Math.max(this.peakReservedBytes, this.reservedBytes);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reservedBytes -= bytes;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (!this.stopping && this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (waiter.deadlineAtMs <= Date.now()) {
        this.waiters.shift();
        waiter.cleanup();
        waiter.reject(new MediaByteAdmissionError('deadline'));
        continue;
      }
      if (waiter.bytes > this.budgetBytes - this.reservedBytes) return;
      this.waiters.shift();
      waiter.cleanup();
      waiter.resolve(this.grant(waiter.bytes));
    }
  }
}
