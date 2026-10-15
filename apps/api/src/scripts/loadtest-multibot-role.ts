import { performance } from 'node:perf_hooks';
import {
  createMultibotHarness,
  type MultibotHarnessOptions,
} from '../webhook/webhook-multibot-fullpath.spec-support';
import type { SplitRoleReport } from '../webhook/webhook-multibot-split.spec-support';

if (!process.send) throw new Error('This local fixture role requires its IPC parent');
let harness: Awaited<ReturnType<typeof createMultibotHarness>> | undefined;
let options: MultibotHarnessOptions | undefined;
let stopping = false;
let loop: Promise<void> | undefined;
let starting = false;
let failed = false;
const startedAt = performance.now();
const send = (message: unknown) =>
  new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('Fixture parent disconnected'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
const fail = (error: unknown) => {
  failed = true;
  stopping = true;
  process.stderr.write(
    `Split fixture failed after ${Math.round(performance.now() - startedAt)} ms: ${String(error)}\n`,
  );
  void send({ kind: 'failed' }).catch(() => undefined);
};

process.on(
  'message',
  (message: { command?: string; id?: string; options?: MultibotHarnessOptions }) => {
    void (async () => {
      if (message.command === 'start') {
        if (starting || !message.options?.split || message.options.split.role === 'api-ingress')
          throw new Error('Invalid fixture start');
        starting = true;
        options = message.options;
        harness = await createMultibotHarness(options);
        loop = (async () => {
          while (!stopping) {
            await harness!.pumpWork();
            await new Promise((resolve) =>
              setTimeout(resolve, options!.split!.role === 'api-enqueue' ? 10 : 100),
            );
          }
        })();
        loop.catch(fail);
        await send({ kind: 'ready' });
      } else if (message.command === 'report' && harness && options?.split) {
        const report: SplitRoleReport = {
          role: options.split.role,
          pid: process.pid,
          sqlPoolMax: harness.capacity.sqlPoolMax,
          effects: harness.effects,
          requests: harness.requests,
          processedQueues: Object.fromEntries(harness.processedQueues),
          cpu: process.cpuUsage(),
          maxRssKiB: process.resourceUsage().maxRSS,
          failed: failed || !!harness.failures.length,
        };
        await send({ kind: 'reply', id: message.id, report });
      } else if (message.command === 'stop' && harness) {
        stopping = true;
        await loop;
        await harness.dispose();
        await send({ kind: 'reply', id: message.id });
        process.disconnect();
      } else throw new Error('Unknown fixture command or uninitialized role');
    })().catch(fail);
  },
);
// Parent loss must never leave local workers consuming after the test owner exits.
process.on('disconnect', () => process.exit(stopping ? 0 : 1));
