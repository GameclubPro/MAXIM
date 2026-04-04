import { cn } from '../../lib/cn';

type SpinnerProps = {
  className?: string;
  label?: string | null;
  size?: 'sm' | 'md' | 'lg';
};

export function Spinner({ className, label = 'Загрузка', size = 'md' }: SpinnerProps) {
  const accessibilityProps = label
    ? ({
        role: 'status',
        'aria-label': label,
      } as const)
    : ({
        'aria-hidden': true,
      } as const);

  return <span className={cn('spinner', `spinner--${size}`, className)} {...accessibilityProps} />;
}
