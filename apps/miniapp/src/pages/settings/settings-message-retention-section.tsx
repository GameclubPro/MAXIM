import { Suspense, useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'iconoir-react';
import type { MessageRetentionState, MessageRetentionSummary } from '@maxim/contracts/settings';
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
  const client = useQueryClient();
  const summary = useQuery<MessageRetentionSummary>({
    queryKey: ['message-retention-summary', chatId],
    enabled: false,
    initialData: initialSummary,
    queryFn: async ({ signal }) => {
      const { getMessageRetention } = await import('../../lib/api/message-retention-client');
      return getMessageRetention(api, chatId, signal);
    },
  });
  const receiveSnapshot = useCallback(
    (value: MessageRetentionSummary, receivedAt = Date.now()) => {
      // Policy revision protects configuration; receipt time protects status from older cached reads.
      const key = ['message-retention-summary', chatId];
      const old = client.getQueryState<MessageRetentionSummary>(key);
      if (
        old?.data &&
        (old.data.revision > value.revision ||
          (old.data.revision === value.revision && old.dataUpdatedAt > receivedAt))
      )
        return;
      client.setQueryData<MessageRetentionSummary>(key, value, { updatedAt: receivedAt });
    },
    [chatId, client],
  );
  useEffect(() => {
    if (!initialSummary) return;
    receiveSnapshot(initialSummary);
    const full = client.getQueryData<MessageRetentionState>(['message-retention', chatId]);
    if (
      full &&
      (initialSummary.revision > full.revision ||
        (initialSummary.revision === full.revision && initialSummary.status !== full.status))
    )
      void client.invalidateQueries({ queryKey: ['message-retention', chatId], exact: true });
  }, [initialSummary, receiveSnapshot, chatId, client]);
  const state = summary.data;
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
          <Editor
            api={api}
            chatId={chatId}
            onClose={() => setOpen(false)}
            onSnapshot={receiveSnapshot}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
