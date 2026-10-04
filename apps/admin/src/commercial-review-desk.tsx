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

const stateNames: Record<CommercialReviewItem['reviewState'], string> = {
  UNREVIEWED: 'Нужны две независимые оценки',
  AWAITING_SECOND: 'Ожидает второго проверяющего',
  DISAGREEMENT: 'Ожидает третьего проверяющего',
  RESOLVED: 'Независимая проверка завершена',
};
function executionName(item: CommercialReviewItem): string {
  const outcome = item.evidenceMetadata?.executionOutcome;
  return outcome === 'CONFIRMED_DELETE'
    ? 'Удаление подтверждено'
    : outcome === 'ALREADY_ABSENT'
      ? 'Сообщение уже отсутствует'
      : outcome === 'PENDING'
        ? 'Удаление ожидает исполнения'
        : outcome === 'NOT_REQUESTED'
          ? 'Удаление не запрашивалось'
          : 'Исполнение неизвестно';
}

export function CommercialReviewDesk({ accessCode }: { accessCode: string }) {
  const [queue, setQueue] = useState<CommercialReviewQueueResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [status, setStatus] = useState<'PENDING' | 'REVIEWED' | 'ALL'>('PENDING');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [expectedDisposition, setExpectedDisposition] = useState<'KEEP' | 'DELETE'>('DELETE');
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
      const save = selected.canAdjudicate
        ? safetyDeskApiClient.adjudicateCommercialReview.bind(safetyDeskApiClient)
        : safetyDeskApiClient.labelCommercialReview.bind(safetyDeskApiClient);
      const saved = await save(
        selected,
        value,
        reason,
        accessCode,
        value === 'UNSURE' ? null : value === 'NOT_COMMERCIAL' ? 'KEEP' : expectedDisposition,
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
      setNotice(`Сохранено: ${labelNames[saved.ownReview!.label]}`);
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
          <p>Две независимые оценки без подсказок фильтра. Срок хранения — 14 дней.</p>
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
            ['PENDING', 'Ожидают моей оценки'],
            ['REVIEWED', 'Мои оценки'],
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
        <p>
          Образцов пока нет. Очередь включает срабатывания, спорные сообщения и выборку пропусков.
        </p>
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
                setExpectedDisposition('DELETE');
              }}
            >
              <strong>{item.chatTitle}</strong>
              <span>
                {item.source === 'OCR' ? 'Фото: только подпись' : 'Текст'}
                {item.decisionVisible && <> · {executionName(item)}</>}
              </span>
              <span>
                {item.ownReview
                  ? `Моя оценка: ${labelNames[item.ownReview.label]}`
                  : stateNames[item.reviewState]}
              </span>
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
            expectedDisposition={expectedDisposition}
            onExpectedDispositionChange={setExpectedDisposition}
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
  expectedDisposition,
  onExpectedDispositionChange,
}: {
  item: CommercialReviewItem;
  reason: string;
  busy: boolean;
  onReasonChange: (value: string) => void;
  onLabel: (label: CommercialReviewLabel) => Promise<void>;
  expectedDisposition: 'KEEP' | 'DELETE';
  onExpectedDispositionChange: (value: 'KEEP' | 'DELETE') => void;
}) {
  const canAct = item.canReview || item.canAdjudicate;
  return (
    <article className="review-card commercial-review__detail" aria-label="Оценка образца">
      <header className="review-card__header">
        <div className="review-card__title">
          <h2>{item.chatTitle}</h2>
          <p>
            {new Date(item.observedAt).toLocaleString('ru-RU')} · {stateNames[item.reviewState]}
          </p>
        </div>
      </header>
      <section className="message-preview">
        <p>{item.excerpt || 'У фотографии нет подписи. Распознанный текст не хранится.'}</p>
      </section>
      {item.source === 'OCR' && (
        <p>
          Исходная фотография здесь недоступна. Подпись не позволяет оценить рекламу на изображении.
          Полную оценку проводят по исходному снимку в частном наборе проверки.
        </p>
      )}
      {item.sourceExcerptComplete === false && (
        <p>
          Текст представлен не полностью. Полную оценку проводят по исходному материалу в частном
          наборе проверки.
        </p>
      )}
      {!item.decisionVisible && (
        <p>Результат фильтра и предыдущие оценки скрыты до сохранения вашей оценки.</p>
      )}
      <dl className="commercial-review__facts">
        <dt>Независимые оценки</dt>
        <dd>
          {item.independentReviewCount}/2 · {stateNames[item.reviewState]}
        </dd>
        <dt>Моя оценка</dt>
        <dd>{item.ownReview ? labelNames[item.ownReview.label] : 'Ещё не сохранена'}</dd>
        {item.decisionVisible && (
          <>
            <dt>Оценка фильтра</dt>
            <dd>
              {item.score === null ? 'Неизвестно' : `${Math.round(item.score)}/100`} ·{' '}
              {item.actionBand ? commercialReviewActionName(item.actionBand) : 'Неизвестно'}
            </dd>
            <dt>Исполнение</dt>
            <dd>{executionName(item)}</dd>
            <dt>Разрешение удаления</dt>
            <dd>
              {item.evidenceMetadata?.deleteEligible === true
                ? 'Разрешено'
                : item.evidenceMetadata?.deleteEligible === false
                  ? 'Не разрешено'
                  : 'Неизвестно'}
            </dd>
            <dt>Основания</dt>
            <dd>
              {[...new Set(item.reasons.map(commercialReviewReasonName))].join(', ') ||
                'Не указаны'}
            </dd>
            <dt>Что учитывал фильтр</dt>
            <dd>
              {[...new Set(item.requiredPolicyCohorts.map(commercialReviewCohortName))].join(
                ', ',
              ) || 'Обычные признаки рекламы'}
            </dd>
            <dt>Итог независимой проверки</dt>
            <dd>{item.label ? labelNames[item.label] : 'Ещё не определён'}</dd>
            {item.historicalLabel && (
              <>
                <dt>Историческая одиночная оценка</dt>
                <dd>{labelNames[item.historicalLabel]}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {item.decisionVisible && (
        <details>
          <summary>Подробности проверки</summary>
          <p>
            Версия фильтра:{' '}
            {item.detectorVersion === 'unknown' ? 'Не указана' : item.detectorVersion}
          </p>
        </details>
      )}
      {item.reviewReason && <p>Комментарий: {item.reviewReason}</p>}
      <label>
        Комментарий к оценке
        <textarea
          maxLength={500}
          value={reason}
          disabled={busy || !canAct}
          onChange={(event) => onReasonChange(event.target.value)}
        />
      </label>
      {item.source === 'TEXT' && canAct && (
        <label>
          Ожидаемое решение при оценке «Реклама»
          <select
            value={expectedDisposition}
            disabled={busy}
            onChange={(event) =>
              onExpectedDispositionChange(event.target.value as 'KEEP' | 'DELETE')
            }
          >
            <option value="DELETE">Удалить коммерческое предложение</option>
            <option value="KEEP">Сохранить коммерческое упоминание</option>
          </select>
        </label>
      )}
      {item.canAdjudicate && (
        <p>Третья независимая оценка разрешит разногласие. Предыдущие оценки скрыты.</p>
      )}
      <footer className="review-actions">
        {(Object.keys(labelNames) as CommercialReviewLabel[]).map((value) => (
          <button
            key={value}
            className="ghost-action"
            type="button"
            disabled={
              busy ||
              !canAct ||
              ((item.source === 'OCR' || item.sourceExcerptComplete === false) &&
                value !== 'UNSURE')
            }
            onClick={() => void onLabel(value)}
          >
            {busy ? 'Сохранение…' : labelNames[value]}
          </button>
        ))}
      </footer>
      <p>
        Контакты скрыты. Сохранённая оценка неизменна и не запускает действия в MAX. Для второй
        оценки нужна другая учётная запись проверяющего.
      </p>
    </article>
  );
}
