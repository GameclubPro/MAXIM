import type { SVGProps } from 'react';
import iconSprite from '../../assets/iconoir-ui.svg?url';
import type { AppIconName } from './app-icon-names';
import { cn } from '../../lib/cn';

type AppIconProps = SVGProps<SVGSVGElement> & {
  icon: AppIconName;
};

export function AppIcon({ icon, className, ...props }: AppIconProps) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.8}
      aria-hidden
      focusable="false"
      className={cn('app-icon', className)}
      {...props}
    >
      <use href={`${iconSprite}#${icon}`} />
    </svg>
  );
}
