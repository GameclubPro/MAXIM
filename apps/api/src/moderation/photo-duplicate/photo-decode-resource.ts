export type PhotoDecodeCost = {
  encodedBytes: number;
  pixels: number;
};

export type PhotoDecodeBudgetUsage = PhotoDecodeCost & {
  maxEncodedBytes: number;
  maxPixels: number;
};

export class PhotoDecodeBudget {
  private encodedBytes = 0;
  private pixels = 0;

  constructor(
    private readonly limits: {
      maxEncodedBytes: number;
      maxPixels: number;
    },
  ) {
    validatePositiveInteger(limits.maxEncodedBytes, 'maxEncodedBytes');
    validatePositiveInteger(limits.maxPixels, 'maxPixels');
  }

  tryReserve(cost: PhotoDecodeCost): boolean {
    validatePositiveInteger(cost.encodedBytes, 'encodedBytes');
    validatePositiveInteger(cost.pixels, 'pixels');

    if (
      cost.encodedBytes > this.limits.maxEncodedBytes - this.encodedBytes ||
      cost.pixels > this.limits.maxPixels - this.pixels
    ) {
      return false;
    }

    this.encodedBytes += cost.encodedBytes;
    this.pixels += cost.pixels;
    return true;
  }

  usage(): PhotoDecodeBudgetUsage {
    return {
      encodedBytes: this.encodedBytes,
      pixels: this.pixels,
      maxEncodedBytes: this.limits.maxEncodedBytes,
      maxPixels: this.limits.maxPixels,
    };
  }
}

export class PhotoDecodePipelineCapacityError extends Error {
  constructor() {
    super('Photo decode pipeline capacity is exhausted');
    this.name = 'PhotoDecodePipelineCapacityError';
  }
}

export class PhotoDecodeDeadlineError extends Error {
  constructor() {
    super('Photo decode deadline exceeded');
  }
}

export class PhotoDecodePipelineGate {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout | null }> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    validatePositiveInteger(maxConcurrent, 'maxConcurrent');
    validatePositiveInteger(maxQueued, 'maxQueued');
  }

  async run<T>(operation: () => Promise<T>, deadlineAtMs = Number.MAX_SAFE_INTEGER): Promise<T> {
    await this.acquire(deadlineAtMs);
    try {
      // FLAG: A deadline may cancel waiting, never free running native capacity.
      // Native execution owns physical teardown before this operation settles.
      if (Date.now() >= deadlineAtMs) throw new PhotoDecodeDeadlineError();
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(deadlineAtMs: number): Promise<void> {
    if (Date.now() >= deadlineAtMs) throw new PhotoDecodeDeadlineError();
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new PhotoDecodePipelineCapacityError();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, timer: null as NodeJS.Timeout | null };
      if (deadlineAtMs !== Number.MAX_SAFE_INTEGER) {
        waiter.timer = setTimeout(
          () => {
            const position = this.waiters.indexOf(waiter);
            if (position >= 0) this.waiters.splice(position, 1);
            reject(new PhotoDecodeDeadlineError());
          },
          Math.max(1, Math.min(2_147_483_647, deadlineAtMs - Date.now())),
        );
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}
