import { NestFactory } from '@nestjs/core';
import { createHash, randomUUID } from 'node:crypto';
import { readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { FixedModeratorPreservationService } from '../max/fixed-moderator-preservation.service';
import { PrismaService } from '../prisma/prisma.service';
import { FixedModeratorPreservationModule } from './fixed-moderator-preservation.module';

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u);
const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const entrySchema = z
  .object({
    chatId: ID,
    botId: ID,
    routingVersion: z.number().int().min(0).max(2_147_483_646),
    observedAt: z.string().datetime(),
    digest: DIGEST,
    eligible: z.literal(true),
    reason: z.literal('eligible'),
    receiptCount: z.number().int().min(1).max(320),
    operationId: z.string().uuid(),
  })
  .strict();
const planSchema = z
  .object({
    protocol: z.literal('PRESERVE_EXISTING_MODERATOR_V1'),
    sourceSha: SHA,
    createdAt: z.string().datetime(),
    after: ID.nullable(),
    nextAfter: ID.nullable(),
    exhausted: z.boolean(),
    scanned: z.number().int().min(0).max(100),
    skipped: z.record(z.string().max(32), z.number().int().min(0).max(100)),
    entries: z.array(entrySchema).max(100),
  })
  .strict();

export function moderatorPreservationPlanDigest(plan: z.infer<typeof planSchema>): string {
  return createHash('sha256')
    .update(JSON.stringify(planSchema.parse(plan)))
    .digest('hex');
}

function readPlan() {
  const buffer = Buffer.alloc(256 * 1024 + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(0, buffer, size, buffer.length - size, null);
    if (!count) break;
    size += count;
  }
  if (size === buffer.length) throw new Error('Preservation plan exceeds 256 KiB');
  return planSchema.parse(JSON.parse(buffer.subarray(0, size).toString('utf8')));
}

async function main() {
  const hardDeadline = Number(process.env.MAXIM_FIXED_MODERATOR_PRESERVATION_DEADLINE);
  if (
    process.env.NODE_ENV === 'production' &&
    (!Number.isFinite(hardDeadline) ||
      hardDeadline <= Date.now() ||
      hardDeadline - Date.now() > 80_000)
  )
    throw new Error('Bounded operator deadline required');
  const watchdog = Number.isFinite(hardDeadline)
    ? setTimeout(() => process.exit(2), Math.max(1, hardDeadline - Date.now()))
    : null;
  watchdog?.unref();

  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'explain-chat': { type: 'string' },
      'source-sha': { type: 'string' },
      'reviewed-digest': { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string', default: '25' },
    },
  });
  const explainChat = values['explain-chat'] ? ID.parse(values['explain-chat']) : null;
  if (explainChat && values.apply) throw new Error('Explain cannot apply assignments');
  const sourceSha = SHA.parse(values['source-sha']);
  const limit = z.coerce.number().int().min(1).max(100).parse(values.limit);
  const after = values.after ? ID.parse(values.after) : null;
  if (process.env.NODE_ENV === 'production' && process.env.APP_SERVICE_NAME !== 'api-admin')
    throw new Error('Run only inside the attested api-admin container');
  if (values.apply && process.env.MAXIM_FIXED_MODERATOR_PRESERVATION_SOURCE !== sourceSha)
    throw new Error('Apply requires the fleet-attested operator wrapper');
  const plan = values.apply ? readPlan() : null;
  if (
    plan &&
    (plan.sourceSha !== sourceSha ||
      moderatorPreservationPlanDigest(plan) !== DIGEST.parse(values['reviewed-digest']))
  )
    throw new Error('Reviewed preservation plan identity differs');
  const app = await NestFactory.createApplicationContext(FixedModeratorPreservationModule, {
    logger: false,
  });
  const prisma = app.get(PrismaService);
  const service = app.get(FixedModeratorPreservationService);
  const deadline = Math.min(
    Date.now() + 60_000,
    Number.isFinite(hardDeadline) ? hardDeadline - 8_000 : Infinity,
  );
  try {
    if (explainChat) {
      process.stdout.write(JSON.stringify(await service.explain(explainChat)) + '\n');
      return;
    }
    if (plan) {
      for (const entry of plan.entries) {
        if (Date.now() >= deadline)
          throw new Error('Preservation deadline; resume identical reviewed plan');
        const result = await service.preserve(entry);
        process.stdout.write(
          JSON.stringify({
            operationId: result.id,
            chatId: result.chatId,
            botId: result.botId,
            routingVersion: result.routingVersion,
            status: 'applied',
          }) + '\n',
        );
      }
      return;
    }
    const rows = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
        return tx.chat.findMany({
          where: after ? { id: { gt: after } } : {},
          orderBy: { id: 'asc' },
          take: limit + 1,
          select: { id: true },
        });
      },
      { timeout: 3000 },
    );
    const entries: z.infer<typeof entrySchema>[] = [];
    const skipped: Record<string, number> = {};
    let scanned = 0;
    let nextAfter = after;
    for (const row of rows.slice(0, limit)) {
      if (Date.now() >= deadline) break;
      const preview = await service.preview(row.id);
      scanned += 1;
      nextAfter = row.id;
      if (preview.eligible)
        entries.push(entrySchema.parse({ ...preview, operationId: randomUUID() }));
      else skipped[preview.reason] = (skipped[preview.reason] ?? 0) + 1;
    }
    const result = planSchema.parse({
      protocol: 'PRESERVE_EXISTING_MODERATOR_V1',
      sourceSha,
      createdAt: new Date().toISOString(),
      after,
      nextAfter,
      exhausted: rows.length <= limit && scanned === rows.length,
      scanned,
      skipped,
      entries,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.stderr.write(`reviewed_digest=${moderatorPreservationPlanDigest(result)}\n`);
  } finally {
    await app.close();
    if (watchdog) clearTimeout(watchdog);
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    // No raw query, configuration or credential-bearing error is printed by this operator command.
    process.stderr.write(
      `${error instanceof Error ? error.name : 'Error'}: preservation refused; inspect the bounded command stage\n`,
    );
    process.exitCode = 1;
  });
