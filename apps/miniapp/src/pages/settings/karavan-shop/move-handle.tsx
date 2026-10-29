import { useRef } from 'react';
export function MoveHandle({
  label,
  index,
  group,
  disabled,
  move,
}: {
  label: string;
  index: number;
  group: string;
  disabled?: boolean;
  move: (from: number, to: number) => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <button
      type="button"
      className="karavan-shop__drag"
      aria-label={`Переместить: ${label}`}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        start.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onPointerUp={(event) => {
        const origin = start.current;
        start.current = null;
        if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 8) return;
        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-sort-group]');
        const to = Number(target?.dataset.sortIndex);
        if (
          target?.dataset.sortGroup === group &&
          Number.isSafeInteger(to) &&
          to >= 0 &&
          to !== index
        )
          move(index, to);
      }}
    >
      ↕
    </button>
  );
}
