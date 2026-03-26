import { useMemo, useState, type CSSProperties } from 'react';
import { cn } from '../../lib/cn';

type EntityAvatarProps = {
  title: string;
  entityType: 'chat' | 'channel';
  className?: string;
  avatarUrl?: string | null;
};

const ENTITY_AVATAR_PALETTES = {
  chat: [
    ['#4c94ff', '#275fdd', 'rgba(39, 95, 221, 0.22)'],
    ['#20b7aa', '#117e87', 'rgba(17, 126, 135, 0.2)'],
    ['#f2a14d', '#d86a2c', 'rgba(216, 106, 44, 0.2)'],
    ['#6a8cff', '#4b55dd', 'rgba(75, 85, 221, 0.2)'],
  ],
  channel: [
    ['#5166ff', '#2d3fd5', 'rgba(45, 63, 213, 0.22)'],
    ['#7d56f6', '#5c2fd6', 'rgba(92, 47, 214, 0.22)'],
    ['#ff7c8d', '#e05268', 'rgba(224, 82, 104, 0.2)'],
    ['#2cbf8f', '#168766', 'rgba(22, 135, 102, 0.2)'],
  ],
} as const;

function getEntityInitials(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    return '?';
  }

  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length === 1) {
    return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  }

  return `${Array.from(words[0])[0] ?? ''}${Array.from(words[1])[0] ?? ''}`.toUpperCase();
}

function getEntityAvatarPalette(title: string, entityType: EntityAvatarProps['entityType']) {
  const palettes = ENTITY_AVATAR_PALETTES[entityType];
  let hash = entityType === 'channel' ? 17 : 7;

  for (const char of title) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }

  return palettes[hash % palettes.length] ?? palettes[0];
}

export function EntityAvatar({
  title,
  entityType,
  className,
  avatarUrl = null,
}: EntityAvatarProps) {
  const [imageBroken, setImageBroken] = useState(false);
  const initials = useMemo(() => getEntityInitials(title), [title]);
  const palette = useMemo(() => getEntityAvatarPalette(title, entityType), [entityType, title]);
  const showImage = Boolean(avatarUrl) && !imageBroken;
  const style = useMemo(
    () =>
      ({
        '--entity-avatar-start': palette[0],
        '--entity-avatar-end': palette[1],
        '--entity-avatar-shadow': palette[2],
      }) as CSSProperties,
    [palette],
  );

  return (
    <span
      className={cn('entity-avatar', className, showImage && 'is-image')}
      style={style}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={avatarUrl ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageBroken(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
