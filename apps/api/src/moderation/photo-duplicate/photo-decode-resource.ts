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

export class PhotoDecodePipelineGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    validatePositiveInteger(maxConcurrent, 'maxConcurrent');
    validatePositiveInteger(maxQueued, 'maxQueued');
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // Keep the slot until sharp actually settles. AbortSignal/Promise.race cannot stop native work.
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new PhotoDecodePipelineCapacityError();
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
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
