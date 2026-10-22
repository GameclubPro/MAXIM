import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { StopWordsPolicy } from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import { getStopWordsStatus, previewStopWords } from '../../lib/api/stop-words-client';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';

// FLAG: Exact-chat capabilities stay outside source-free shared settings forms.
export function SettingsStopWordsSingleTools({
  api,
  chatId,
  policy,
  reloadPolicy,
  busy,
}: {
  api: ApiTransport;
  chatId: string;
  policy?: StopWordsPolicy;
  reloadPolicy: () => Promise<void>;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const [confirmReload, setConfirmReload] = useState(false);
  const status = useQuery({
    queryKey: ['stop-words-status', chatId],
    queryFn: ({ signal }) => getStopWordsStatus(api, chatId, signal),
    staleTime: 5000,
    refetchInterval: 15000,
    retry: false,
    enabled: Boolean(chatId),
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
          ? 'Выключена на сервере'
          : availability === 'unavailable'
            ? 'Состояние недоступно'
            : 'Проверяем доступность';
  return (
    <>
      <p role="status">Распознавание текста на изображениях: {availabilityText}</p>
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
          disabled={!policy || !text.trim() || tester.isPending || busy}
          onClick={() => policy && tester.mutate({ key, chatId, policy, text })}
        >
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
      <button
        type="button"
        disabled={busy || reload.isPending}
        onClick={() => setConfirmReload(true)}
      >
        Загрузить сохранённый список
      </button>
      {reload.isError ? (
        <p role="alert">{describeUserFacingError(reload.error, 'Не удалось загрузить список.')}</p>
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
}
