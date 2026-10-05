import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createMultibotHarness } from '../webhook/webhook-multibot-fullpath.spec-support';
import { ModerationDeleteIntentStatus } from '../prisma/prisma-client';

type Profile = 'uniform' | 'hot' | 'cold' | 'media';
const profilesAllowed = new Set<Profile>(['uniform', 'hot', 'cold', 'media']);
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z]+)=(.+)$/u.exec(arg);
    if (!match)
      throw new Error(
        'Use --chats=10000,12000,30000 --bots=9 --messages=120 --rate=2 --profiles=uniform,hot,cold,media --output=path',
      );
    return [match[1]!, match[2]!];
  }),
);
for (const key of Object.keys(args))
  if (!['chats', 'bots', 'messages', 'rate', 'profiles', 'output'].includes(key))
    throw new Error(`Unknown option ${key}`);
function positive(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error(`${name} must be a positive integer`);
  return result;
}
const catalogs = (args.chats ?? '10000,12000,30000')
  .split(',')
  .map((value) => positive(value, 'chats'));
const bots = positive(args.bots ?? '9', 'bots');
const messageCount = positive(args.messages ?? '120', 'messages');
const rate = positive(args.rate ?? '2', 'rate');
const profiles = (args.profiles ?? 'uniform,hot,cold,media').split(',') as Profile[];
if (profiles.some((profile) => !profilesAllowed.has(profile)))
  throw new Error('Unsupported profile');
const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error(
    'Run through scripts/agent/with-test-stores.mjs --migrate; local disposable stores are required',
  );
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reports: unknown[] = [];
const pendingActionStatuses = [
  ModerationDeleteIntentStatus.PENDING,
  ModerationDeleteIntentStatus.IN_PROGRESS,
  ModerationDeleteIntentStatus.RETRYABLE,
  ModerationDeleteIntentStatus.WAITING_CAPABILITY,
  ModerationDeleteIntentStatus.AMBIGUOUS,
];

