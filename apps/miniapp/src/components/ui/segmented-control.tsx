import { cn } from '../../lib/cn';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

type SegmentedControlProps<T extends string> = {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
};

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn('segmented-control', className)} role="tablist" aria-label="Фильтр событий">
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            className={cn('segmented-control__item', active && 'is-active')}
            onClick={() => onChange(option.value)}
            role="tab"
            aria-selected={active}
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
