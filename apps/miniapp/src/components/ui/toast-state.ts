export function appendToast<T extends { id: number; replaceKey?: string }>(
  current: readonly T[],
  next: T,
): T[] {
  return [
    ...(next.replaceKey ? current.filter((item) => item.replaceKey !== next.replaceKey) : current),
    next,
  ];
}