async function main() {
  for (const catalog of catalogs) {
    const harness = await createMultibotHarness({
      databaseUrl: databaseUrl!,
      redisUrl: redisUrl!,
      bots,
      mode: 'on',
      quotaProfile: 'production',
      recoverDueDeletes: true,
    });
    let failureSnapshot: ((error: unknown) => Promise<unknown>) | undefined;
    try {
      const seededAt = performance.now();
      const chats = await harness.seedCatalog(catalog);
      const seedMs = performance.now() - seededAt;
      for (const profile of profiles) {
        const caseId = `load-${randomUUID()}`;
        const beforeEffects = harness.effects.length;
        const beforeRequests = harness.requests.length;
        const beforeViolations = await harness.prisma.violation.count({
          where: { chatId: { in: chats } },
        });
        const receiptIds: string[] = [];
        const messageIds: string[] = [];
        const ingressLatencyMs: number[] = [];
        let producing = true;
        let peakPendingReceipts = 0;
        let peakOldestReceiptAgeMs = 0;
        let peakPendingActions = 0;
        let peakOldestActionAgeMs = 0;
        let pumpError: unknown;
        const startedAt = performance.now();
        let productionFinishedAt = startedAt;
        failureSnapshot = async (error) => ({
          status: 'failed',
          catalog,
          bots,
          profile,
          failureCode:
            error instanceof Error && error.name === 'MaxApiInternalRateLimitError'
              ? 'internal_quota'
              : 'benchmark_failed',
          logicalMessagesSubmitted: messageIds.length,
          receipts: receiptIds.length,
          requestedLogicalRatePerSec: rate,
          elapsedMs: Math.round(performance.now() - startedAt),
          pendingReceipts: await harness.prisma.webhookEvent.count({
            where: { id: { in: receiptIds }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
          }),
          pendingActions: await harness.prisma.moderationDeleteIntent.count({
            where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
          }),
          remoteDeletes: harness.effects
            .slice(beforeEffects)
            .filter((effect) => effect.method === 'delete').length,
        });
        const pump = (async () => {
          try {
            while (producing) {
              await harness.pumpOnce();
              await wait(10);
            }
            await harness.drain(60_000);
          } catch (error) {
            pumpError = error;
          }
        })();
        try {
          for (let index = 0; index < messageCount; index += 1) {
            if (pumpError) throw pumpError;
            const chatId =
              chats[
                profile === 'hot'
                  ? index % Math.min(4, chats.length)
                  : Math.floor((index * chats.length) / messageCount) % chats.length
              ]!;
            if (profile === 'cold') {
              harness.links.forgetChatBotBinding(chatId);
              await harness.cache.invalidate(chatId);
              await harness.prisma.chatBotMembership.updateMany({
                where: { chatId },
                data: {
                  botAccessCheckedAt: new Date(Date.now() - 6 * 60_000),
                  botAccessExpiresAt: new Date(Date.now() - 1_000),
                },
              });
            }
            const messageId = `${caseId}-${index}`;
            messageIds.push(messageId);
            const at = Date.now();
            const enteredAt = performance.now();
            const mirrors = await Promise.all(
              harness.bots.map((bot) =>
                harness.ingest({
                  chatId,
                  messageId,
                  botId: bot.id,
                  at,
                  text: `Local catalog length violation ${caseId} ${index}`,
                  ...(profile === 'media'
                    ? {
                        attachments: [
                          {
                            type: 'image',
                            payload: {
                              url: 'https://max-harness.invalid/photo.jpg',
                              photo_id: messageId,
                            },
                          },
                        ],
                      }
                    : {}),
                }),
              ),
            );
            receiptIds.push(...mirrors);
            ingressLatencyMs.push(performance.now() - enteredAt);
            if (index % 10 === 0) {
              const pendingWhere = {
                id: { in: receiptIds },
                status: {
                  in: ['RECEIVED', 'QUEUED', 'FAILED'] as Array<'RECEIVED' | 'QUEUED' | 'FAILED'>,
                },
              };
              const [pending, oldest, pendingActions, oldestAction] = await Promise.all([
                harness.prisma.webhookEvent.count({ where: pendingWhere }),
                harness.prisma.webhookEvent.findFirst({
                  where: pendingWhere,
                  orderBy: { createdAt: 'asc' },
                  select: { createdAt: true },
                }),
                harness.prisma.moderationDeleteIntent.count({
                  where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
                }),
                harness.prisma.moderationDeleteIntent.findFirst({
                  where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
                  orderBy: { createdAt: 'asc' },
                  select: { createdAt: true },
                }),
              ]);
              peakPendingReceipts = Math.max(peakPendingReceipts, pending);
              peakOldestReceiptAgeMs = Math.max(
                peakOldestReceiptAgeMs,
                oldest ? Date.now() - oldest.createdAt.getTime() : 0,
              );
              peakPendingActions = Math.max(peakPendingActions, pendingActions);
              peakOldestActionAgeMs = Math.max(
                peakOldestActionAgeMs,
                oldestAction ? Date.now() - oldestAction.createdAt.getTime() : 0,
              );
            }
            await wait(Math.max(0, startedAt + ((index + 1) * 1000) / rate - performance.now()));
          }
        } finally {
          productionFinishedAt = performance.now();
          producing = false;
          await pump;
        }
        if (pumpError) throw pumpError;
        const finishedAt = performance.now();
        const elapsedMs = finishedAt - startedAt;
        const owned = await harness.prisma.webhookExecutionClaim.count({
          where: { kind: 'EXECUTION', webhookEventId: { in: receiptIds }, status: 'COMPLETED' },
        });
        const violations =
          (await harness.prisma.violation.count({ where: { chatId: { in: chats } } })) -
          beforeViolations;
        const intents = await harness.prisma.moderationDeleteIntent.count({
          where: { messageId: { in: messageIds } },
        });
        const deletes = harness.effects
          .slice(beforeEffects)
          .filter((effect) => effect.method === 'delete' && effect.path === '/messages');
        const finalPendingReceipts = await harness.prisma.webhookEvent.count({
          where: { id: { in: receiptIds }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
        });
        const successfulIntents = await harness.prisma.moderationDeleteIntent.count({
          where: { messageId: { in: messageIds }, status: ModerationDeleteIntentStatus.SUCCEEDED },
        });
        const violationClaims = await harness.prisma.moderationViolationMessageClaim.findMany({
          where: {
            chatId: { in: chats },
            messageId: { in: messageIds },
            ruleCode: 'MESSAGE_TOO_LONG',
          },
          select: { messageId: true },
          take: messageCount + 1,
        });
        const violationClaimIds = new Set(violationClaims.map((claim) => claim.messageId));
        const finalPendingActions = await harness.prisma.moderationDeleteIntent.count({
          where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
        });
        const completions = await harness.prisma.webhookEvent.findMany({
          where: { id: { in: receiptIds }, status: 'PROCESSED' },
          select: { createdAt: true, processedAt: true },
        });
        const completionLatencyMs = completions
          .map((event) =>
            Math.max(0, (event.processedAt?.getTime() ?? Date.now()) - event.createdAt.getTime()),
          )
          .sort((a, b) => a - b);
        const completedActions = await harness.prisma.moderationDeleteIntent.findMany({
          where: { messageId: { in: messageIds }, status: ModerationDeleteIntentStatus.SUCCEEDED },
          select: { createdAt: true, completedAt: true },
        });
        const actionLatencyMs = completedActions
          .map((intent) =>
            Math.max(0, (intent.completedAt?.getTime() ?? Date.now()) - intent.createdAt.getTime()),
          )
          .sort((a, b) => a - b);
        if (
          finalPendingReceipts ||
          finalPendingActions ||
          successfulIntents !== messageCount ||
          violationClaims.length !== messageCount ||
          violationClaimIds.size !== messageCount ||
          messageIds.some((id) => !violationClaimIds.has(id)) ||
          owned !== messageCount ||
          violations !== messageCount ||
          intents !== messageCount ||
          deletes.length !== messageCount ||
          new Set(deletes.map((effect) => effect.messageId)).size !== messageCount
        ) {
          throw new Error(
            `Logical authority/effect mismatch: messages=${messageCount}, claims=${owned}, violations=${violations}, violationClaims=${violationClaims.length}, uniqueViolationClaims=${violationClaimIds.size}, intents=${intents}, successfulIntents=${successfulIntents}, deletes=${deletes.length}, pendingReceipts=${finalPendingReceipts}, pendingActions=${finalPendingActions}`,
          );
        }
        ingressLatencyMs.sort((a, b) => a - b);
        const report = {
          status: 'passed',
          catalog,
          bots,
          profile,
          logicalMessages: messageCount,
          receipts: receiptIds.length,
          executorDistribution:
            'all chats share one healthy primary; other configured bots are reserves',
          quotas: {
            perTokenRps: 30,
            perBotChatRps: 5,
            managedRefreshRps: 2,
            perTargetMutationRps: 2,
          },
          requestedLogicalRatePerSec: rate,
          requestedReceiptRatePerSec: rate * bots,
          elapsedMs: Math.round(elapsedMs),
          submissionElapsedMs: Math.round(productionFinishedAt - startedAt),
          drainMs: Math.round(finishedAt - productionFinishedAt),
          observedLogicalRatePerSec: Number(((messageCount * 1000) / elapsedMs).toFixed(2)),
          seedMs: Math.round(seedMs),
          ingressP95Ms: Math.round(
            ingressLatencyMs[Math.floor(ingressLatencyMs.length * 0.95)] ?? 0,
          ),
          completionP95Ms: completionLatencyMs[Math.floor(completionLatencyMs.length * 0.95)] ?? 0,
          actionP95Ms: actionLatencyMs[Math.floor(actionLatencyMs.length * 0.95)] ?? 0,
          sampledPeakPendingReceipts: peakPendingReceipts,
          sampledPeakOldestReceiptAgeMs: peakOldestReceiptAgeMs,
          sampledPeakPendingActions: peakPendingActions,
          sampledPeakOldestActionAgeMs: peakOldestActionAgeMs,
          backlogSampling: 'every 10 logical ingress messages; drain peaks excluded',
          finalPendingReceipts,
          finalPendingActions,
          maxRequests: harness.requests.length - beforeRequests,
          claims: owned,
          violations,
          intents,
          successfulIntents,
          uniqueViolationMessageClaims: violationClaimIds.size,
          remoteDeletes: deletes.length,
          mediaScope:
            profile === 'media'
              ? 'attachment ingress and text/length rules; native IMAGE/OCR capacity excluded'
              : null,
        };
        reports.push(report);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        await saveReports();
        failureSnapshot = undefined;
      }
    } catch (error) {
      const failed = failureSnapshot
        ? await failureSnapshot(error).catch(() => ({
            status: 'failed',
            catalog,
            failureCode: 'snapshot_unavailable',
          }))
        : { status: 'failed', catalog, failureCode: 'catalog_initialization_failed' };
      reports.push(failed);
      process.stdout.write(`${JSON.stringify(failed)}\n`);
      await saveReports();
      throw error;
    } finally {
      await harness.dispose();
    }
  }
}

async function saveReports() {
  const result = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    hardware: {
      platform: process.platform,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    transport: 'local simulated MAX with production quota defaults; no external requests',
    fixtureTopology: {
      physicalWebhookQueues: 1,
      physicalDeleteQueues: 1,
      webhookWorkerConcurrency: 4,
      deleteWorkerConcurrency: 4,
      deleteDueSweepIntervalMs: 1000,
      defaultShardNames: 16,
    },
    quotaServiceLanes: { criticalRps: 13, interactiveRps: 10, backgroundRps: 7 },
    scope:
      'finite synthetic local profiles, not a production capacity certificate or 24-hour sustained-load acceptance',
    reports,
  };
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
