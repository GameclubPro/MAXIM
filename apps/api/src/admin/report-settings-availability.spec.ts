import { ConflictException } from '@nestjs/common';
import { assertReportsActivationAvailable } from './report-settings-availability';

describe('report activation ceiling', () => {
  it('rejects a new chat opt-in while runtime execution is paused', () => {
    for (const current of [null, { reportsEnabled: false }]) {
      expect(() =>
        assertReportsActivationAvailable(current, { reportsEnabled: true }, false),
      ).toThrow(ConflictException);
    }
  });
  it('preserves disabling, editing an existing opt-in, and available activation', () => {
    expect(() =>
      assertReportsActivationAvailable({ reportsEnabled: true }, { reportsEnabled: false }, false),
    ).not.toThrow();
    expect(() =>
      assertReportsActivationAvailable({ reportsEnabled: true }, { reportsEnabled: true }, false),
    ).not.toThrow();
    expect(() =>
      assertReportsActivationAvailable({ reportsEnabled: false }, { reportsEnabled: true }, true),
    ).not.toThrow();
  });
});
