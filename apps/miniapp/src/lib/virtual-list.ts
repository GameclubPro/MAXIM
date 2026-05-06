export type VirtualListRange = {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
};

export function resolveVirtualListRange(options: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan?: number;
}): VirtualListRange {
  const itemCount = Math.max(0, Math.trunc(options.itemCount));
  const rowHeight = Math.max(1, Math.trunc(options.rowHeight));
  const totalHeight = itemCount * rowHeight;

  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      totalHeight: 0,
    };
  }

  const overscan = Math.max(0, Math.trunc(options.overscan ?? 0));
  const scrollTop = Math.max(0, options.scrollTop);
  const viewportHeight = Math.max(0, options.viewportHeight);
  const firstVisibleIndex = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const startIndex = Math.max(0, firstVisibleIndex - overscan);
  const endIndex = Math.min(itemCount, firstVisibleIndex + visibleCount + overscan);

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
    totalHeight,
  };
}
