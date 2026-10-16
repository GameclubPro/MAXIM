import assert from 'node:assert/strict';
import { request as requestHttp } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ConfigService } from '@nestjs/config';
import {
  PhotoDownloadTimeoutError,
  SecurePhotoDownloader,
} from '../src/moderation/photo-duplicate/secure-photo-downloader';

const scenario = process.argv[2];
const method = parseMethod(process.argv[3]);
assert.ok(['request', 'dns', 'body', 'resolved'].includes(scenario));

function parseMethod(value: string | undefined): 'download' | 'downloadBinary' {
  assert.ok(value === 'download' || value === 'downloadBinary');
  return value;
}
let now = Date.now();
Date.now = () => now;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const address = { address: '93.184.216.34', family: 4 as const };

class DeadlineDownloader extends SecurePhotoDownloader {
  fail = true;
  aborted = 0;
  closed = 0;
  protected override async resolveHost() {
    if (this.fail && scenario === 'dns') {
      now += 1_001;
      await nextTurn();
      throw new Error('late DNS failure');
    }
    return [address];
  }

  protected override async request(
    _url: URL,
    _resolved: typeof address,
    _timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (this.fail && scenario === 'request') {
      // Real Node request cancellation, with DNS intentionally unresolved: no network traffic.
      const pending = new Promise<never>((_resolve, reject) => {
        const request = requestHttp({ host: 'fixture.invalid', lookup: () => {}, signal });
        request.once('error', (error) => {
          assert.equal((error as NodeJS.ErrnoException).code, 'ABORT_ERR');
          this.aborted += 1;
          reject(error);
        });
        request.end();
      });
      now += 1_001;
      return pending;
    }
    const failBody = this.fail && scenario === 'body';
    if (this.fail && scenario === 'resolved') now += 1_001;
    return {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: (async function* () {
        if (failBody) {
          now += 1_001;
          await nextTurn();
          throw new Error('late body failure');
        }
        yield png;
      })(),
      close: () => {
        this.closed += 1;
      },
    };
  }
}

async function main() {
  const downloader = new DeadlineDownloader({
    get: (key: string) => (key === 'PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS' ? 1_000 : undefined),
  } as ConfigService);
  await assert.rejects(downloader[method]('https://i.oneme.ru/image'), PhotoDownloadTimeoutError);
  // No unhandledRejection/uncaughtException handler: strict Node must remain alive itself.
  await nextTurn();
  await nextTurn();
  if (scenario === 'request') assert.equal(downloader.aborted, 1);
  if (scenario === 'body') assert.equal(downloader.closed, 1);
  downloader.fail = false;
  const next = await downloader[method]('https://i.oneme.ru/next');
  assert.deepEqual(next.bytes, png);
  console.log('deadline-contained-next-download-ok');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
