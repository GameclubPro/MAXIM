import type { PublicationLatePolicy } from '@maxim/contracts/publication';
import { useId } from 'react';
import {
  formatPublicationLatePolicy,
  LEGACY_PUBLICATION_LATE_POLICY,
} from './publication-late-policy-presentation';

export function PublicationLatePolicyFields({
  value,
  recurring,
  disabled,
  onChange,
}: {
  value?: PublicationLatePolicy;
  recurring: boolean;
  disabled: boolean;
  onChange: (value: PublicationLatePolicy) => void;
}) {
  const id = useId();
  const policy = value ?? LEGACY_PUBLICATION_LATE_POLICY;
  return (
    <details className="publication-late-policy-options">
      <summary>При задержке: {formatPublicationLatePolicy(policy, recurring)}</summary>
      <fieldset className="publication-late-policy" disabled={disabled}>
        <legend>Если MAX задерживает отправку</legend>
        <label htmlFor={`${id}-mode`}>Действие при задержке</label>
        <select
          id={`${id}-mode`}
          aria-label="Действие при задержке"
          value={policy.mode}
          onChange={(event) =>
            onChange({
              ...policy,
              mode: event.target.value as PublicationLatePolicy['mode'],
              maxDelayMinutes: event.target.value === 'recover' ? 1440 : 5,
            })
          }
        >
          <option value="recover">Дождаться восстановления</option>
          <option value="strict">Пропустить после срока</option>
        </select>
        <label htmlFor={`${id}-delay`}>Пост актуален после назначенного времени</label>
        <select
          id={`${id}-delay`}
          aria-label="Пост актуален после назначенного времени"
          value={policy.maxDelayMinutes}
          onChange={(event) => onChange({ ...policy, maxDelayMinutes: Number(event.target.value) })}
        >
          {[5, 30, 60, 360, 1440, 10080].includes(policy.maxDelayMinutes) ? null : (
            <option value={policy.maxDelayMinutes}>{policy.maxDelayMinutes} мин.</option>
          )}
          <option value={5}>5 минут</option>
          <option value={30}>30 минут</option>
          <option value={60}>1 час</option>
          <option value={360}>6 часов</option>
          <option value={1440}>24 часа</option>
          <option value={10080}>7 дней</option>
        </select>
        {recurring && policy.mode === 'recover' ? (
          <>
            <label htmlFor={`${id}-catchup`}>Несколько пропущенных повторов</label>
            <select
              id={`${id}-catchup`}
              aria-label="Несколько пропущенных повторов"
              value={policy.catchUp}
              onChange={(event) =>
                onChange({
                  ...policy,
                  catchUp: event.target.value as PublicationLatePolicy['catchUp'],
                })
              }
            >
              <option value="latest">Отправить только последний</option>
              <option value="all">Отправить все актуальные</option>
            </select>
          </>
        ) : null}
        <p>
          Каждый получатель обрабатывается отдельно. При неизвестном результате отправки потребуется
          проверка. Большая рассылка доставляется постепенно.
        </p>
      </fieldset>
    </details>
  );
}
