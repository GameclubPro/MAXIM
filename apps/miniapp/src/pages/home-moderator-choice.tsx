import { useEffect, useRef, useState } from 'react';
import type {
  AssignManagedModeratorRequest,
  ManagedModeratorChoices,
  ManagedModeratorAssignmentResult,
} from '@maxim/contracts';
import type { ApiTransport } from '../lib/api/transport';
import { ModeratorPortrait } from '../components/ui/moderator-portrait';
import { openMaxBotLink } from '../lib/max-bridge';
import {
  moderatorOperationKey,
  readModeratorOperation,
  saveModeratorOperation,
  clearModeratorOperation,
} from '../lib/moderator-operation';

type Props = {
  api: ApiTransport;
  scope: string;
  entityType: 'chat' | 'channel';
  entityId: string;
  onSaved: (result: ManagedModeratorAssignmentResult) => void;
};
const reasons = {
  needs_activation: 'Подтвердите подключение этого бота',
  needs_permissions: 'Выдайте боту права для включённых функций',
  unavailable: 'Бот пока недоступен',
};
function statusOf(error: unknown) {
  return (
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode
  );
}
export default function HomeModeratorChoice({ api, scope, entityType, entityId, onSaved }: Props) {
  const path = `/managed-entities/${entityType}/${encodeURIComponent(entityId)}/moderator`;
  const storageKey = moderatorOperationKey(scope, entityType, entityId);
  const [choices, setChoices] = useState<ManagedModeratorChoices | null>(null);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState<AssignManagedModeratorRequest | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const submitting = useRef(false);
  const saved = useRef(onSaved);
  saved.current = onSaved;

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void (async () => {
      try {
        const request = await readModeratorOperation(storageKey);
        if (!alive.current || abort.signal.aborted) return;
        setPending(request);
        const value = (await api.request(path, {
          signal: abort.signal,
        })) as ManagedModeratorChoices;
        if (!alive.current || abort.signal.aborted) return;
        setChoices(value);
        setSelected(request?.moderatorKey ?? value.current?.key ?? '');
        if (request) {
          try {
            const result = (await api.request(`${path}/operations/${request.operationId}`, {
              signal: abort.signal,
            })) as ManagedModeratorAssignmentResult;
            await complete(request, result);
          } catch (error) {
            if (statusOf(error) === 404 && value.revision > request.expectedRevision) {
              // FLAG: Read the advanced revision before exact operation absence. A delayed
              // request cannot commit its older CAS revision or escape this saved identity.
              await clearModeratorOperation(storageKey, request.operationId);
              if (alive.current) {
                setPending(null);
                setSelected(value.current?.key ?? '');
              }
            } else if (alive.current) setError('Ответ о смене не получен. Проверьте результат.');
          }
        }
      } catch {
        if (alive.current) setError('Не удалось загрузить ботов. Попробуйте ещё раз.');
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [api, path, storageKey]);

  async function complete(
    request: AssignManagedModeratorRequest,
    result: ManagedModeratorAssignmentResult,
  ) {
    if (
      result.operationId !== request.operationId ||
      result.moderator.key !== request.moderatorKey ||
      result.status !== 'applied' ||
      result.revision <= request.expectedRevision
    )
      throw new Error('Unconfirmed moderator assignment');
    await clearModeratorOperation(storageKey, request.operationId);
    if (alive.current) {
      setPending(null);
      saved.current(result);
    }
  }

  async function submit() {
    if (submitting.current || !choices) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    let request = pending;
    try {
      if (!request) {
        request = {
          operationId: crypto.randomUUID(),
          moderatorKey: selected,
          expectedRevision: choices.revision,
        };
        await saveModeratorOperation(storageKey, request);
        if (alive.current) setPending(request);
      } else {
        try {
          const result = (await api.request(
            `${path}/operations/${request.operationId}`,
          )) as ManagedModeratorAssignmentResult;
          await complete(request, result);
          return;
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
        }
      }
      const result = (await api.request(path, {
        method: 'POST',
        body: JSON.stringify(request),
        retryMutationOnTransportError: false,
      })) as ManagedModeratorAssignmentResult;
      await complete(request, result);
    } catch (error) {
      if (alive.current)
        setError(
          statusOf(error) === 403
            ? 'Проверьте свои права администратора и права выбранного бота.'
            : statusOf(error) === 409
              ? 'Выбор или права бота изменились. Откройте список заново.'
              : 'Ответ о смене не получен. Проверьте результат.',
        );
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!choices)
    return (
      <div className="home-moderator__status" role="status">
        {busy ? 'Загружаем ботов…' : error}
        {!busy && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setBusy(true);
              setError('');
              void api
                .request(path)
                .then((value) => {
                  if (alive.current) {
                    const next = value as ManagedModeratorChoices;
                    setChoices(next);
                    setSelected(pending?.moderatorKey ?? next.current?.key ?? '');
                  }
                })
                .catch(() => {
                  if (alive.current) setError('Не удалось загрузить ботов. Попробуйте позже.');
                })
                .finally(() => {
                  if (alive.current) setBusy(false);
                });
            }}
          >
            Повторить
          </button>
        )}
      </div>
    );
  return (
    <div className="home-moderator" aria-busy={busy}>
      {choices.current && !choices.candidates.some((bot) => bot.key === choices.current?.key) && (
        <div className="home-moderator__current">
          <ModeratorPortrait moderator={choices.current} />
          <span>
            <strong>{choices.current.name}</strong>
            <small>Сейчас выбран · пока недоступен</small>
          </span>
        </div>
      )}
      <div className="home-moderator__options" role="radiogroup" aria-label="Бот сообщества">
        {choices.candidates.map((bot) => (
          <label
            key={bot.key}
            className={`home-moderator__option${selected === bot.key ? ' is-selected' : ''}${!bot.selectable ? ' is-unavailable' : ''}`}
          >
            <input
              type="radio"
              name="community-moderator"
              value={bot.key}
              checked={selected === bot.key}
              disabled={busy || Boolean(pending) || !choices.selectionEnabled || !bot.selectable}
              onChange={() => setSelected(bot.key)}
            />
            <ModeratorPortrait moderator={bot} />
            <span>
              <strong>{bot.name}</strong>
              <small>
                {bot.reason
                  ? reasons[bot.reason]
                  : choices.current?.key === bot.key
                    ? 'Сейчас выбран'
                    : 'Можно выбрать'}
              </small>
            </span>
            <span className="home-moderator__check" aria-hidden="true">
              {selected === bot.key ? '✓' : ''}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p className="home-moderator__error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button button--accent home-moderator__submit"
        onClick={() => void submit()}
        disabled={
          busy ||
          (!pending &&
            (!choices.selectionEnabled ||
              !selected ||
              selected === choices.current?.key ||
              !choices.candidates.some((bot) => bot.key === selected && bot.selectable)))
        }
      >
        {busy ? 'Меняем бота…' : pending ? 'Проверить смену' : 'Сменить бота'}
      </button>
      {choices.candidates.find((bot) => bot.key === selected)?.url && (
        <button
          type="button"
          className="home-moderator__open"
          onClick={() => {
            const url = choices.candidates.find((bot) => bot.key === selected)?.url;
            if (url) openMaxBotLink(url);
          }}
        >
          Открыть бота в MAX ↗
        </button>
      )}
    </div>
  );
}
