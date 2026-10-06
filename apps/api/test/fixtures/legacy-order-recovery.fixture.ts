import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../../src/max/max-action.queue';
import { createPrismaClient } from '../../src/prisma/prisma-client';
import {
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  inspectLegacyRecoveryCandidate,
  installAndSealLegacyRecoveryBatch,
  legacySnapshotDigest,
  type LegacyStopAttestation,
} from '../../src/webhook/webhook-legacy-cold-install';
import {
  classifyLegacyRecoveryQueues,
  isLegacyRecoveryWebhookQueue,
  LEGACY_RECOVERY_JOB_STATES,
  LEGACY_RECOVERY_MAX_QUEUE_JOBS,
  LegacyRecoveryRefusedError,
  scanLegacyRecoveryQueueCatalog,
  type LegacyQueueSnapshot,
} from '../../src/scripts/legacy-recovery-queue-inventory';

type Input = {
  version: 1;
  mode: 'preview' | 'apply';
  ownerIds: string[];
  majorBotIds: string[];
  attestation: LegacyStopAttestation;
  reviewedPreviewSha256?: string;
};
const BASE_WEBHOOK_QUEUES = [
  'moderation',
  'moderation-critical',
  'moderation-background',
  'moderation-default',
  ...Array.from({ length: 4 }, (_, index) => `moderation-join-${index}`),
  ...Array.from({ length: 16 }, (_, index) => `moderation-default-${index}`),
];
const OWNER_KEY = 'maxim:webhook-rollout:pause-owner:v1';

