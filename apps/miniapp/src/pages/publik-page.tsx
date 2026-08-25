import {
  Calendar,
  CheckCircle,
  Clock,
  MediaImage,
  MessageText,
  NavArrowRight,
  Post,
  SendDiagonal,
} from 'iconoir-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import '../styles/publik-page.css';

const PAGE_DESCRIPTION =
  'Публик - бот для подготовки и публикации постов в чатах и каналах MAX.';

function setMetaContent(selector: string, content: string): string | null {
  const element = document.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    return null;
  }
  const previous = element.content;
  element.content = content;
  return previous;
}

export function PublikPage() {
  useEffect(() => {
    const previousTitle = document.title;
    const previousDescription = setMetaContent('meta[name="description"]', PAGE_DESCRIPTION);
    const previousOgTitle = setMetaContent('meta[property="og:title"]', 'Публик');
    const previousOgDescription = setMetaContent(
      'meta[property="og:description"]',
      PAGE_DESCRIPTION,
    );
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const previousCanonical = canonical?.href ?? null;

    document.title = 'Публик - публикации в MAX';
    canonical?.setAttribute('href', 'https://major-maksimov.ru/app/publik');

    return () => {
      document.title = previousTitle;
      if (previousDescription !== null) {
        setMetaContent('meta[name="description"]', previousDescription);
      }
      if (previousOgTitle !== null) {
        setMetaContent('meta[property="og:title"]', previousOgTitle);
      }
      if (previousOgDescription !== null) {
        setMetaContent('meta[property="og:description"]', previousOgDescription);
      }
      if (canonical && previousCanonical) {
        canonical.href = previousCanonical;
      }
    };
  }, []);

  return (
    <main className="publik-page">
      <header className="publik-nav" aria-label="Публик">
        <a className="publik-brand" href="#top" aria-label="Публик, к началу страницы">
          <span className="publik-brand__mark" aria-hidden>
            <Post />
          </span>
          <span>Публик</span>
        </a>
        <a className="publik-nav__link" href="#features">
          Возможности
        </a>
      </header>

      <section className="publik-hero" id="top" aria-labelledby="publik-title">
        <div className="publik-hero__copy">
          <span className="publik-kicker">Бот для MAX</span>
          <h1 id="publik-title">Публик</h1>
          <p>Готовьте посты, выбирайте время и публикуйте в свои чаты и каналы.</p>
          <a className="publik-primary-link" href="#features">
            <span>Что умеет бот</span>
            <NavArrowRight aria-hidden />
          </a>
        </div>

        <div className="publik-preview" aria-label="Пример публикации">
          <div className="publik-preview__bar">
            <span className="publik-preview__avatar" aria-hidden>
              <Post />
            </span>
            <span>
              <strong>Новая публикация</strong>
              <small>Канал «Новости»</small>
            </span>
            <CheckCircle aria-hidden />
          </div>
          <div className="publik-preview__media" aria-hidden>
            <MediaImage />
            <span>Фото к посту</span>
          </div>
          <p>Расскажите подписчикам о новостях, событии или важном обновлении.</p>
          <div className="publik-preview__schedule">
            <Clock aria-hidden />
            <span>Сегодня, 18:30</span>
          </div>
          <div className="publik-preview__send">
            <SendDiagonal aria-hidden />
            <span>Запланировано</span>
          </div>
        </div>
      </section>

      <section className="publik-features" id="features" aria-labelledby="features-title">
        <div className="publik-section-heading">
          <span>Всё необходимое</span>
          <h2 id="features-title">От идеи до готового поста</h2>
        </div>

        <div className="publik-feature-list">
          <article>
            <span className="publik-feature-list__icon publik-feature-list__icon--coral">
              <MessageText aria-hidden />
            </span>
            <div>
              <h3>Соберите публикацию</h3>
              <p>Добавьте текст, фотографии, видео и кнопки со ссылками.</p>
            </div>
          </article>
          <article>
            <span className="publik-feature-list__icon publik-feature-list__icon--blue">
              <Calendar aria-hidden />
            </span>
            <div>
              <h3>Выберите время</h3>
              <p>Отправьте сразу, назначьте дату или настройте регулярный выход.</p>
            </div>
          </article>
          <article>
            <span className="publik-feature-list__icon publik-feature-list__icon--green">
              <SendDiagonal aria-hidden />
            </span>
            <div>
              <h3>Публикуйте в MAX</h3>
              <p>Выбирайте нужные чаты и каналы, следите за статусом отправки.</p>
            </div>
          </article>
        </div>
      </section>

      <section className="publik-note" aria-labelledby="publik-note-title">
        <span className="publik-note__icon" aria-hidden>
          <CheckCircle />
        </span>
        <div>
          <h2 id="publik-note-title">Публикации под контролем</h2>
          <p>Черновики, расписания и история отправок остаются в одном месте.</p>
        </div>
      </section>

      <footer className="publik-footer">
        <span className="publik-footer__brand">
          <Post aria-hidden />
          <strong>Публик</strong>
        </span>
        <nav aria-label="Правовая информация">
          <Link to="/legal/agreement">Соглашение</Link>
          <Link to="/legal/privacy">Конфиденциальность</Link>
        </nav>
        <small>Сервис для публикаций в MAX</small>
      </footer>
    </main>
  );
}
