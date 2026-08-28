import { once } from 'node:events';

const rawRate = process.argv[2] ?? '';
if (!/^[1-9][0-9]*$/u.test(rawRate)) {
  console.error('Rate limit must be a positive integer number of bytes per second.');
  process.exit(2);
}

const bytesPerSecond = Number(rawRate);
if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond > 1_073_741_824) {
  console.error('Rate limit must not exceed 1073741824 bytes per second.');
  process.exit(2);
}

const startedAt = process.hrtime.bigint();
let emittedBytes = 0n;

for await (const chunk of process.stdin) {
  emittedBytes += BigInt(chunk.length);
  const targetElapsedNs = (emittedBytes * 1_000_000_000n) / BigInt(bytesPerSecond);
  const remainingNs = startedAt + targetElapsedNs - process.hrtime.bigint();
  if (remainingNs > 0n) {
    await new Promise((resolve) => setTimeout(resolve, Number(remainingNs / 1_000_000n)));
  }
  if (!process.stdout.write(chunk)) {
    await once(process.stdout, 'drain');
  }
}
