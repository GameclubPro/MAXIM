import { ManagedBroadcastStatus, PublicationScheduleMode } from '../prisma/prisma-client';
import { selectPublicationManagedBroadcastDueBatch } from './admin-managed-broadcast-due-selection';

describe('publication managed broadcast due selection', () => {
  it('reserves recovery capacity without letting old verification rows starve new sends', async () => {
    const executionRows = Array.from({ length: 10 }, (_, index) => ({ id: `send-${index + 1}` }));
    const verificationRows = Array.from({ length: 5 }, (_, index) => ({
      id: `verify-${index + 1}`,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(executionRows)
      .mockResolvedValueOnce(verificationRows)
      .mockResolvedValueOnce([]);

    const result = await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.RECURRENCE],
      10,
    );

    expect(result.dueRows.map((row) => row.id)).toEqual([
      ...executionRows.slice(0, 8).map((row) => row.id),
      'verify-1',
      'verify-2',
    ]);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[1]?.[0]?.where.status.in).toEqual([
      ManagedBroadcastStatus.ACTIVE,
      ManagedBroadcastStatus.PARTIAL,
      ManagedBroadcastStatus.FAILED,
    ]);
  });

  it('uses the whole batch for verification when no send is due', async () => {
    const verificationRows = [{ id: 'verify-1' }, { id: 'verify-2' }, { id: 'verify-3' }];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(verificationRows)
      .mockResolvedValueOnce([]);

    const result = await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.SLOTS],
      3,
    );

    expect(result.dueRows).toEqual(verificationRows);
  });

  it('keeps the only slot for an outbound send when both lanes are due', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'send-1' }])
      .mockResolvedValueOnce([{ id: 'verify-1' }])
      .mockResolvedValueOnce([]);

    const result = await selectPublicationManagedBroadcastDueBatch(
      { managedBroadcast: { findMany } } as never,
      [PublicationScheduleMode.NOW],
      1,
    );

    expect(result.dueRows).toEqual([{ id: 'send-1' }]);
  });
});
