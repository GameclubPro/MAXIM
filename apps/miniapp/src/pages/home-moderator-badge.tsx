import type { MouseEventHandler } from 'react';
import type { PublicModerator } from '@maxim/contracts';
import { ModeratorPortrait } from '../components/ui/moderator-portrait';
export default function HomeModeratorBadge({
  moderator,
  canChoose,
  title,
  expanded,
  onClick,
}: {
  moderator: PublicModerator;
  canChoose: boolean;
  title: string;
  expanded: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  const content = (
    <>
      <ModeratorPortrait moderator={moderator} />
      <span>{moderator.name}</span>
    </>
  );
  return canChoose ? (
    <button
      type="button"
      className="chat-card__moderator-control"
      aria-label={`Бот сообщества ${title}: ${moderator.name}. Сменить бота`}
      aria-haspopup="dialog"
      aria-controls="home-sheet-moderator"
      aria-expanded={expanded}
      onClick={onClick}
    >
      {content}
      <span className="chat-card__moderator-chevron" aria-hidden="true">
        ⌄
      </span>
    </button>
  ) : (
    <span className="chat-card__moderator-label" aria-label={`Бот сообщества: ${moderator.name}`}>
      {content}
    </span>
  );
}
