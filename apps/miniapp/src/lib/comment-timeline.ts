export function isSameCommentDay(first: string, second: string): boolean {
  const a = new Date(first);
  const b = new Date(second);
  return (
    Number.isFinite(a.getTime()) &&
    Number.isFinite(b.getTime()) &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatCommentDay(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (isSameCommentDay(value, now.toISOString())) return 'Сегодня';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCommentDay(value, yesterday.toISOString())) return 'Вчера';
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}
