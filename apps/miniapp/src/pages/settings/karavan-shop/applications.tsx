import { useState } from 'react';
import { useStorefrontDirty } from '../storefront-workspace';
import type { MarketplaceApplication } from '@maxim/contracts/karavan-marketplace-management';
import { ListingContentDisclosure } from './listing-content-disclosure';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShopMutation,
  useShopPages,
} from './runtime';
import { SellerAccessAction } from './seller-access';
import { uniqueShopItems } from './shop-journey';
import { publicationReasons } from './listing-status';

function Application({
  application,
  onResult,
}: {
  application: MarketplaceApplication;
  onResult: (message: string) => void;
}) {
  const [decision, setDecision] = useState<'reject' | 'changes_requested' | null>(null);
  const [reason, setReason] = useState('');
  const mutation = useShopMutation((command, result) => {
    if (command.operation !== 'decide') return;
    const value = command.input.decision;
    const label =
      value === 'approve'
        ? 'Витрина одобрена'
        : value === 'reject'
          ? 'Заявка отклонена'
          : 'Заявка отправлена на доработку';
    onResult(
      value === 'approve' && 'listing' in result && result.listing.publicationReason !== 'published'
        ? `${label}. ${publicationReasons[result.listing.publicationReason]}.`
        : label,
    );
    setDecision(null);
    setReason('');
  });
  const locked = mutation.isPending || mutation.isError;
  useStorefrontDirty(`application:${application.id}`, !!decision && !!reason.trim());
  const decide = async (value: 'approve' | 'reject' | 'changes_requested') => {
    await mutation.mutateAsync({
      operation: 'decide',
      applicationId: application.id,
      input: {
        commandId: crypto.randomUUID(),
        expectedRevision: application.revision,
        decision: value,
        reason: value === 'approve' ? null : reason.trim(),
      },
    });
  };
  return (
    <article className="karavan-shop__row">
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
      <ListingContentDisclosure listingId={application.listingId} />
      {application.canReview ? (
        <div className="karavan-module__entry-actions">
          <button
            type="button"
            className="karavan-module__primary"
            disabled={locked}
            onClick={() => void decide('approve').catch(() => {})}
          >
            {mutation.isPending &&
            mutation.variables?.operation === 'decide' &&
            mutation.variables.input.decision === 'approve'
              ? 'Одобряем…'
              : 'Одобрить'}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setDecision('changes_requested');
              setReason('');
            }}
          >
            На доработку
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setDecision('reject');
              setReason('');
            }}
          >
            Отклонить
          </button>
        </div>
      ) : (
        <p>Вашу витрину проверяет другой администратор.</p>
      )}
      {decision ? (
        <div className="karavan-module__actions">
          <label className="karavan-module__field">
            {decision === 'reject' ? 'Причина отказа' : 'Что нужно исправить'}
            <textarea
              value={reason}
              maxLength={2000}
              disabled={locked}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={locked || !reason.trim()}
            onClick={() => void decide(decision).catch(() => {})}
          >
            {mutation.isPending
              ? 'Сохраняем решение…'
              : decision === 'reject'
                ? 'Отклонить заявку'
                : 'Отправить на доработку'}
          </button>
          <button type="button" disabled={locked} onClick={() => setDecision(null)}>
            Отмена
          </button>
        </div>
      ) : null}
      <MutationFailure mutation={mutation} />
    </article>
  );
}

export default function ShopApplications() {
  const [notice, setNotice] = useState('');
  const query = useShopPages<'applications'>({
    operation: 'applications',
    input: { cursor: null, limit: 24, state: 'pending' },
  });
  if (query.isPending) return <ShopLoading />;
  if (!query.data) return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  const applications = uniqueShopItems(query.data.pages.map((page) => page.applications));
  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}
      {!applications.length ? (
        <>
          <p>Новых заявок нет</p>
          <SellerAccessAction />
        </>
      ) : null}
      {applications.map((application) => (
        <Application key={application.id} application={application} onResult={setNotice} />
      ))}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
      {query.isFetchNextPageError ? (
        <ShopFailure error={query.error} retry={() => void query.fetchNextPage()} />
      ) : null}
    </>
  );
}
