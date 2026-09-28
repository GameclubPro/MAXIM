import { UnrecoverableError } from 'bullmq';
import { isMaxMemberRestoreAvailable } from '@maxim/contracts/max-capabilities';
export { MAX_MEMBER_RESTORE_RETIRES_AT } from '@maxim/contracts/max-capabilities';

// FLAG: MAX removes POST /chats/{chatId}/members on this date with no replacement.
// DELETE block=false removes a member; it is not a supported substitute for restoring one.

export class MaxMemberRestoreUnavailableError extends UnrecoverableError {
  readonly code = 'MAX_MEMBER_RESTORE_UNAVAILABLE';
  readonly preDispatch = true;

  constructor() {
    super(
      'MAX больше не поддерживает возврат участника через API. Снимите блокировку в MAX вручную, затем повторите проверку в мини-приложении.',
    );
    this.name = 'MaxMemberRestoreUnavailableError';
  }
}

export function assertMaxMemberRestoreAvailable(scheduledAt = Date.now()): void {
  if (!isMaxMemberRestoreAvailable(scheduledAt)) {
    throw new MaxMemberRestoreUnavailableError();
  }
}
