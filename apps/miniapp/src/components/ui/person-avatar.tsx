import { useState } from 'react';

type PersonAvatarProps = {
  avatarUrl: string | null;
  fallback: string;
  className: string;
};

export function PersonAvatar({ avatarUrl, fallback, className }: PersonAvatarProps) {
  const [imageBroken, setImageBroken] = useState(false);
  const showImage = Boolean(avatarUrl) && !imageBroken;

  return (
    <span className={`${className} ${showImage ? `${className}--image` : ''}`.trim()}>
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
        fallback
      )}
    </span>
  );
}
