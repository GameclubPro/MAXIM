import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('secure media download deadline process containment', () => {
  it.each(
    ['request', 'dns', 'body', 'resolved'].flatMap((scenario) =>
      ['download', 'downloadBinary'].map((method) => ({ scenario, method })),
    ),
  )(
    'contains $scenario deadline expiry in $method and permits the next download',
    ({ scenario, method }) => {
      const child = spawnSync(
        process.execPath,
        [
          '--unhandled-rejections=strict',
          '--import',
          require.resolve('tsx'),
          join(__dirname, '../../../test/secure-photo-downloader-deadline-child.ts'),
          scenario,
          method,
        ],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 },
      );
      expect({
        status: child.status,
        signal: child.signal,
        error: child.error,
        stderr: child.stderr,
      }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
      expect(child.stdout.trim()).toBe('deadline-contained-next-download-ok');
    },
  );
});
