import { selectChannelStatsMembershipBucketRows } from './stats-read-model-selectors';
import { resolveChannelStatsPartialEdgeRanges } from './stats-read-model-selectors';

function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => extractSqlText(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const sqlArg = arg as { strings?: unknown; values?: unknown };
    const parts: string[] = [];
    if (Array.isArray(sqlArg.strings)) {
      parts.push(sqlArg.strings.map((part) => String(part)).join(' '));
    }
    if (Array.isArray(sqlArg.values)) {
      parts.push(sqlArg.values.map((part) => extractSqlText(part)).join(' '));
    }
    return parts.filter(Boolean).join(' ');
  }

  return String(arg);
}

describe('stats read model selectors', () => {
  it('resolves channel stats raw edge ranges around complete hourly rollups', () => {
    const from = new Date('2026-03-01T10:15:00.000Z');
    const to = new Date('2026-03-07T12:45:00.000Z');

    const ranges = resolveChannelStatsPartialEdgeRanges(
      from,
      to,
      new Date('2026-03-01T11:00:00.000Z'),
      new Date('2026-03-07T12:00:00.000Z'),
      true,
    );

    expect(
      ranges.map((range) => ({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        toInclusive: range.toInclusive,
      })),
    ).toEqual([
      {
        from: '2026-03-01T10:15:00.000Z',
        to: '2026-03-01T11:00:00.000Z',
        toInclusive: false,
      },
      {
        from: '2026-03-07T12:00:00.000Z',
        to: '2026-03-07T12:45:00.000Z',
        toInclusive: true,
      },
    ]);
  });

  it('queries channel stats membership edges as two bounded ranges', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw: queryRaw,
    };

    await selectChannelStatsMembershipBucketRows(prisma as never, {
      chatId: 'channel-1',
      from: new Date('2026-03-01T10:15:00.000Z'),
      to: new Date('2026-03-07T12:45:00.000Z'),
      bucket: 'hour',
    });

    const sqlText = extractSqlText(queryRaw.mock.calls[0]);
    expect(sqlText).toContain('FROM chat_membership_activity_feed_items');
    expect(sqlText).toContain('event_at <');
    expect(sqlText).toContain('event_at <=');
    expect(sqlText).not.toContain('AND NOT (event_at');
  });
});
