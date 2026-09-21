import { Suspense, useState } from 'react';
import { Clock } from 'iconoir-react';
import type { MessageRetentionSummary } from '@maxim/contracts/settings';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import { messageRetentionStatusLabels } from './settings-message-retention-model';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { SettingsMessageRetentionEditorProps } from './settings-message-retention-editor';

const Editor = recoverableLazyNamedComponent<SettingsMessageRetentionEditorProps>(
  () => import('./settings-message-retention-editor'),
  'SettingsMessageRetentionEditor',
);

export function SettingsMessageRetentionSection({
  api,
  chatId,
  initialSummary,
}: {
  api: ApiTransport;
  chatId: string;
  initialSummary?: MessageRetentionSummary;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setState] = useState<MessageRetentionSummary | null>(null);
  const state =
    snapshot && (!initialSummary || snapshot.revision >= initialSummary.revision)
      ? snapshot
      : initialSummary;
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
        <Suspense
          fallback={
            <p role="status" aria-live="polite">
              Загрузка настроек
            </p>
          }
        >
          <Editor api={api} chatId={chatId} onClose={() => setOpen(false)} onSnapshot={setState} />
        </Suspense>
      ) : null}
    </section>
  );
}
