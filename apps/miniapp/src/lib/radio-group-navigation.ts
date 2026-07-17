export function resolveRadioGroupNavigationIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
): number | null {
  if (
    !Number.isInteger(currentIndex) ||
    !Number.isInteger(itemCount) ||
    itemCount <= 0 ||
    currentIndex < 0 ||
    currentIndex >= itemCount
  ) {
    return null;
  }

  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return itemCount - 1;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return (currentIndex - 1 + itemCount) % itemCount;
  }
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return (currentIndex + 1) % itemCount;
  }

  return null;
}
