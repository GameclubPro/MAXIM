import type { ChatSanctionItem } from '@maxim/contracts';

export function createSanctionClock(
  serverTime: string | undefined,
  receivedAt: number,
  wallNow: number,
  monotonicNow: number,
) {
  const serverAt = serverTime ? Date.parse(serverTime) : wallNow;
  return {
    serverAt: serverAt + (receivedAt > 0 ? Math.max(0, wallNow - receivedAt) : 0),
    monotonicAt: monotonicNow,
  };
}

export function readSanctionClock(
  clock: ReturnType<typeof createSanctionClock>,
  monotonicNow: number,
): number {
  return clock.serverAt + Math.max(0, monotonicNow - clock.monotonicAt);
}

export const SANCTION_STATUS_LABELS: Record<ChatSanctionItem['status'], string> = {
  active: 'Действует',
  expired: 'Срок истёк',
  released: 'Снято',
  replaced: 'Заменено',
  review: 'Требует проверки',
};

export function formatSanctionRemaining(
  item: Pick<ChatSanctionItem, 'status' | 'permanent' | 'expiresAt'>,
  nowMs: number,
): string {
  if (item.status !== 'active') return SANCTION_STATUS_LABELS[item.status];
  if (item.permanent) return 'Бессрочно';
  const expires = item.expiresAt ? Date.parse(item.expiresAt) : NaN;
  if (!Number.isFinite(expires)) return 'Срок неизвестен';
  const seconds = Math.max(0, Math.ceil((expires - nowMs) / 1000));
  if (seconds === 0) return 'Срок истёк';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3600) % 24;
  if (days > 0) return `${days} д ${String(hours).padStart(2, '0')} ч`;
  return [hours, Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

export function sanctionTimeProgress(
  item: Pick<ChatSanctionItem, 'createdAt' | 'expiresAt' | 'permanent' | 'status'>,
  nowMs: number,
): number | null {
  if (item.permanent || item.status !== 'active' || !item.expiresAt) return null;
  const start = Date.parse(item.createdAt);
  const end = Date.parse(item.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(0, Math.min(1, (end - nowMs) / (end - start)));
}
