import { useEffect, useRef, useState } from 'react';
import type {
  CommercialReviewItem,
  CommercialReviewLabel,
  CommercialReviewQueueResponse,
} from '@maxim/contracts/safety-desk';
import { safetyDeskApiClient } from './safety-desk-api-client';
import { readErrorMessage } from './safety-desk-model';
import {
  commercialReviewActionName,
  commercialReviewCohortName,
  commercialReviewReasonName,
} from './commercial-review-labels';

const labelNames: Record<CommercialReviewLabel, string> = {
  COMMERCIAL: 'Реклама',
  NOT_COMMERCIAL: 'Не реклама',
  UNSURE: 'Недостаточно данных',
};

export function CommercialReviewDesk({ accessCode }: { accessCode: string }) {
  const [queue, setQueue] = useState<CommercialReviewQueueResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [status, setStatus] = useState<'PENDING' | 'REVIEWED' | 'ALL'>('PENDING');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const mutationBusy = useRef(false);
  const selected = queue?.items.find((item) => item.id === selectedId) ?? queue?.items[0];

  async function refresh(nextCursor: string | undefined, nextStatus = status) {
    setLoading(true);
    try {
      const response = await safetyDeskApiClient.fetchCommercialReview(
        accessCode,
        nextCursor,
        nextStatus,
      );
      setQueue(response);
      setCursor(nextCursor);
      setStatus(nextStatus);
      setSelectedId((current) =>
        response.items.some((item) => item.id === current)
          ? current
          : (response.items[0]?.id ?? ''),
      );
      setNotice('Очередь обновлена');
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    void safetyDeskApiClient
      .fetchCommercialReview(accessCode)
      .then((response) => {
        if (active) {
          setQueue(response);
          setSelectedId(response.items[0]?.id ?? '');
        }
      })
      .catch((error: unknown) => {
        if (active) setNotice(readErrorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accessCode]);

  async function label(value: CommercialReviewLabel) {
    if (!selected || mutationBusy.current) return;
    mutationBusy.current = true;
    setBusy(true);
    try {
      const saved = await safetyDeskApiClient.labelCommercialReview(
        selected,
        value,
        reason,
        accessCode,
      );
      setQueue((current) =>
        current
          ? {
              ...current,
              items:
                status === 'PENDING'
                  ? current.items.filter((item) => item.id !== saved.id)
                  : current.items.map((item) => (item.id === saved.id ? saved : item)),
            }
          : current,
      );
      setReason('');
      setNotice(`Сохранено: ${labelNames[saved.label!]}`);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      mutationBusy.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="commercial-review" aria-label="Проверка коммерческого фильтра">
      <header className="commercial-review__header">
        <div>
          <h2>Коммерческий фильтр</h2>
          <p>Оценки для проверки качества. Срок хранения образцов — 14 дней.</p>
        </div>
        <button
          className="ghost-action"
          type="button"
          disabled={loading || busy}
          onClick={() => void refresh(cursor)}
        >
          Обновить
        </button>
      </header>
      <p className="commercial-review__notice" role="status">
        {notice ||
          (loading ? 'Загрузка образцов…' : `Образцов на странице: ${queue?.items.length ?? 0}`)}
      </p>
      {!loading && !queue && (
        <button className="ghost-action" type="button" onClick={() => void refresh(cursor)}>
          Повторить загрузку
        </button>
      )}
      <div className="commercial-review__filters" aria-label="Статус оценки">
        {(
          [
            ['PENDING', 'Ожидают оценки'],
            ['REVIEWED', 'Оценены'],
            ['ALL', 'Все'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className="ghost-action"
            type="button"
            aria-pressed={status === value}
            disabled={loading || busy}
            onClick={() => void refresh(undefined, value)}
          >
            {label}
          </button>
        ))}
      </div>
      {queue?.items.length === 0 && (
        <p>Образцов пока нет. Здесь появятся спорные сообщения и подтверждённые удаления.</p>
      )}
      <div className="commercial-review__layout">
        <div className="commercial-review__list" aria-label="Образцы сообщений">
          {queue?.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === selected?.id ? 'is-active' : ''}
              aria-pressed={item.id === selected?.id}
              disabled={busy}
              onClick={() => {
                setSelectedId(item.id);
                setReason('');
              }}
            >
              <strong>{item.chatTitle}</strong>
              <span>
                {item.source === 'OCR' ? 'Фото' : 'Текст'} ·{' '}
                {item.messageDisposition === 'DELETE' ? 'Удалено' : 'Удаление не подтверждено'} ·{' '}
                {Math.round(item.score)}/100
              </span>
              <span>{item.label ? labelNames[item.label] : 'Ожидает оценки'}</span>
            </button>
          ))}
        </div>
        {selected && (
          <CommercialReviewDetail
            item={selected}
            reason={reason}
            busy={busy || loading}
            onReasonChange={setReason}
            onLabel={label}
          />
        )}
      </div>
      <footer className="commercial-review__pagination">
        <button
          className="ghost-action"
          type="button"
          disabled={!cursor || loading || busy}
          onClick={() => void refresh(undefined)}
        >
          В начало
        </button>
        <button
          className="ghost-action"
          type="button"
          disabled={!queue?.nextCursor || loading || busy}
          onClick={() => void refresh(queue?.nextCursor ?? undefined)}
        >
          Следующая страница
        </button>
      </footer>
    </section>
  );
}

function CommercialReviewDetail({
  item,
  reason,
  busy,
  onReasonChange,
  onLabel,
}: {
  item: CommercialReviewItem;
  reason: string;
  busy: boolean;
  onReasonChange: (value: string) => void;
  onLabel: (label: CommercialReviewLabel) => Promise<void>;
}) {
  return (
    <article className="review-card commercial-review__detail" aria-label="Оценка образца">
      <header className="review-card__header">
        <div className="review-card__title">
          <h2>{item.chatTitle}</h2>
          <p>
            {new Date(item.observedAt).toLocaleString('ru-RU')} ·{' '}
            {item.messageDisposition === 'DELETE'
              ? 'Удаление подтверждено'
              : 'Удаление не подтверждено'}
          </p>
        </div>
      </header>
      <section className="message-preview">
        <p>{item.excerpt || 'У фотографии нет подписи. Распознанный текст не хранится.'}</p>
      </section>
      <dl className="commercial-review__facts">
        <dt>Оценка фильтра</dt>
        <dd>
          {Math.round(item.score)}/100 · {commercialReviewActionName(item.actionBand)}
        </dd>
        <dt>Основания</dt>
        <dd>
          {[...new Set(item.reasons.map(commercialReviewReasonName))].join(', ') || 'Не указаны'}
        </dd>
        <dt>Что учитывал фильтр</dt>
        <dd>
          {[...new Set(item.requiredPolicyCohorts.map(commercialReviewCohortName))].join(', ') ||
            'Обычные признаки рекламы'}
        </dd>
        <dt>Текущая оценка</dt>
        <dd>{item.label ? labelNames[item.label] : 'Ещё не оценён'}</dd>
      </dl>
      <details>
        <summary>Подробности проверки</summary>
        <p>
          Версия фильтра: {item.detectorVersion === 'unknown' ? 'Не указана' : item.detectorVersion}
        </p>
      </details>
      {item.reviewReason && <p>Комментарий: {item.reviewReason}</p>}
      <label>
        Комментарий к оценке
        <textarea
          maxLength={500}
          value={reason}
          disabled={busy}
          onChange={(event) => onReasonChange(event.target.value)}
        />
      </label>
      <footer className="review-actions">
        {(Object.keys(labelNames) as CommercialReviewLabel[]).map((value) => (
          <button
            key={value}
            className="ghost-action"
            type="button"
            disabled={busy}
            onClick={() => void onLabel(value)}
          >
            {busy ? 'Сохранение…' : labelNames[value]}
          </button>
        ))}
      </footer>
      <p>Контакты скрыты. Оценка записывается в аудит и не запускает действия в MAX.</p>
    </article>
  );
}
