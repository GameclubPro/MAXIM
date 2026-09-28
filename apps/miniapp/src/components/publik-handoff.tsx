import { ArrowUpRight } from 'iconoir-react';
import { openPublikBot, PUBLIK_BOT_URL } from '../lib/publik-bot';
import './publik-handoff.css';

export function PublikBotLink() {
  return (
    <a
      className="publik-bot-link"
      href={PUBLIK_BOT_URL}
      onClick={openPublikBot}
      title="Открыть бота Публик"
    >
      <span>Открыть бота Публик</span>
      <ArrowUpRight aria-hidden />
    </a>
  );
}

export function PublikHandoff({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <a className="publik-handoff-link" href={PUBLIK_BOT_URL} onClick={openPublikBot}>
        <span>Посты в Публике</span>
        <ArrowUpRight aria-hidden />
      </a>
    );
  }

  return (
    <aside className="publik-handoff" aria-label="Посты в Публике">
      <div className="publik-handoff__copy">
        <strong>Посты теперь в Публике</strong>
        <p>Автопостинг, импорт из VK, предложка и автоответы.</p>
      </div>
      <PublikBotLink />
    </aside>
  );
}
