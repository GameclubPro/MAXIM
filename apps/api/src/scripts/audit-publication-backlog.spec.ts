import {
  readPublicationBacklogOptions,
  runPublicationBacklogAudit,
} from './audit-publication-backlog';

const args = ['--since', '2026-09-01T00:00:00Z', '--until', '2026-09-28T00:00:00Z'];

describe('bounded publication backlog review', () => {
  it('requires a bounded window and never accepts mutation flags', () => {
    expect(() => readPublicationBacklogOptions([])).toThrow();
    expect(() => readPublicationBacklogOptions([...args, '--apply'])).toThrow();
    expect(() => readPublicationBacklogOptions([...args, '--limit', '33'])).toThrow();
    expect(() =>
      readPublicationBacklogOptions([...args, '--status', 'SCHEDULED', '--verify-exact']),
    ).toThrow();
  });

  it('keeps missing receipts and exact absence unresolved, uses the recorded bot and returns checkpoints', async () => {
    const deliveries = [
      {
        id: 'd1',
        status: 'AMBIGUOUS',
        targetChatId: 'chat',
        botId: 'original',
        remoteMessageId: 'message',
        attemptCount: 1,
      },
      {
        id: 'd2',
        status: 'AMBIGUOUS',
        targetChatId: 'chat',
        botId: 'original',
        remoteMessageId: null,
        attemptCount: 1,
      },
    ];
    const row = {
      id: 'o1',
      publicationId: 'p1',
      scheduledAt: new Date('2026-09-02T00:00:00Z'),
      dispatchBlockerCode: null,
      schedule: { mode: 'ONCE' },
      deliveries,
    };
    const prisma = {
      publicationOccurrence: { findMany: jest.fn().mockResolvedValue([row, { ...row, id: 'o2' }]) },
    };
    const max = { getExactMessagePresence: jest.fn().mockResolvedValue('absent') };
    const options = readPublicationBacklogOptions([...args, '--limit', '1', '--verify-exact']);
    const first = await runPublicationBacklogAudit(prisma as never, max, options);
    expect(first.readOnly).toBe(true);
    expect(first.cases[0]!.deliveries.map((d) => d.outcome)).toEqual(['unresolved', 'unresolved']);
    expect(first.cases[0]!.deliveries.map((d) => d.evidence)).toEqual([
      'exact_absent_unresolved',
      'attempted_without_receipt',
    ]);
    expect(max.getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(max.getExactMessagePresence).toHaveBeenCalledWith(
      'chat',
      'message',
      expect.objectContaining({ botId: 'original' }),
    );
    const next = readPublicationBacklogOptions([...args, '--after', first.nextAfter!]);
    expect(next.after).toEqual({ scheduledAt: row.scheduledAt, id: 'o1' });
    await runPublicationBacklogAudit(prisma as never, max, options);
    expect(prisma.publicationOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
  });
});
