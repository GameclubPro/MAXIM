import type { PublicModerator } from '@maxim/contracts';
const portraits = {
  maximov: new URL('../../assets/bots/maximov.webp', import.meta.url).href,
  maximova: new URL('../../assets/bots/maximova.webp', import.meta.url).href,
  rex: new URL('../../assets/bots/rex.webp', import.meta.url).href,
};
export function ModeratorPortrait({ moderator }: { moderator: PublicModerator }) {
  return (
    <span className="moderator-portrait" aria-hidden="true">
      {moderator.portrait === 'neutral' ? (
        moderator.name.slice(0, 1)
      ) : (
        <img src={portraits[moderator.portrait]} alt="" loading="lazy" decoding="async" />
      )}
    </span>
  );
}
