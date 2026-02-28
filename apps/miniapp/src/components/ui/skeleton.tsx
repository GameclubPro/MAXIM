import { cn } from '../../lib/cn';

type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className }: SkeletonProps) {
  return <span className={cn('skeleton', className)} aria-hidden />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-card" aria-hidden>
      <Skeleton className="skeleton-card__title" />
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} className="skeleton-card__line" />
      ))}
    </div>
  );
}
