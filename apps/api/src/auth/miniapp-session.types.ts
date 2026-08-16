import type { AuthUser } from '../common/decorators/current-user.decorator';

export type MiniappSessionRecord = {
  version: 1;
  createdAt: number;
  expiresAt: number;
  csrfToken: string;
  user: AuthUser;
};

export type ResolvedMiniappSession = {
  keyHash: string;
  record: MiniappSessionRecord;
};

export type MiniappAuthContext =
  | {
      source: 'init_data';
      principalKey: string;
    }
  | {
      source: 'session';
      principalKey: string;
      session: ResolvedMiniappSession;
    };

export function isSameMiniappPrincipal(left: AuthUser, right: AuthUser): boolean {
  return left.userId === right.userId && (left.launchBotId ?? null) === (right.launchBotId ?? null);
}
