import { NestFactory } from '@nestjs/core';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import { PublicationOccurrenceStatus, type Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

type Options = {
  status: 'AMBIGUOUS' | 'FAILED' | 'SCHEDULED';
  since: Date;
  until: Date;
  limit: number;
  after: { scheduledAt: Date; id: string } | null;
  verifyExact: boolean;
};

export function readPublicationBacklogOptions(args: string[]): Options {
  const values = new Map<string, string>();
  let verifyExact = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (name === '--verify-exact') {
      verifyExact = true;
      continue;
    }
    if (
      !['--status', '--since', '--until', '--limit', '--after'].includes(name) ||
      values.has(name) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith('--')
    )
      throw new Error(`Invalid option: ${name}`);
    values.set(name, args[++index]!);
  }
  const status = values.get('--status') ?? 'AMBIGUOUS';
  const since = new Date(values.get('--since') ?? '');
  const until = new Date(values.get('--until') ?? '');
  const limit = Number(values.get('--limit') ?? 20);
  if (
    !['AMBIGUOUS', 'FAILED', 'SCHEDULED'].includes(status) ||
    !Number.isFinite(since.getTime()) ||
    !Number.isFinite(until.getTime()) ||
    since > until ||
    until.getTime() - since.getTime() > 90 * 86400_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 32
  ) {
    throw new Error(
      'Use --status AMBIGUOUS|FAILED|SCHEDULED --since ISO --until ISO (at most 90 days) --limit 1..32',
    );
  }
  const cursor = values.get('--after');
  let after: Options['after'] = null;
  if (cursor) {
    const [timestamp, id, extra] = cursor.split(',');
    const scheduledAt = new Date(timestamp!);
    if (
      !id ||
      extra ||
      !Number.isFinite(scheduledAt.getTime()) ||
      scheduledAt < since ||
      scheduledAt > until
    )
      throw new Error('--after must be an in-window ISO,occurrence-id checkpoint');
    after = { scheduledAt, id };
  }
  if (verifyExact && status === 'SCHEDULED')
    throw new Error('Scheduled preview never performs MAX calls');
  return { status: status as Options['status'], since, until, limit, after, verifyExact };
}

export async function runPublicationBacklogAudit(
  prisma: Pick<PrismaService, 'publicationOccurrence'>,
  max: Pick<MaxClientService, 'getExactMessagePresence'>,
  options: Options,
) {
  const cursor: Prisma.PublicationOccurrenceWhereInput = options.after
    ? {
        OR: [
          { scheduledAt: { gt: options.after.scheduledAt } },
          { scheduledAt: options.after.scheduledAt, id: { gt: options.after.id } },
        ],
      }
    : {};
  const rows = await prisma.publicationOccurrence.findMany({
    where: {
      dispatchProfile: 'PUBLIK_V1',
      status: PublicationOccurrenceStatus[options.status],
      scheduledAt: { gte: options.since, lte: options.until },
      AND: [cursor],
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: options.limit + 1,
    select: {
      id: true,
      publicationId: true,
      scheduledAt: true,
      dispatchBlockerCode: true,
      schedule: { select: { mode: true } },
      deliveries: {
        take: 9,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          targetChatId: true,
          botId: true,
          remoteMessageId: true,
          attemptCount: true,
        },
      },
    },
  });
  const deadline = Date.now() + 60_000;
  const cases = [];
  for (const row of rows.slice(0, options.limit)) {
    const deliveries = [];
    for (const delivery of row.deliveries.slice(0, 8)) {
      let evidence = delivery.remoteMessageId
        ? 'recorded_remote_id'
        : delivery.attemptCount > 0
          ? 'attempted_without_receipt'
          : 'no_attempt_evidence';
      if (
        options.verifyExact &&
        delivery.remoteMessageId &&
        delivery.botId &&
        Date.now() < deadline
      ) {
        try {
          const presence = await max.getExactMessagePresence(
            delivery.targetChatId,
            delivery.remoteMessageId,
            {
              botId: delivery.botId,
              bypassCache: true,
              trafficClass: 'background',
              sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
              timeoutMs: 5_000,
            },
          );
          evidence = presence === 'present' ? 'exact_present' : 'exact_absent_unresolved';
        } catch {
          evidence = 'lookup_unavailable';
        }
      }
      // FLAG: This report never authorizes replay. Even exact absence now cannot
      // prove that the original send did not occur, and a missing receipt proves less.
      deliveries.push({
        deliveryId: delivery.id,
        status: delivery.status,
        evidence,
        outcome: evidence === 'exact_present' ? 'present_awaiting_review' : 'unresolved',
      });
    }
    cases.push({
      occurrenceId: row.id,
      publicationId: row.publicationId,
      scheduledAt: row.scheduledAt.toISOString(),
      blockerCode: row.dispatchBlockerCode,
      missedWindowAction:
        options.status === 'SCHEDULED' &&
        row.schedule.mode !== 'NOW' &&
        row.scheduledAt.getTime() < Date.now() - 5 * 60_000
          ? row.schedule.mode === 'RECURRENCE'
            ? 'skip'
            : 'author_decision'
          : null,
      deliveries,
      deliveriesTruncated: row.deliveries.length > 8,
    });
  }
  const last = cases.at(-1);
  return {
    readOnly: true,
    status: options.status,
    selected: cases.length,
    nextAfter:
      rows.length > options.limit && last ? `${last.scheduledAt},${last.occurrenceId}` : null,
    verificationBudgetExhausted: Date.now() >= deadline,
    cases,
  };
}

async function main() {
  const options = readPublicationBacklogOptions(process.argv.slice(2));
  const [{ PublicationDeliveryVerificationAuditModule }, { PrismaService }, { MaxClientService }] =
    await Promise.all([
      import('./publication-delivery-verification-audit.module'),
      import('../prisma/prisma.service'),
      import('../max/max-client.service'),
    ]);
  const app = await NestFactory.createApplicationContext(
    PublicationDeliveryVerificationAuditModule,
  );
  try {
    process.stdout.write(
      `${JSON.stringify(await runPublicationBacklogAudit(app.get(PrismaService), app.get(MaxClientService), options), null, 2)}\n`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      'Publication backlog audit failed; no delivery was changed. Check arguments and scoped service access.\n',
    );
    process.exitCode = 1;
  });
