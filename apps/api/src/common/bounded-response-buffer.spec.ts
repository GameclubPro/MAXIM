import {
  EmptyResponseBodyError,
  readBoundedResponseBuffer,
  ResponseByteLimitExceededError,
} from './bounded-response-buffer';

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const cancel = jest.fn();
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else controller.close();
      },
      cancel,
    }),
    { headers },
  );
  return { response, cancel };
}

describe('readBoundedResponseBuffer', () => {
  it('uses one owned final buffer for a correctly declared multi-chunk body', async () => {
    const first = new Uint8Array([1, 2]);
    const { response } = streamedResponse([first, new Uint8Array([3, 4])], {
      'content-length': '4',
    });
    const allocate = jest.spyOn(Buffer, 'allocUnsafeSlow');
    try {
      const bytes = await readBoundedResponseBuffer(response, 4);
      expect(bytes).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(allocate).toHaveBeenCalledTimes(1);
      expect(bytes.buffer.byteLength).toBe(4);
      first.fill(9);
      expect(bytes[0]).toBe(1);
      expect(response.body!.locked).toBe(false);
    } finally {
      allocate.mockRestore();
    }
  });

  it.each<Record<string, string>>([{}, { 'content-length': '1' }, { 'content-length': 'broken' }])(
    'enforces actual bytes for missing, short and invalid lengths: %j',
    async (headers) => {
      const { response, cancel } = streamedResponse(
        [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])],
        headers,
      );
      await expect(readBoundedResponseBuffer(response, 3)).rejects.toBeInstanceOf(
        ResponseByteLimitExceededError,
      );
      expect(cancel).toHaveBeenCalled();
      expect(response.body!.locked).toBe(false);
    },
  );

  it('checks a single oversized chunk before allocating an owned copy', async () => {
    const { response } = streamedResponse([new Uint8Array(5)]);
    const from = jest.spyOn(Buffer, 'from');
    const allocate = jest.spyOn(Buffer, 'allocUnsafeSlow');
    try {
      await expect(readBoundedResponseBuffer(response, 4)).rejects.toBeInstanceOf(
        ResponseByteLimitExceededError,
      );
      expect(from).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
      allocate.mockRestore();
    }
  });

  it.each<Record<string, string>>([{}, { 'content-length': '1' }])(
    'coalesces thousands of tiny chunks into bounded owned blocks with headers %j',
    async (headers) => {
      const size = 64 * 1_024 + 17;
      const expected = Buffer.alloc(size);
      for (let index = 0; index < size; index++) expected[index] = index % 251;
      let cursor = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (cursor === size) controller.close();
            else controller.enqueue(Uint8Array.of(cursor++ % 251));
          },
        }),
        { headers },
      );
      const allocate = jest.spyOn(Buffer, 'allocUnsafeSlow');
      try {
        const bytes = await readBoundedResponseBuffer(response, size);
        expect(bytes).toEqual(expected);
        expect(bytes.buffer.byteLength).toBe(size);
        const ownedBlocks = allocate.mock.results
          .filter((result) => result.type === 'return' && result.value !== bytes)
          .map((result) => result.value as Buffer);
        expect(ownedBlocks.length).toBeLessThanOrEqual(3);
        expect(
          ownedBlocks.reduce((sum, block) => sum + block.buffer.byteLength, 0),
        ).toBeLessThanOrEqual(size);
        expect(allocate.mock.calls.length).toBeLessThanOrEqual(4);
        expect(response.body!.locked).toBe(false);
      } finally {
        allocate.mockRestore();
      }
    },
  );

  it('fills the unused false-header allocation before adding bounded overflow blocks', async () => {
    const limit = 200 * 1_024;
    const first = new Uint8Array(1_024).fill(1);
    const second = new Uint8Array(160 * 1_024).fill(2);
    const { response } = streamedResponse([first, second], {
      'content-length': String(150 * 1_024),
    });
    const allocate = jest.spyOn(Buffer, 'allocUnsafeSlow');
    try {
      const bytes = await readBoundedResponseBuffer(response, limit);
      expect(bytes.length).toBe(first.length + second.length);
      expect(bytes.subarray(0, first.length).every((value) => value === 1)).toBe(true);
      expect(bytes.subarray(first.length).every((value) => value === 2)).toBe(true);
      expect(bytes.buffer.byteLength).toBe(bytes.length);
      const ownedBlocks = allocate.mock.results
        .filter((result) => result.type === 'return' && result.value !== bytes)
        .map((result) => result.value as Buffer);
      expect(ownedBlocks.length).toBe(2);
      expect(
        ownedBlocks.reduce((sum, block) => sum + block.buffer.byteLength, 0),
      ).toBeLessThanOrEqual(limit);
      first.fill(9);
      second.fill(9);
      expect(bytes[0]).toBe(1);
      expect(bytes[first.length]).toBe(2);
    } finally {
      allocate.mockRestore();
    }
  });

  it('does not truncate an allowed body when the header underreports its size', async () => {
    const { response } = streamedResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])], {
      'content-length': '2',
    });
    await expect(readBoundedResponseBuffer(response, 4)).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it('returns exact-sized storage for a false long header', async () => {
    const { response } = streamedResponse([new Uint8Array([1, 2])], {
      'content-length': '10000',
    });
    const bytes = await readBoundedResponseBuffer(response, 10000);
    expect(bytes).toEqual(Buffer.from([1, 2]));
    expect(bytes.buffer.byteLength).toBe(2);
  });

  it.each([8_192, 1_048_576])(
    'owns exact shrink storage independently of Buffer.poolSize %s',
    async (poolSize) => {
      const originalPoolSize = Buffer.poolSize;
      try {
        Buffer.poolSize = poolSize;
        const { response } = streamedResponse([new Uint8Array([1, 2])], {
          'content-length': '10000',
        });
        const bytes = await readBoundedResponseBuffer(response, 10000);
        expect(Array.from(bytes)).toEqual([1, 2]);
        expect(bytes.byteOffset).toBe(0);
        expect(bytes.buffer.byteLength).toBe(2);
      } finally {
        Buffer.poolSize = originalPoolSize;
      }
    },
  );

  it('does not trust compressed Content-Length as decoded allocation or size', async () => {
    const { response } = streamedResponse([new Uint8Array([1, 2, 3, 4])], {
      'content-length': '10000',
      'content-encoding': 'gzip',
    });
    await expect(readBoundedResponseBuffer(response, 4)).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it('cancels an oversized declared body before any allocation', async () => {
    const { response, cancel } = streamedResponse([new Uint8Array([1])], {
      'content-length': '5',
    });
    await expect(readBoundedResponseBuffer(response, 4)).rejects.toBeInstanceOf(
      ResponseByteLimitExceededError,
    );
    expect(cancel).toHaveBeenCalled();
    expect(response.body!.locked).toBe(false);
  });

  it('cancels an outstanding read on abort and releases ownership', async () => {
    const cancel = jest.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const reason = new Error('download deadline');
    const result = readBoundedResponseBuffer(response, 4, controller.signal);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(response.body!.locked).toBe(false);
  });

  it('cancels after collecting tiny chunks without allocating a final result on abort', async () => {
    let announceStalled!: () => void;
    const stalled = new Promise<void>((resolve) => {
      announceStalled = resolve;
    });
    let chunks = 0;
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks < 100) controller.enqueue(Uint8Array.of(chunks++));
          else announceStalled();
        },
        cancel,
      }),
    );
    const controller = new AbortController();
    const reason = new Error('download aborted after partial body');
    const allocate = jest.spyOn(Buffer, 'allocUnsafeSlow');
    try {
      const result = readBoundedResponseBuffer(response, 1_000, controller.signal);
      const rejection = expect(result).rejects.toBe(reason);
      await stalled;
      controller.abort(reason);
      await rejection;
      expect(cancel).toHaveBeenCalledWith(reason);
      expect(allocate).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
    } finally {
      allocate.mockRestore();
    }
  });

  it('releases the stream lock on transport failure', async () => {
    const reason = new Error('transport failed');
    const response = new Response(
      new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) }),
    );
    await expect(readBoundedResponseBuffer(response, 4)).rejects.toBe(reason);
    expect(response.body!.locked).toBe(false);
  });

  it.each([new Response(null), new Response(new Uint8Array())])(
    'rejects empty content without arrayBuffer fallback',
    async (response) => {
      await expect(readBoundedResponseBuffer(response, 4)).rejects.toBeInstanceOf(
        EmptyResponseBodyError,
      );
    },
  );
});
