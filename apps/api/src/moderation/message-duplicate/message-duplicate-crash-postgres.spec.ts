import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { createPrismaClient } from '../../prisma/prisma-client';
import {
  createDuplicateCrashFixture,
  type CrashInput,
  type CrashStage,
} from '../../../test/fixtures/message-duplicate-crash-fixture';
import type { MessageDuplicateBinding } from './message-duplicate-state';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const fixturePath = resolve(__dirname, '../../../test/fixtures/message-duplicate-crash-worker.ts');
type Checkpoint = {
  name: string;
  binding: MessageDuplicateBinding;
  qualified: number;
  intentId: string;
  admission: { admittedAtMs: number };
  error?: string;
};

function trackedChild(child: ChildProcess) {
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('error', (error) => {
      output += error.message;
      done({ code: 1, signal: null });
    });
    child.once('close', (code, signal) => done({ code, signal }));
  });
  return {
    child,
    closed,
    output: () => output,
    async kill() {
      // FLAG: Signal only the private process group created by this fixture.
      if (child.pid && child.exitCode === null && child.signalCode === null)
        process.kill(-child.pid, 'SIGKILL');
      return closed;
    },
  };
}

async function openOwnedRedis() {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-duplicate-crash-'));
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
  const url = `redis://127.0.0.1:${port}`;
  let server: ReturnType<typeof trackedChild> | undefined;
  let client: Redis | undefined;
  const start = async () => {
    server = trackedChild(
      spawn(
        process.env.MAXIM_TEST_REDIS_SERVER || 'redis-server',
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--dir',
          directory,
          '--dbfilename',
          'dump.rdb',
          '--save',
          '',
          '--appendonly',
          'no',
          '--protected-mode',
          'yes',
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.child.exitCode !== null || server.child.signalCode !== null)
        throw new Error(`Owned Redis exited: ${server.output()}`);
      const probe = new Redis(url, {
        lazyConnect: true,
        retryStrategy: () => null,
        maxRetriesPerRequest: 0,
      });
      probe.on('error', () => undefined);
      try {
        await probe.connect();
        const identity = await probe.info('server');
        if (!identity.split(/\r?\n/u).includes(`process_id:${server.child.pid}`))
          throw new Error('Redis ownership mismatch');
        client = probe;
        return;
      } catch {
        // A refused connection with retries disabled is already closed. Calling
        // disconnect again arms ioredis's two-second fallback after its close event.
        if (probe.status !== 'end') probe.disconnect();
      }
      await delay(50);
    }
    throw new Error(`Owned Redis startup timed out: ${server.output()}`);
  };
  const close = async () => {
    client?.disconnect();
    await server?.kill();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await start();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    url,
    async snapshot() {
      // FLAG: SAVE and process termination target only this test's verified child;
      // neither the CI shared Redis nor any inherited REDIS_URL is modified.
      await client!.save();
      await copyFile(join(directory, 'dump.rdb'), join(directory, 'checkpoint.rdb'));
      expect((await stat(join(directory, 'checkpoint.rdb'))).size).toBeGreaterThan(0);
      return { size: await client!.dbsize(), identity: await client!.info('server') };
    },
    async restore(snapshot: { size: number; identity: string }) {
      client!.disconnect();
      expect((await server!.kill()).signal).toBe('SIGKILL');
      await copyFile(join(directory, 'checkpoint.rdb'), join(directory, 'dump.rdb'));
      await start();
      expect(await client!.dbsize()).toBe(snapshot.size);
      const runId = (info: string) => info.match(/^run_id:(.+)$/mu)?.[1];
      expect(runId(await client!.info('server'))).not.toBe(runId(snapshot.identity));
    },
    close,
  };
}

