import { networkSettingsChangeLabels } from './network-settings-product-labels';
import type { useNetworkSettingsController } from './network-settings-controller';

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
  >;
  recipientTitles: ReadonlyMap<string, string>;
};

export function NetworkSettingsReview({ controller, recipientTitles }: NetworkSettingsReviewProps) {
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
                    {entry.value} ·{' '}
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
                    : {action.target.value}
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
    </>
  );
}
