export type AppRole = 'all' | 'ingress' | 'admin' | 'enqueue' | 'moderation' | 'action';

export function getAppRole(): AppRole {
  const value = String(process.env.APP_ROLE ?? 'all').trim().toLowerCase();
  if (
    value === 'all' ||
    value === 'ingress' ||
    value === 'admin' ||
    value === 'enqueue' ||
    value === 'moderation' ||
    value === 'action'
  ) {
    return value;
  }
  return 'all';
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