function startWorker(input: CrashInput, stage: CrashStage) {
  const tracked = trackedChild(
    fork(fixturePath, [], {
      cwd: resolve(__dirname, '../../..'),
      execArgv: ['--import', require.resolve('tsx')],
      detached: true,
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }),
  );
  const pending: Checkpoint[] = [];
  let notify: (() => void) | undefined;
  tracked.child.on('message', (message: Checkpoint) => {
    pending.push(message);
    notify?.();
  });
  tracked.closed.then(() => notify?.());
  tracked.child.send({ ...input, stage });
  return {
    ...tracked,
    resume: () => tracked.child.send('continue'),
    async checkpoint(name: string): Promise<Checkpoint> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const next = pending.shift();
        if (next) {
          if (next.name === 'failure') throw new Error(next.error);
          expect(next.name).toBe(name);
          return next;
        }
        if (tracked.child.exitCode !== null || tracked.child.signalCode !== null)
          throw new Error(`Worker exited before ${name}: ${tracked.output()}`);
        await new Promise<void>((done) => {
          const timer = setTimeout(() => {
            notify = undefined;
            done();
          }, 100);
          notify = () => {
            clearTimeout(timer);
            notify = undefined;
            done();
          };
        });
      }
      throw new Error(`Worker checkpoint ${name} timed out: ${tracked.output()}`);
    },
  };
}

