import type { ReportJournalFilters } from '@maxim/contracts';
import { Prisma } from '../../prisma/prisma-client';

const STATUS_GROUPS = {
  ALL: [undefined],
  ACTIVE: ['COLLECTING', 'PENDING', 'RUNNING'],
  FAILED: ['FAILED', 'PARTIAL'],
  COMPLETED: ['COMPLETED', 'DISMISSED', 'EXPIRED', 'CANCELLED'],
} as const;

export function reportJournalPageQuery(
  chatId: string,
  filters: ReportJournalFilters,
  anchor?: { createdAt: Date; id: string } | null,
): Prisma.Sql {
  const branches = STATUS_GROUPS[filters.status].map((status) => {
    const predicates = [Prisma.sql`chat_id = ${chatId}`];
    if (status) predicates.push(Prisma.sql`status = ${status}`);
    if (filters.authorId) predicates.push(Prisma.sql`author_id = ${filters.authorId}`);
    if (filters.from) predicates.push(Prisma.sql`created_at >= ${new Date(filters.from)}`);
    if (filters.to) predicates.push(Prisma.sql`created_at <= ${new Date(filters.to)}`);
    if (anchor) predicates.push(Prisma.sql`(created_at, id) < (${anchor.createdAt}, ${anchor.id})`);
    return Prisma.sql`(SELECT id, created_at FROM chat_report_cases
      WHERE ${Prisma.join(predicates, ' AND ')} ORDER BY created_at DESC, id DESC LIMIT 21)`;
  });
  // FLAG: Each equality-bound index branch admits at most 21 rows; status groups never sort full history.
  return Prisma.sql`SELECT id FROM (${Prisma.join(branches, ' UNION ALL ')}) AS journal_page
    ORDER BY created_at DESC, id DESC LIMIT 21`;
}
