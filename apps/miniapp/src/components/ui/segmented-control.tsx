import { cn } from '../../lib/cn';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import './segmented-control.css';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
};

type SegmentedControlProps<T extends string> = {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
};

let pendingSegmentedFocus: { ariaLabel: string; value: string } | null = null;

function focusSegmentedOption(group: HTMLDivElement | null, value: string): void {
  const controls = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  controls?.forEach((control) => {
    if (control.dataset.segmentedValue === value) {
      control.focus();
    }
  });
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
  ariaLabel = 'Фильтр событий',
}: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const pendingFocus = pendingSegmentedFocus;
    if (!pendingFocus || pendingFocus.ariaLabel !== ariaLabel || pendingFocus.value !== value) {
      return;
    }

    focusSegmentedOption(groupRef.current, value);
    pendingSegmentedFocus = null;
  }, [ariaLabel, value]);

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, option: SegmentedOption<T>) => {
    const directionByKey: Record<string, -1 | 1> = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
    };
    const enabledOptions = options.filter((item) => !item.disabled);
    const currentIndex = enabledOptions.findIndex((item) => item.value === option.value);

    if (currentIndex < 0 || enabledOptions.length === 0) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = enabledOptions.length - 1;
    } else {
      const direction = directionByKey[event.key];
      if (!direction) {
        return;
      }
      nextIndex = (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
    }

    event.preventDefault();
    const nextOption = enabledOptions[nextIndex];
    if (!nextOption) {
      return;
    }

    if (nextOption.value !== value) {
      pendingSegmentedFocus = { ariaLabel, value: nextOption.value };
    }
    focusSegmentedOption(groupRef.current, nextOption.value);
    onChange(nextOption.value);
  };

  return (
    <div
      ref={groupRef}
      className={cn('segmented-control', className)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            className={cn('segmented-control__item', active && 'is-active')}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => moveSelection(event, option)}
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-segmented-value={option.value}
            disabled={option.disabled}
          >
            <span>{option.label}</span>
            {typeof option.count === 'number' ? (
              <small aria-label={`Количество: ${option.count}`}>{option.count}</small>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