// Scope: crash committed service boundaries and replay a consistent older Redis RDB.
// PostgreSQL remains live; completion means ordering/intent handoff, not a remote DELETE.
(databaseUrl ? describe : describe.skip)(
  'duplicate worker SIGKILL and complete Redis RDB restore',
  () => {
    beforeAll(() => {
      const parsed = new URL(databaseUrl);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
        !parsed.pathname.includes('race_test')
      )
        throw new Error('Crash acceptance requires a disposable local race_test database');
    });

    it.each(['admission', 'revocation', 'qualification', 'intent', 'completion'] as const)(
      'preserves authority and durable ownership after interruption at %s',
      async (stage) => {
        const redis = await openOwnedRedis();
        const input = {
          redisUrl: redis.url,
          chatId: `-${randomBytes(6).readUIntBE(0, 6)}`,
          eventTimestampMs: Date.now() - 2000,
        };
        const prisma = createPrismaClient(databaseUrl, { max: 2 });
        let worker: ReturnType<typeof startWorker> | undefined;
        let recovered: ReturnType<typeof createDuplicateCrashFixture> | undefined;
        try {
          await prisma.chat.create({
            data: {
              id: input.chatId,
              title: 'Owned process crash fixture',
              settings: {
                create: {
                  antiDuplicateEnabled: true,
                  duplicateDetectionPreset: 'STANDARD',
                  duplicateCompareMode: 'TEXT',
                  duplicateWarnMaxCount: 1,
                  duplicateWarnEnabled: false,
                  duplicateMuteEnabled: false,
                  duplicateBanEnabled: false,
                },
              },
            },
          });
          const emptySnapshot = await redis.snapshot();
          worker = startWorker(input, stage);
          let checkpoint: Checkpoint;
          let snapshot = emptySnapshot;
          let intentId: string | undefined;
          if (stage === 'admission') checkpoint = await worker.checkpoint('admission');
          else if (stage === 'revocation') {
            checkpoint = await worker.checkpoint('positive');
            snapshot = await redis.snapshot();
            worker.resume();
            await worker.checkpoint('revocation');
          } else if (stage === 'qualification') {
            checkpoint = await worker.checkpoint('qualification');
            snapshot = await redis.snapshot();
          } else {
            checkpoint = await worker.checkpoint('before-intent');
            snapshot = await redis.snapshot();
            worker.resume();
            await worker.checkpoint(stage);
            intentId = (
              await prisma.moderationDeleteIntent.findUniqueOrThrow({
                where: { chatId_messageId: { chatId: input.chatId, messageId: 'duplicate' } },
              })
            ).id;
          }
          expect((await worker.kill()).signal).toBe('SIGKILL');
          await redis.restore(snapshot);
          recovered = createDuplicateCrashFixture(input);
          const admission = await recovered.admission.register({
            chatId: input.chatId,
            messageId: 'duplicate',
            jobId: recovered.identity.jobId,
          });
          expect(admission.registration).toBe('retry');
          if (stage === 'admission') {
            expect(admission.admittedAtMs).toBe(checkpoint.admission.admittedAtMs);
            expect(
              await recovered.ordering.announce(recovered.identity, true, admission.registration),
            ).toMatchObject({
              kind: 'registered',
              actionEligible: false,
              deadlineAtMs: recovered.identity.deadlineAtMs,
            });
            expect(await recovered.ordering.readActionEligibility(recovered.identity)).toBe(false);
            expect(
              await prisma.moderationDeleteIntent.count({ where: { chatId: input.chatId } }),
            ).toBe(0);
            return;
          }
          const { binding, qualified } = checkpoint;
          if (stage !== 'revocation') expect(qualified).toBe(1);
          expect(binding.authorization!.deadlineAtMs).toBe(recovered.identity.deadlineAtMs);
          expect(await recovered.ordering.readActionEligibility(recovered.identity)).toBe(true);
          if (stage === 'revocation') {
            expect(await recovered.authorization.isAllowed(input.chatId, binding)).toBe(false);
            await expect(recovered.guard.qualify(recovered.target(binding))).rejects.toMatchObject({
              code: 'message_duplicate_action_revoked',
            });
            await expect(
              recovered.guard.assertMessageStillActionable(recovered.target(binding)),
            ).rejects.toMatchObject({ code: 'message_duplicate_action_revoked' });
            expect(recovered.remoteReads()).toBe(0);
            return;
          }
          expect(await recovered.authorization.isAllowed(input.chatId, binding)).toBe(true);
          expect(await recovered.guard.qualify(recovered.target(binding))).toBe(qualified);
          expect(await recovered.history.qualified(input.chatId, binding)).toBe(qualified);
          const originalOwner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
            where: { dedupeKey: recovered.claim.dedupeKey },
          });
          if (stage === 'qualification') {
            expect(
              await recovered.intents.claimMessageActionBeforeQualification(
                recovered.claim,
                binding,
              ),
            ).toBe('resumed');
            const obligation = await prisma.messageDuplicateClaimCleanup.findUniqueOrThrow({
              where: { claimId: originalOwner.id },
            });
            expect(obligation.deadlineAt.getTime()).toBe(binding.authorization!.deadlineAtMs);
            expect(
              await recovered.intents.releaseUnmaterializedMessageAction({
                claim: recovered.claim,
                binding,
              }),
            ).toBe(true);
            expect(await recovered.authorization.isAllowed(input.chatId, binding)).toBe(false);
            expect(
              await recovered.intents.claimMessageActionBeforeQualification(
                recovered.claim,
                binding,
              ),
            ).toBe('blocked');
            return;
          }
          let resumedCalls = 0;
          const result = await recovered.ordering.runInOrder(recovered.identity, true, async () => {
            resumedCalls++;
            const handoff = await recovered!.handoff(binding);
            expect(handoff.intent?.intentId).toBe(intentId);
            return handoff;
          });
          expect(result.kind).toBe('completed');
          expect(resumedCalls).toBe(1);
          await recovered.ordering.runInOrder(recovered.identity, true, async () => {
            resumedCalls++;
          });
          expect(resumedCalls).toBe(1);
          expect(
            await prisma.moderationDeleteIntent.count({ where: { chatId: input.chatId } }),
          ).toBe(1);
          expect(await prisma.moderationDeleteIntentReason.count({ where: { intentId } })).toBe(1);
          expect(
            await prisma.messageDuplicateClaimCleanup.count({
              where: { claimId: originalOwner.id },
            }),
          ).toBe(0);
          expect(
            await recovered.intents.releaseUnmaterializedMessageAction({
              claim: recovered.claim,
              binding,
            }),
          ).toBe(false);
          const finalOwner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
            where: { dedupeKey: recovered.claim.dedupeKey },
          });
          expect(finalOwner.id).toBe(originalOwner.id);
          expect(finalOwner.messageActionKey).toBe(recovered.claim.messageActionKey);
        } finally {
          await worker?.kill();
          await recovered?.close();
          await prisma.chat.deleteMany({ where: { id: input.chatId } });
          await prisma.$disconnect();
          await redis.close();
        }
      },
      60_000,
    );
  },
);