// FLAG: Test-only proof tooling is excluded from the runtime build and accepts only
// isolated local race stores. It is not production recovery admission.
export async function runLegacyOrderRecoveryInDisposableStores(input: Input): Promise<unknown> {
  const database = new URL(process.env.DATABASE_URL ?? '');
  const cache = new URL(process.env.REDIS_URL ?? '');
  if (
    process.env.NODE_ENV !== 'test' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
    !database.pathname.includes('race_test') ||
    !['localhost', '127.0.0.1', '[::1]'].includes(cache.hostname)
  )
    throw new Error('Legacy fixture requires isolated local race stores');
  if (
    input.version !== 1 ||
    !['preview', 'apply'].includes(input.mode) ||
    !Array.isArray(input.ownerIds) ||
    !input.ownerIds.length ||
    input.ownerIds.length > 200 ||
    new Set(input.ownerIds).size !== input.ownerIds.length ||
    input.ownerIds.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) ||
    !Array.isArray(input.majorBotIds) ||
    !input.majorBotIds.length ||
    input.majorBotIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    !/^[a-zA-Z0-9_-]{16,200}$/u.test(input.attestation?.queueFenceNonce ?? '') ||
    (input.mode === 'apply' && !/^[0-9a-f]{64}$/u.test(input.reviewedPreviewSha256 ?? ''))
  )
    throw new Error('Invalid finite legacy recovery request');
  const prisma = createPrismaClient(process.env.DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 10_000,
    application_name: 'maxim-legacy-cold-recovery',
    options: '-c timezone=UTC',
  });
  if (!process.env.REDIS_URL) throw new Error('Legacy recovery requires Redis authority');
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 3_000,
    commandTimeout: 10_000,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  const preparationDeadline = Date.now() + 60_000;
  const assertBudget = () => {
    if (Date.now() >= preparationDeadline) throw new Error('Legacy preparation deadline exceeded');
  };
  const queues = new Map<string, Queue>();
  let refusalCode = 'store_access_unavailable';
  const getQueue = (name: string) => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: {
          url: process.env.REDIS_URL,
          maxRetriesPerRequest: 0,
          connectTimeout: 3_000,
          commandTimeout: 10_000,
          retryStrategy: () => null,
        },
        skipMetasUpdate: true,
      });
      queue.on('error', () => undefined);
      queues.set(name, queue);
    }
    return queue;
  };
  const assertFence = async () => {
    assertBudget();
    if ((await redis.get(OWNER_KEY)) !== `rollout:${input.attestation.queueFenceNonce}`)
      throw new Error('Legacy queue fence ownership lost');
    for (const name of BASE_WEBHOOK_QUEUES)
      if (!(await getQueue(name).isPaused()))
        throw new Error('Legacy webhook queue fence incomplete');
  };
  const inventory = async (): Promise<LegacyQueueSnapshot[]> => {
    const names = new Set([...BASE_WEBHOOK_QUEUES, ...MAX_ACTION_ALL_QUEUE_NAMES]);
    let cursor = '0';
    let scans = 0;
    do {
      assertBudget();
      if (++scans > 1_000) throw new Error('Legacy queue catalog review budget exceeded');
      const [next, keys] = await scanLegacyRecoveryQueueCatalog(redis, cursor);
      cursor = next;
      for (const key of keys) {
        const match = /^bull:([^:]+):(.+)$/u.exec(key);
        const name = match?.[1];
        if (
          !name ||
          /:(?:wait|active|delayed|prioritized|waiting-children|paused|meta|stalled|id|events)$/u.test(
            match?.[2] ?? '',
          )
        )
          throw new Error('Unreviewed Bull queue namespace');
        names.add(name);
      }
      if (names.size > 256) throw new Error('Legacy queue catalog exceeds finite review budget');
    } while (cursor !== '0');
    const result: LegacyQueueSnapshot[] = [];
    let total = 0;
    let payloadBytes = 0;
    for (const name of [...names].sort()) {
      assertBudget();
      const queue = getQueue(name);
      if (
        ![...BASE_WEBHOOK_QUEUES, ...MAX_ACTION_ALL_QUEUE_NAMES].includes(name) &&
        !(await redis.exists(queue.toKey('meta')))
      )
        throw new Error('Unreviewed Bull queue namespace');
      if (isLegacyRecoveryWebhookQueue(name)) {
        if (!(await queue.isPaused())) throw new Error('Dynamic webhook queue fence incomplete');
        continue;
      }
      const counts = await queue.getJobCounts(...LEGACY_RECOVERY_JOB_STATES);
      const count = Object.values(counts).reduce((sum, value) => sum + value, 0);
      total += count;
      if (!Number.isSafeInteger(count) || count < 0 || total > LEGACY_RECOVERY_MAX_QUEUE_JOBS)
        throw new Error('Legacy child queue exceeds finite review budget');
      const jobIds = await queue.getRanges(
        [...LEGACY_RECOVERY_JOB_STATES],
        0,
        LEGACY_RECOVERY_MAX_QUEUE_JOBS,
      );
      if (jobIds.length !== count) throw new Error('Incomplete legacy queue inventory');
      const jobs = [];
      for (const id of jobIds.sort()) {
        assertBudget();
        if (!/^[^:\s]{1,512}$/u.test(id)) throw new Error('Invalid legacy queue child identity');
        const key = queue.toKey(id);
        // Bound bytes before HGET; getJobs()/getJob() would load arbitrary retained
        // metadata and payload sizes before the cold client can enforce its budget.
        const bytes = await redis.hstrlen(key, 'data');
        payloadBytes += bytes;
        if (bytes < 1 || bytes > 64 * 1024 || payloadBytes > 8 * 1024 * 1024)
          throw new LegacyRecoveryRefusedError(
            'queue_inventory_unproved',
            'Legacy child payload review budget exceeded',
          );
        const raw = await redis.hget(key, 'data');
        if (!raw || Buffer.byteLength(raw) !== bytes)
          throw new Error('Legacy child payload changed');
        jobs.push({ id, data: JSON.parse(raw) as unknown });
      }
      result.push({ name, count, jobs });
    }
    return result;
  };
  try {
    await redis.connect();
    await prisma.$connect();
    refusalCode = 'queue_fence_unproved';
    await assertFence();
    refusalCode = 'owner_proof_incomplete';
    const candidates = [];
    for (const ownerId of [...input.ownerIds].sort()) {
      assertBudget();
      const candidate = await inspectLegacyRecoveryCandidate(prisma, ownerId, input.majorBotIds);
      if (!candidate) throw new Error('Selected legacy source lacks complete cold-recovery proof');
      candidates.push(candidate);
    }
    refusalCode = 'queue_inventory_unproved';
    const firstInventory = await inventory();
    const children = classifyLegacyRecoveryQueues(candidates, firstInventory);
    const previewSha256 = buildLegacyRecoveryPreviewDigest(candidates, children);
    refusalCode = 'queue_fence_unproved';
    await assertFence();
    refusalCode = 'queue_inventory_unproved';
    if (legacySnapshotDigest(firstInventory) !== legacySnapshotDigest(await inventory()))
      throw new Error('Legacy child queue inventory changed');
    if (input.mode === 'preview')
      return {
        version: 1,
        applied: false,
        previewSha256,
        recoveries: candidates.length,
        children: children.length,
        heldMembers: new Set(candidates.map((row) => `${row.source.chatId}:${row.source.userId}`))
          .size,
      };
    refusalCode = 'reviewed_preview_changed';
    if (previewSha256 !== input.reviewedPreviewSha256)
      throw new Error('Reviewed legacy preview changed');
    refusalCode = 'queue_fence_unproved';
    await assertFence();
    refusalCode = 'cold_install_unproved';
    input.attestation.previewSha256 = previewSha256;
    const certificate = await createLegacyColdCertificate(prisma, input.attestation);
    refusalCode = 'queue_fence_unproved';
    await assertFence();
    refusalCode = 'cold_install_unproved';
    // FLAG: Installation and its exact seal commit together. A crash can leave an
    // empty certificate, never an installed production batch that cannot be retried.
    const installed = await installAndSealLegacyRecoveryBatch(
      prisma,
      certificate.id,
      candidates,
      children,
    );
    return {
      version: 1,
      applied: true,
      certificateId: certificate.id,
      previewSha256,
      ...installed,
    };
  } catch (error) {
    // FLAG: Preserve only a static stage/code; store and payload error text stays private.
    if (error instanceof LegacyRecoveryRefusedError) throw error;
    throw new LegacyRecoveryRefusedError(refusalCode, 'Legacy proof was refused');
  } finally {
    await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
    redis.disconnect();
    await prisma.$disconnect();
  }
}
