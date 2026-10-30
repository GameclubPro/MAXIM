import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceEditorialStateSchema,
  marketplaceEditorialMutationSchema,
  type MarketplaceEditorialState,
} from '@maxim/contracts/marketplace-integration';
import { ApiRequestError } from '../lib/api-request-error';
import { marketplaceEntityPath } from '../lib/marketplace-button-policy';
import { marketplaceQueryKey } from '../lib/marketplace-profile-view';
import { MarketplaceEditorActions } from './marketplace-editor-actions';
import { EntityAvatar } from './ui/entity-avatar';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

type Draft = {
  description: string;
  original: string;
  revision: number;
  listingId: string;
  ownershipKey: string;
};
export default function MarketplaceEditorialWorkspace({
  api,
  entityId,
  entityType,
  profile,
  entityTitle,
  entityAvatarUrl,
  active,
  canAccess,
  expectedEntityId,
  resetDraftVersion,
  onDirtyChange,
  onBusyChange,
  onDraftChange,
}: MarketplaceProfileCardProps & {
  active: boolean;
  canAccess: boolean;
  expectedEntityId: string;
  resetDraftVersion: number;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onDraftChange: () => void;
}) {
  const cache = useQueryClient();
  const queryKey = ['marketplace-editorial', profile, entityType, entityId];
  const path = marketplaceEntityPath(profile, entityType, entityId, 'editorial');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false);
  const [, updateClock] = useState(0);
  const allowed = useRef(canAccess);
  allowed.current = canAccess;
  const resetVersion = useRef(resetDraftVersion);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const parse = (raw: unknown): MarketplaceEditorialState => {
    const result = marketplaceEditorialStateSchema.parse(raw);
    if (result.entityId !== expectedEntityId || result.kind !== entityType.toUpperCase())
      throw new Error('Не удалось подтвердить карточку площадки');
    return result;
  };
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = parse(await api.request(path, { signal }));
      if (!allowed.current) throw new Error('Проверьте доступ к карточке');
      setDenied(false);
      return result;
    },
    enabled: canAccess && active,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: canAccess && active && !denied ? 30_000 : false,
  });
  const state = query.data;
  const fresh = !!state && Date.parse(state.validUntil) > Date.now();
  const readable = canAccess && fresh && !denied && !query.isError;
  const dirty = !!draft && draft.description !== draft.original;
  const sameCard =
    !draft ||
    (!!state && draft.listingId === state.listing.id && draft.ownershipKey === state.ownershipKey);
  const conflict = !!draft && !!state && draft.revision !== state.revision;
  const description = draft?.description ?? (readable ? state!.listing.description : '');
  const minimum = state?.listing.profileOnly ? 1 : 30;
  const mutation = useMutation({
    onMutate: async () => {
      await cache.cancelQueries({ queryKey });
    },
    mutationFn: async () => {
      if (!allowed.current || !readable || !state || !draft || !sameCard || conflict)
        throw new Error('Обновите карточку перед сохранением');
      const change = {
        listingId: draft.listingId,
        ownershipKey: draft.ownershipKey,
        expectedRevision: draft.revision,
        description: draft.description.trim(),
      };
      const fingerprint = JSON.stringify(change);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      const result = parse(
        await api.request(path, {
          method: 'PATCH',
          body: JSON.stringify(
            marketplaceEditorialMutationSchema.parse({ ...change, requestId: attempt.current.id }),
          ),
        }),
      );
      if (result.listing.id !== change.listingId || result.ownershipKey !== change.ownershipKey)
        throw new Error('Карточка изменилась. Обновите экран');
      return result;
    },
    onSuccess: (result) => {
      attempt.current = null;
      if (allowed.current && Date.parse(result.validUntil) > Date.now()) {
        cache.setQueryData(queryKey, (previous: MarketplaceEditorialState | undefined) =>
          previous?.listing.id === result.listing.id &&
          previous.ownershipKey === result.ownershipKey &&
          previous.revision > result.revision
            ? previous
            : result,
        );
        setDraft(null);
        setNotice('Описание сохранено.');
      }
      void cache.invalidateQueries({
        queryKey: marketplaceQueryKey(profile, entityType, entityId),
      });
      void cache.invalidateQueries({
        queryKey: ['marketplace-entry', profile, entityType, entityId],
      });
      void cache.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
        setDenied(true);
        void cache.cancelQueries({ queryKey });
      } else void query.refetch();
    },
  });
  const canSave =
    readable &&
    sameCard &&
    !conflict &&
    dirty &&
    description.trim().length >= minimum &&
    description.trim().length <= 1500 &&
    !mutation.isPending;
  useEffect(() => {
    // FLAG: A lost reply is resolved only by a newer authorized read of this exact card.
    if (
      mutation.isError &&
      readable &&
      sameCard &&
      draft &&
      state &&
      state.revision > draft.revision &&
      state.listing.description === draft.description.trim()
    ) {
      setDraft(null);
      setNotice('Описание сохранено.');
      attempt.current = null;
      mutation.reset();
    }
  }, [mutation.isError, mutation.reset, readable, sameCard, draft, state]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(mutation.isPending), [mutation.isPending, onBusyChange]);
  useEffect(() => {
    if (resetVersion.current === resetDraftVersion) return;
    resetVersion.current = resetDraftVersion;
    setDraft(null);
    setNotice('');
    attempt.current = null;
    mutation.reset();
    if (allowed.current) void query.refetch();
  }, [resetDraftVersion, mutation.reset, query.refetch]);
  useEffect(() => {
    if (!state?.validUntil) return;
    const delay = Date.parse(state.validUntil) - Date.now();
    // FLAG: An already expired server reply must not start a tight refresh loop.
    if (delay <= 0) return;
    const timer = window.setTimeout(() => {
      updateClock((value) => value + 1);
      if (active && allowed.current) void query.refetch();
    }, delay + 1);
    return () => window.clearTimeout(timer);
  }, [state?.validUntil, active, query.refetch]);
  useEffect(() => {
    if (!canAccess)
      void cache.cancelQueries({
        queryKey: ['marketplace-editorial', profile, entityType, entityId],
      });
  }, [canAccess, cache, profile, entityType, entityId]);
  if (!active) return null;
  const formId = `marketplace-editorial-${profile}-${entityType}-${entityId}`;
  return (
    <div className="marketplace-profile marketplace-editorial" data-marketplace-screen="editorial">
      <div className="marketplace-profile__hero">
        <EntityAvatar
          title={entityTitle || (readable ? state!.listing.title : '') || 'Площадка'}
          entityType={entityType}
          avatarUrl={entityAvatarUrl}
        />
        <div>
          <strong>
            {entityTitle || (readable ? state!.listing.title : '') || 'Карточка площадки'}
          </strong>
          {readable && <small>Ответственный: {state!.responsible.displayName}</small>}
        </div>
      </div>
      {query.isPending && canAccess ? (
        <p role="status">Загружаем описание…</p>
      ) : !readable ? (
        <div role="status" className="marketplace-profile__notice">
          <p>
            {denied || !canAccess
              ? 'Доступ к редактированию не подтверждён.'
              : !fresh && state
                ? 'Проверьте доступ, чтобы сохранить описание.'
                : 'Не удалось загрузить карточку.'}
            {dirty && ' Ваш текст сохранён в форме.'}
          </p>
          <button
            type="button"
            className="button button--ghost"
            disabled={!canAccess || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Проверить снова
          </button>
        </div>
      ) : null}
      {(readable || draft) && (
        <form
          id={formId}
          className="marketplace-profile__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) mutation.mutate();
          }}
        >
          <label className="field">
            <span>Описание площадки</span>
            <textarea
              aria-label="Описание площадки"
              data-marketplace-field="editorial-description"
              value={description}
              maxLength={1500}
              rows={7}
              required
              readOnly={!readable || !sameCard}
              disabled={mutation.isPending}
              onChange={(event) => {
                if (!readable || !state) return;
                onDraftChange();
                setDraft({
                  description: event.target.value,
                  original: draft?.original ?? state.listing.description,
                  revision: draft?.revision ?? state.revision,
                  listingId: draft?.listingId ?? state.listing.id,
                  ownershipKey: draft?.ownershipKey ?? state.ownershipKey,
                });
                setNotice('');
              }}
            />
            <small>
              {description.trim().length} / 1500
              {dirty && description.trim().length < minimum ? ` · минимум ${minimum}` : ''}
            </small>
          </label>
          {readable && !sameCard ? (
            <p role="alert">
              Ответственный или карточка изменились. Ваш текст сохранён. Откройте карточку заново.
            </p>
          ) : readable && conflict ? (
            <div className="marketplace-profile__notice" role="alert">
              <p>Описание изменил другой администратор. Ваш текст сохранён.</p>
              <details>
                <summary>Сохранённое описание</summary>
                <p className="marketplace-editorial__comparison">{state!.listing.description}</p>
              </details>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setDraft(
                    (current) =>
                      current && {
                        ...current,
                        original: state!.listing.description,
                        revision: state!.revision,
                      },
                  );
                  attempt.current = null;
                  mutation.reset();
                }}
              >
                Использовать мой вариант
              </button>
            </div>
          ) : null}
        </form>
      )}
      {mutation.isError && readable && !conflict && (
        <p role="alert">Не удалось сохранить описание. Ваш текст сохранён — повторите попытку.</p>
      )}
      {notice && readable && <p role="status">{notice}</p>}
      {dirty && (
        <MarketplaceEditorActions>
          <button type="submit" form={formId} className="button button--accent" disabled={!canSave}>
            {mutation.isPending ? 'Сохраняем…' : 'Сохранить описание'}
          </button>
        </MarketplaceEditorActions>
      )}
    </div>
  );
}
