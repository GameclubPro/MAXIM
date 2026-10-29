import type { MiniappSessionService } from './miniapp-session.service';

export const MINIAPP_SESSION_AUTHORITY = Symbol('MINIAPP_SESSION_AUTHORITY');
export type MiniappSessionAuthority = Pick<MiniappSessionService, 'isPrincipalActive'>;
