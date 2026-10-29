import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { StopWordsPolicy } from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import { getStopWordsStatus, previewStopWords } from '../../lib/api/stop-words-client';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { AppIcon } from '../../components/ui/app-icon';

// FLAG: Exact-chat capabilities stay outside source-free shared settings forms.
export function SettingsStopWordsSingleTools({
  api,
  chatId,
  policy,
  reloadPolicy,
  busy,
  slot,
  revision,
  dirty,
  invalid = false,
}: {
  api: ApiTransport;
  chatId: string;
  policy?: StopWordsPolicy;
  reloadPolicy: () => Promise<void>;
  busy: boolean;
  slot: 'toolbar' | 'notice' | 'preview' | 'imageScan';
  revision?: number;
  dirty: boolean;
  invalid?: boolean;
}) {
  const [text, setText] = useState('');
  const [confirmReload, setConfirmReload] = useState(false);
  const status = useQuery({
    queryKey: ['stop-words-status', chatId],
    queryFn: ({ signal }) => getStopWordsStatus(api, chatId, signal),
    staleTime: 5000,
    refetchInterval: 15000,
    retry: false,
    enabled: Boolean(chatId) && (slot === 'notice' || slot === 'imageScan'),
  });
  const key = JSON.stringify({
    chatId,
    version: policy?.version,
    enabled: policy?.enabled,
    rules: policy?.rules,
    domains: policy?.domains,
    text,
  });
  const tester = useMutation({
    mutationFn: async (input: {
      key: string;
      chatId: string;
      policy: StopWordsPolicy;
      text: string;
    }) => ({
      key: input.key,
      result: await previewStopWords(api, input.chatId, input.policy, input.text),
    }),
  });
  const reload = useMutation({
    mutationFn: reloadPolicy,
    onSuccess: () => setConfirmReload(false),
  });
  const availability = status.isError ? 'unavailable' : status.data?.imageScanStatus;
  const availabilityText =
    availability === 'ready'
      ? 'Доступна'
      : availability === 'shadow'
        ? 'Наблюдение, без удаления'
        : availability === 'off'
          ? 'Сейчас выключена'
          : availability === 'unavailable'
            ? 'Состояние недоступно'
            : 'Проверяем доступность';
  if (slot === 'imageScan') return <p role="status">{availabilityText}</p>;
  if (slot === 'notice')
    return (status.data?.revision ?? 0) > (revision ?? 0) ? (
      <p role="status">Список изменён другим администратором.</p>
    ) : null;
  if (slot === 'toolbar')
    return (
      <>
        <button
          type="button"
          className="stop-words-editor__icon"
          title="Загрузить сохранённый список"
          aria-label="Загрузить сохранённый список"
          disabled={busy || reload.isPending}
          onClick={() => (dirty ? setConfirmReload(true) : reload.mutate())}
        >
          <AppIcon icon="Refresh" />
        </button>
        {reload.isError ? (
          <p role="alert">{describeUserFacingError(reload.error, 'Не удалось обновить список.')}</p>
        ) : null}
        <ActionConfirmSheet
          id="shared-stop-words-reload"
          open={confirmReload}
          title="Загрузить сохранённый список?"
          summary="Несохранённые изменения будут отменены."
          confirmLabel="Загрузить"
          isBusy={reload.isPending}
          onClose={() => setConfirmReload(false)}
          onConfirm={() => reload.mutate()}
        />
      </>
    );
  return (
    <details className="stop-words-editor__section">
      <summary>Проверка сообщения</summary>
      <textarea
        rows={3}
        maxLength={4000}
        value={text}
        aria-label="Сообщение для проверки"
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className="button button--accent"
        disabled={!policy || !text.trim() || tester.isPending || busy || invalid}
        onClick={() => policy && tester.mutate({ key, chatId, policy, text })}
      >
        <AppIcon icon="Play" />
        {tester.isPending ? 'Проверяем' : 'Проверить'}
      </button>
      {tester.isError && tester.variables.key === key ? (
        <p role="alert">
          {describeUserFacingError(tester.error, 'Не удалось проверить сообщение.')}
        </p>
      ) : null}
      {tester.data?.key === key ? (
        <div role="status">
          {!tester.data.result.enabled
            ? 'Модуль выключен'
            : !tester.data.result.matches.length
              ? 'Совпадений нет'
              : tester.data.result.matches.map((match) => (
                  <p key={match.ruleId}>
                    <strong>{match.value}</strong>: <mark>{match.fragment}</mark> ·{' '}
                    {match.matchKind === 'masked'
                      ? 'маскировка'
                      : match.matchKind === 'domain'
                        ? 'запрещённый сайт'
                        : 'точное совпадение'}
                  </p>
                ))}
        </div>
      ) : null}
    </details>
  );
}
