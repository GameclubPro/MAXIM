import { Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { createPrismaClient } from '../../src/prisma/prisma-client';
import { MaxActionDispatchService } from '../../src/max/max-action-dispatch.service';
import { MaxActionLedgerService } from '../../src/max/max-action-ledger.service';
import type { MaxActionJob, MaxClientService } from '../../src/max/max-client.service';
import { WebhookLegacyHoldService } from '../../src/webhook/webhook-legacy-hold.service';

export type MaxLegacyHoldCrashInput = {
  databaseUrl: string;
  redisUrl: string;
  queueName: string;
  mode: 'legacy' | 'guarded';
};

async function main(input: MaxLegacyHoldCrashInput): Promise<void> {
  // FLAG: These children use disposable localhost stores and an in-process HTTP adapter.
  // They never construct a token-bearing MAX client or contact a live destination.
  const database = new URL(input.databaseUrl);
  const cache = new URL(input.redisUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
    !database.pathname.includes('race_test') ||
    !['localhost', '127.0.0.1', '[::1]'].includes(cache.hostname)
  )
    throw new Error('Legacy hold crash worker requires disposable local stores');
  const prisma = createPrismaClient(input.databaseUrl, { max: 2 });
  await prisma.$connect();
  const redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
  const holds = new WebhookLegacyHoldService(prisma as never);
  const ledger = new MaxActionLedgerService(prisma as never, holds);
  const emit = (name: string, job: MaxActionJob) => {
    process.send?.({
      name,
      jobId: job.idempotencyKey,
      actionType: job.actionType,
      botId: job.botId,
    });
  };
  const simulatedHttp = async (job: MaxActionJob): Promise<void> => {
    emit('effect', job);
    if (input.mode === 'legacy') {
      // FLAG: Old inline DELETE could succeed without an intent/action journal. Stop
      // before any completion write; the parent must observe SIGKILL before adding holds.
      await new Promise<void>(() => {});
    }
  };
  const client = {
    executeActionJob: async (
      job: MaxActionJob,
      options: Parameters<MaxClientService['executeActionJob']>[1] = {},
    ) => {
      const guard =
        job.actionType === 'SEND_MESSAGE'
          ? options.beforeSendMutation
          : job.actionType === 'DELETE_MESSAGE'
            ? options.beforeDeleteMutation
            : options.beforeMemberMutation;
      await guard?.();
      if (job.actionType === 'SEND_MESSAGE') {
        const claim = await ledger.claimSendDispatch(job, job.botId!);
        if (claim.kind === 'recovered')
          return {
            messageId: claim.remoteMessageId,
            url: null,
            recoveredSendDispatch: { dispatchBotId: claim.dispatchBotId },
          };
        await simulatedHttp(job);
        const messageId = `fixture-send-${job.idempotencyKey}`;
        await ledger.completeSendDispatch(job, claim.dispatchToken, messageId);
        return { messageId, url: null };
      }
      await simulatedHttp(job);
    },
  };
  const dispatch = new MaxActionDispatchService(
    client as never,
    undefined,
    ledger,
    undefined,
    undefined,
    holds,
  );
  const worker = new Worker<MaxActionJob>(
    input.queueName,
    async (queueJob) => {
      const job = { ...queueJob.data, attempt: queueJob.attemptsMade + 1 };
      emit('intent', job);
      if (input.mode === 'legacy') await simulatedHttp(job);
      else await dispatch.execute(job, { enqueuedAt: new Date(queueJob.timestamp) });
    },
    {
      connection: redis as unknown as ConnectionOptions,
      concurrency: 1,
      lockDuration: 1_000,
      stalledInterval: 500,
      maxStalledCount: 1,
    },
  );
  worker.on('completed', (job) => emit('completed', job.data));
  worker.on('failed', (job, error) => {
    process.send?.({
      name: 'failed',
      jobId: job?.data.idempotencyKey,
      error: error.message,
      code: (error as { code?: string }).code,
    });
  });
  worker.on('error', (error) => process.send?.({ name: 'worker-error', error: error.message }));
  process.on('message', async (message) => {
    if (message !== 'stop') return;
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
    process.disconnect?.();
  });
  await worker.waitUntilReady();
  process.send?.({ name: 'ready', pid: process.pid });
}

process.once('message', (input: MaxLegacyHoldCrashInput) => {
  void main(input).catch((error: unknown) => {
    process.send?.({
      name: 'failure',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    process.disconnect?.();
  });
});
