import { Component, type ReactNode } from 'react';

export class RetentionDeskLoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="retention-desk" aria-label="Очистка старых сообщений">
        <div className="empty-card" role="alert">
          <h2>Не удалось открыть очистку</h2>
          <p>
            Перезагрузите Safety Desk, чтобы обновить раздел. Для входа снова потребуется код
            доступа.
          </p>
          <button className="ghost-action" type="button" onClick={() => window.location.reload()}>
            Перезагрузить Safety Desk
          </button>
        </div>
      </section>
    );
  }
}
