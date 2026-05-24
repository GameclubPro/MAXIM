export type AppRole = 'all' | 'ingress' | 'admin' | 'enqueue' | 'moderation' | 'action';

export const APP_ROLES = [
  'all',
  'ingress',
  'admin',
  'enqueue',
  'moderation',
  'action',
] as const satisfies readonly AppRole[];

export function normalizeAppRole(value: unknown, fallback: AppRole = 'all'): AppRole {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return APP_ROLES.includes(normalized as AppRole) ? (normalized as AppRole) : fallback;
}

export function getAppRole(): AppRole {
  return normalizeAppRole(process.env.APP_ROLE);
}

export function roleRunsHttp(role: AppRole): boolean {
  return role === 'all' || role === 'ingress' || role === 'admin';
}

export function roleRunsIngress(role: AppRole): boolean {
  return role === 'all' || role === 'ingress';
}

export function roleRunsAdmin(role: AppRole): boolean {
  return role === 'all' || role === 'admin';
}

export function roleRunsEnqueue(role: AppRole): boolean {
  return role === 'all' || role === 'enqueue';
}

export function roleRunsModeration(role: AppRole): boolean {
  return role === 'all' || role === 'moderation';
}

export function roleRunsAction(role: AppRole): boolean {
  return role === 'all' || role === 'action';
}
