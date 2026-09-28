import {
  assertMaxMemberRestoreAvailable,
  MAX_MEMBER_RESTORE_RETIRES_AT,
  MaxMemberRestoreUnavailableError,
} from './max-member-restore-capability';

describe('MAX member restoration retirement', () => {
  it('allows only execution dates before retirement', () => {
    expect(() => assertMaxMemberRestoreAvailable(MAX_MEMBER_RESTORE_RETIRES_AT - 1)).not.toThrow();
    expect(() => assertMaxMemberRestoreAvailable(MAX_MEMBER_RESTORE_RETIRES_AT)).toThrow(
      MaxMemberRestoreUnavailableError,
    );
    expect(() => assertMaxMemberRestoreAvailable(MAX_MEMBER_RESTORE_RETIRES_AT + 1)).toThrow(
      MaxMemberRestoreUnavailableError,
    );
    expect(() => assertMaxMemberRestoreAvailable(Number.NaN)).toThrow(
      MaxMemberRestoreUnavailableError,
    );
  });
});
