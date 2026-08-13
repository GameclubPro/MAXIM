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

export function roleRunsHttp(
  role: AppRole,
  serviceName: unknown = process.env.APP_SERVICE_NAME,
): boolean {
  return (
    role === 'all' ||
    role === 'ingress' ||
    role === 'admin' ||
    (role === 'moderation' && serviceName === 'api-media-analysis')
  );
}

export function resolveHttpListenHost(
  serviceName: unknown = process.env.APP_SERVICE_NAME,
): '0.0.0.0' | '127.0.0.1' {
  return serviceName === 'api-media-analysis' ? '127.0.0.1' : '0.0.0.0';
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
