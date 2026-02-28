import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ApiClient } from '../lib/api-client';

const linkPolicyLabels: Record<ChatSettings['linkPolicy'], string> = {
  ALERT_ONLY: 'Не удалять',
  ALLOWLIST_ONLY: 'Не удалять избранные',
  BLOCKLIST_ONLY: 'Удалять',
};

export function SettingsPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['settings', chatId],
    queryFn: () => api.getSettings(chatId ?? ''),
    enabled: Boolean(chatId),
  });

  const [draft, setDraft] = useState<ChatSettings | null>(null);

  const settings = useMemo(() => {
    if (!settingsQuery.data) {
      return null;
    }
    return draft ?? settingsQuery.data;
  }, [draft, settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: ChatSettings) => api.updateSettings(chatId ?? '', payload),
    onSuccess: (saved) => {
      setDraft(saved);
      void queryClient.invalidateQueries({ queryKey: ['settings', chatId] });
      alert('Настройки сохранены');
    },
  });

  if (settingsQuery.isLoading) {
    return <p>Загрузка настроек...</p>;
  }

  if (settingsQuery.error) {
    return <p>Ошибка загрузки: {(settingsQuery.error as Error).message}</p>;
  }

  if (!settings) {
    return <p>Нет настроек для этого чата.</p>;
  }

  return (
    <section className="panel">
      <h2>Правила чата {chatId}</h2>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = chatSettingsSchema.parse(settings);
          saveMutation.mutate(parsed);
        }}
      >
        <label>
          Удаление ссылок
          <select
            value={settings.linkPolicy}
            onChange={(event) =>
              setDraft({
                ...settings,
                linkPolicy: event.target.value as ChatSettings['linkPolicy'],
              })
            }
          >
            <option value="ALERT_ONLY">{linkPolicyLabels.ALERT_ONLY}</option>
            <option value="ALLOWLIST_ONLY">{linkPolicyLabels.ALLOWLIST_ONLY}</option>
            <option value="BLOCKLIST_ONLY">{linkPolicyLabels.BLOCKLIST_ONLY}</option>
          </select>
        </label>

        <button type="submit" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? 'Сохранение...' : 'Сохранить'}
        </button>
      </form>
    </section>
  );
}
