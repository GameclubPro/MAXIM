import { useState } from 'react';
import { networkSettingsChangeLabels } from './network-settings-product-labels';
import type { useNetworkSettingsController } from './network-settings-controller';
import { formatNavigationAllowlistEntryTarget } from '../../pages/settings/settings-link-allowlist';

export type NetworkSettingsReviewProps = {
  controller: Pick<
    ReturnType<typeof useNetworkSettingsController>,
    | 'changes'
    | 'read'
    | 'readOnly'
    | 'setFieldError'
    | 'setChanges'
    | 'navigationAllowlist'
    | 'operation'
    | 'preview'
  >;
  recipientTitles: ReadonlyMap<string, string>;
};

export function NetworkSettingsReview({ controller, recipientTitles }: NetworkSettingsReviewProps) {
  const [recipientLimit, setRecipientLimit] = useState(50);
  const recipients = controller.preview?.recipients ?? [];
  return (
    <>
      {controller.changes.length > 0 ? (
        <section className="network-settings-page__changes" aria-label="Ваши изменения">
          <h2>Изменено параметров: {controller.changes.length}</h2>
          <ul>
            {controller.changes.map((change) => {
              const labels = networkSettingsChangeLabels(
                change,
                controller.read?.fields[change.path],
              );
              return (
                <li key={change.path}>
                  <strong>{labels.title}</strong>
                  <span>Сейчас: {labels.before}</span>
                  <span>
                    {labels.replacement ? 'Заменить список на: ' : 'Будет: '}
                    {labels.after}
                  </span>
                  <button
                    type="button"
                    disabled={controller.readOnly}
                    onClick={() => {
                      controller.setFieldError(change.path, null);
                      controller.setChanges(
                        controller.changes.filter((item) => item.path !== change.path),
                      );
                    }}
                  >
                    Отменить изменение
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {controller.navigationAllowlist ? (
        <section
          className="network-settings-page__changes"
          aria-label="Изменения разрешённых ссылок"
        >
          <h2>
            {controller.navigationAllowlist.mode === 'replace'
              ? 'Полная замена разрешённых ссылок'
              : 'Действия с разрешёнными ссылками'}
          </h2>
          <ul>
            {controller.navigationAllowlist.mode === 'replace'
              ? controller.navigationAllowlist.entries.map((entry, index) => (
                  <li key={index}>
                    {formatNavigationAllowlistEntryTarget({
                      kind: entry.kind,
                      domain: entry.value,
                      target: entry.value,
                      normalizedValue: entry.value,
                    })}{' '}
                    ·{' '}
                    {entry.removeAfterAt
                      ? 'до ' + new Date(entry.removeAfterAt).toLocaleString('ru-RU')
                      : 'без срока'}
                  </li>
                ))
              : controller.navigationAllowlist.actions.map((action, index) => (
                  <li key={index}>
                    {action.op === 'add'
                      ? 'Добавить'
                      : action.op === 'remove'
                        ? 'Удалить'
                        : 'Изменить срок'}
                    :{' '}
                    {formatNavigationAllowlistEntryTarget({
                      kind: action.target.kind,
                      domain: action.target.value,
                      target: action.target.value,
                      normalizedValue: action.target.value,
                    })}
                    {action.op !== 'remove'
                      ? ' · ' +
                        (action.removeAfterAt
                          ? 'до ' + new Date(action.removeAfterAt).toLocaleString('ru-RU')
                          : 'без срока')
                      : ''}
                  </li>
                ))}
          </ul>
          {controller.navigationAllowlist.mode === 'replace' &&
          !controller.navigationAllowlist.entries.length ? (
            <p>Все разрешённые ссылки выбранных чатов будут удалены.</p>
          ) : null}
          {controller.operation?.navigationAllowlistImpacts ? (
            <ul>
              {controller.operation.navigationAllowlistImpacts.map((impact) => (
                <li key={impact.entityId}>
                  <strong>{recipientTitles.get(impact.entityId) ?? 'Чат'}</strong>
                  <span>
                    Записей: {impact.before} → {impact.after}. Добавится: {impact.added}; удалится:{' '}
                    {impact.removed}; изменится срок: {impact.expiryChanged}; без изменений:{' '}
                    {impact.noops}.
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Последствия для каждого чата появятся после проверки.</p>
          )}
        </section>
      ) : null}
      {recipients.length ? (
        <section className="network-settings-page__changes" aria-label="Получатели изменений">
          <h2>Где применятся изменения · {recipients.length}</h2>
          <p>Только указанные параметры. Остальные настройки сохранятся.</p>
          <details className="network-settings-details">
            <summary>Проверить список сообществ</summary>
            <ul className="network-settings-outcomes">
              {recipients.slice(0, recipientLimit).map((recipient) => (
                <li key={recipient.entityId}>
                  <strong>{recipient.title}</strong>
                </li>
              ))}
            </ul>
            {recipients.length > recipientLimit ? (
              <button type="button" onClick={() => setRecipientLimit((value) => value + 50)}>
                Показать ещё сообщества · {Math.min(50, recipients.length - recipientLimit)}
              </button>
            ) : null}
          </details>
        </section>
      ) : null}
    </>
  );
}
