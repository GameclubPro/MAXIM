import { lazy, Suspense, useState } from 'react';
import type { MarketplaceApplication } from '@maxim/contracts/karavan-marketplace-management';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShopMutation,
  useShopQuery,
} from './runtime';
const Invitations = lazy(() => import('./invitations'));
export default function ShopApplications({ canInvite }: { canInvite: boolean }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketplaceApplication | null>(null);
  const [reason, setReason] = useState('');
  const query = useShopQuery<'applications'>({
    operation: 'applications',
    input: { cursor, limit: 24, state: 'pending' },
  });
  const mutation = useShopMutation(() => {
    setSelected(null);
    setReason('');
  });
  if (query.isPending) return <ShopLoading />;
  if (query.isError) return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  const decide = async (
    application: MarketplaceApplication,
    decision: 'approve' | 'reject' | 'changes_requested',
  ) => {
    await mutation.mutateAsync({
      operation: 'decide',
      applicationId: application.id,
      input: {
        commandId: crypto.randomUUID(),
        expectedRevision: application.revision,
        decision,
        reason: decision === 'approve' ? null : reason.trim(),
      },
    });
    setSelected(null);
    setReason('');
  };
  return (
    <>
      {canInvite ? (
        <button type="button" onClick={() => setInviteOpen((value) => !value)}>
          {inviteOpen ? 'Закрыть приглашения' : 'Пригласить продавцов'}
        </button>
      ) : null}
      {inviteOpen ? (
        <Suspense fallback={<ShopLoading />}>
          <Invitations />
        </Suspense>
      ) : null}
      <MutationFailure mutation={mutation} />
      {!query.data.applications.length ? <p>Новых заявок нет</p> : null}
      {query.data.applications.map((application) => (
        <article className="karavan-shop__row" key={application.id}>
          <div className="karavan-shop__identity">
            {application.profile.logoImageUrl ? (
              <img src={application.profile.logoImageUrl} alt="" />
            ) : null}
            <strong>{application.profile.name}</strong>
          </div>
          {application.profile.description ? <p>{application.profile.description}</p> : null}
          {application.publishedProfile &&
          application.publishedProfile.name !== application.profile.name ? (
            <p>Сейчас: {application.publishedProfile.name}</p>
          ) : null}
          {application.canReview ? (
            <div className="karavan-module__entry-actions">
              <button
                type="button"
                className="karavan-module__primary"
                disabled={mutation.isPending}
                onClick={() => void decide(application, 'approve').catch(() => {})}
              >
                Принять
              </button>
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => {
                  setSelected(application);
                  setReason('');
                }}
              >
                Отклонить
              </button>
            </div>
          ) : (
            <p>Вашу витрину проверяет другой администратор.</p>
          )}
          {selected?.id === application.id ? (
            <div className="karavan-module__actions">
              <label className="karavan-module__field">
                Причина
                <textarea
                  value={reason}
                  maxLength={2000}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="karavan-module__entry-actions">
                <button
                  type="button"
                  disabled={!reason.trim() || mutation.isPending}
                  onClick={() => void decide(application, 'changes_requested').catch(() => {})}
                >
                  На доработку
                </button>
                <button
                  type="button"
                  disabled={!reason.trim() || mutation.isPending}
                  onClick={() => void decide(application, 'reject').catch(() => {})}
                >
                  Отклонить заявку
                </button>
              </div>
              <button type="button" onClick={() => setSelected(null)}>
                Отмена
              </button>
            </div>
          ) : null}
        </article>
      ))}
      {query.data.nextCursor ? (
        <button type="button" onClick={() => setCursor(query.data.nextCursor)}>
          Следующие заявки
        </button>
      ) : null}
      {cursor ? (
        <button type="button" onClick={() => setCursor(null)}>
          К новым заявкам
        </button>
      ) : null}
    </>
  );
}
