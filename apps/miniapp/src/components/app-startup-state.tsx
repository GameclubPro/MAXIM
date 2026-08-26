import { GlassCard } from './ui/glass-card';
import { StatusState } from './ui/status-state';

type AppStartupStateKind = 'profile-error' | 'preview-loading' | 'init-missing';

export function AppStartupState({ kind }: { kind: AppStartupStateKind }) {
  if (kind === 'profile-error') {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <StatusState
            tone="danger"
            title="Не удалось открыть приложение"
            description="Закройте окно и запустите приложение из бота ещё раз."
          />
        </GlassCard>
      </div>
    );
  }

  if (kind === 'preview-loading') {
    return (
      <div className="app-shell app-shell--centered">
        <GlassCard className="init-missing-card" elevated>
          <h1>Design Preview</h1>
          <StatusState
            tone="neutral"
            title="Подготавливаю preview"
            description="Загружаю мобильную рамку и моковые данные для дизайн-режима."
          />
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="app-shell app-shell--centered">
      <GlassCard className="init-missing-card" elevated>
        <h1>Панель ботов</h1>
        <StatusState
          tone="warning"
          title="Не удалось открыть приложение"
          description="Запустите панель через кнопку в боте MAX. При открытии по прямой ссылке вход недоступен."
        />
        <div className="init-missing-help">
          <p>Проверьте:</p>
          <ul>
            <li>Откройте приложение из MAX, а не по прямой ссылке в браузере.</li>
            <li>Если кнопка в боте не открывает панель, закройте приложение и попробуйте еще раз.</li>
            <li>При сохранении проблемы напишите администратору бота.</li>
          </ul>
        </div>
      </GlassCard>
    </div>
  );
}
