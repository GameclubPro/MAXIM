import {
  publicationPostActionsInitialData,
  publicationPostActionsRetryData,
} from './publication-post-actions';

describe('publication post-action snapshots', () => {
  it('keeps old publications outside the indexed recovery scan', () => {
    expect(publicationPostActionsInitialData(undefined, new Date())).toEqual({
      pinStatus: 'NONE',
      deleteStatus: 'NONE',
      postActionsNextAt: null,
    });
  });

  it('arms both actions without anchoring the deletion deadline to the schedule', () => {
    const scheduledAt = new Date('2030-01-01T12:00:00Z');
    expect(
      publicationPostActionsInitialData({ pin: 'notify', deleteAfterMinutes: 60 }, scheduledAt),
    ).toEqual({
      pinStatus: 'PENDING',
      deleteStatus: 'PENDING',
      postActionsNextAt: scheduledAt,
    });
  });

  it('clears old pending actions when latest-content retry disables them', () => {
    expect(publicationPostActionsRetryData({ pin: 'none', deleteAfterMinutes: null })).toEqual({
      pinStatus: 'NONE',
      deleteStatus: 'NONE',
      postActionsNextAt: null,
      postActionsToken: null,
      pinAttemptCount: 0,
      pinError: null,
      deleteAttemptCount: 0,
      deleteAt: null,
      deletedAt: null,
      deleteError: null,
    });
  });
});
