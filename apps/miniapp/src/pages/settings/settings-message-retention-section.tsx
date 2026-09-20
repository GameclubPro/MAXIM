import { lazy, Suspense, useState } from 'react';
import { Clock } from 'iconoir-react';
import type { MessageRetentionState } from '@maxim/contracts/settings';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import { messageRetentionStatusLabels } from './settings-message-retention-model';

const Editor = lazy(() =>
  import('./settings-message-retention-editor').then((module) => ({
    default: module.SettingsMessageRetentionEditor,
  })),
);

export function SettingsMessageRetentionSection({
  api,
  chatId,
}: {
  api: ApiTransport;
  chatId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<MessageRetentionState | null>(null);
  return (
    <section
      className="settings-section settings-home-entry settings-home-entry--list"
      style={{ order: 15 }}
      aria-label="Удаление старых сообщений"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Удаление старых сообщений"
          summary={state?.enabled ? `Старше ${state.hours} ч` : ''}
          status={state ? messageRetentionStatusLabels[state.status] : undefined}
          icon={<Clock />}
          tone="sky"
          open={open}
          controls="settings-message-retention"
          onClick={() => setOpen(true)}
        />
      </div>
      {open ? (
        <Suspense fallback={<p role="status">Загрузка настроек</p>}>
          <Editor api={api} chatId={chatId} onClose={() => setOpen(false)} onSnapshot={setState} />
        </Suspense>
      ) : null}
    </section>
  );
}
