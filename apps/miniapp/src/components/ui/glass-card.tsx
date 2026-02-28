import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type GlassCardProps = HTMLAttributes<HTMLElement> & {
  as?: 'section' | 'article' | 'div';
  padding?: 'sm' | 'md' | 'lg';
  elevated?: boolean;
};

export function GlassCard({
  as = 'section',
  className,
  children,
  padding = 'md',
  elevated = false,
  ...rest
}: GlassCardProps) {
  const Tag = as;

  return (
    <Tag
      className={cn('glass-card', `glass-card--${padding}`, elevated && 'glass-card--elevated', className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
