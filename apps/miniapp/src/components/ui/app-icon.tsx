import type { SVGProps } from 'react';
import { APP_LAZY_ICON_NAMES, type AppIconName } from './app-icon-names';
import { cn } from '../../lib/cn';

const iconSprite = new URL('../../assets/iconoir-ui.svg', import.meta.url).href;
const routeIconSprite = new URL('../../assets/iconoir-route.svg', import.meta.url).href;
const lazyNames = new Set<string>(APP_LAZY_ICON_NAMES);

type AppIconProps = SVGProps<SVGSVGElement> & {
  icon: AppIconName;
  variant?: 'app' | 'iconoir';
};

export function AppIcon({ icon, className, variant = 'app', ...props }: AppIconProps) {
  const library = variant === 'iconoir';
  return (
    <svg
      width={library ? '1.5em' : 24}
      height={library ? '1.5em' : 24}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={library ? (icon.endsWith('Solid') ? undefined : 1.5) : 1.8}
      xmlns={library ? 'http://www.w3.org/2000/svg' : undefined}
      color={library ? 'currentColor' : undefined}
      aria-hidden={library ? undefined : true}
      focusable={library ? undefined : 'false'}
      className={library ? className : cn('app-icon', className)}
      {...props}
    >
      <use href={`${lazyNames.has(icon) ? routeIconSprite : iconSprite}#${icon}`} />
    </svg>
  );
}
