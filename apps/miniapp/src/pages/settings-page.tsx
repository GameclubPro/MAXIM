import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ApiClient } from '../lib/api-client';

const profanityLevelLabels: Record<ChatSettings['profanityLevel'], string> = {
  LOW: 'Низкий',
  MEDIUM: 'Средний',
  HIGH: 'Высокий',
};

const linkPolicyLabels: Record<ChatSettings['linkPolicy'], string> = {
  ALLOWLIST_ONLY: 'Только из списка разрешенных доменов',
  BLOCKLIST_ONLY: 'Блокировать только запрещенные домены',
  ALERT_ONLY: 'Только предупреждать',
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
          Уровень мат-фильтра
          <select
            value={settings.profanityLevel}
            onChange={(event) =>
              setDraft({
                ...settings,
                profanityLevel: event.target.value as ChatSettings['profanityLevel'],
              })
            }
          >
            <option value="LOW">{profanityLevelLabels.LOW}</option>
            <option value="MEDIUM">{profanityLevelLabels.MEDIUM}</option>
            <option value="HIGH">{profanityLevelLabels.HIGH}</option>
          </select>
        </label>

        <label>
          Порог капса (%)
          <input
            type="number"
            value={settings.capsThreshold}
            onChange={(event) => setDraft({ ...settings, capsThreshold: Number(event.target.value) })}
          />
        </label>

        <label>
          Максимум сообщений во флуд-окне
          <input
            type="number"
            value={settings.floodMaxMessages}
            onChange={(event) => setDraft({ ...settings, floodMaxMessages: Number(event.target.value) })}
          />
        </label>

        <label>
          Окно флуда (сек.)
          <input
            type="number"
            value={settings.floodWindowSec}
            onChange={(event) => setDraft({ ...settings, floodWindowSec: Number(event.target.value) })}
          />
        </label>

        <label>
          Максимум повторов
          <input
            type="number"
            value={settings.duplicateMaxCount}
            onChange={(event) => setDraft({ ...settings, duplicateMaxCount: Number(event.target.value) })}
          />
        </label>

        <label>
          Окно повторов (сек.)
          <input
            type="number"
            value={settings.duplicateWindowSec}
            onChange={(event) => setDraft({ ...settings, duplicateWindowSec: Number(event.target.value) })}
          />
        </label>

        <label>
          Политика ссылок
          <select
            value={settings.linkPolicy}
            onChange={(event) =>
              setDraft({
                ...settings,
                linkPolicy: event.target.value as ChatSettings['linkPolicy'],
              })
            }
          >
            <option value="ALLOWLIST_ONLY">{linkPolicyLabels.ALLOWLIST_ONLY}</option>
            <option value="BLOCKLIST_ONLY">{linkPolicyLabels.BLOCKLIST_ONLY}</option>
            <option value="ALERT_ONLY">{linkPolicyLabels.ALERT_ONLY}</option>
          </select>
        </label>

        <label>
          Порог предупреждений
          <input
            type="number"
            value={settings.warnThreshold}
            onChange={(event) => setDraft({ ...settings, warnThreshold: Number(event.target.value) })}
          />
        </label>

        <label>
          Окно повтора для бана (дни)
          <input
            type="number"
            value={settings.repeatBanWindowDays}
            onChange={(event) => setDraft({ ...settings, repeatBanWindowDays: Number(event.target.value) })}
          />
        </label>

        <label>
          Хранение логов (дни)
          <input
            type="number"
            value={settings.logRetentionDays}
            onChange={(event) => setDraft({ ...settings, logRetentionDays: Number(event.target.value) })}
          />
        </label>

        <button type="submit" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? 'Сохранение...' : 'Сохранить'}
        </button>
      </form>
    </section>
  );
}
