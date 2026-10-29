import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  marketplaceButtonPolicyStateSchema,
  marketplaceButtonCaptionSchema,
  type MarketplaceButtonModule,
  type MarketplaceButtonPolicyMutation,
  marketplaceButtonPolicyMutationSchema,
  type MarketplaceButtonContext,
  type MarketplaceButtonPolicyState,
} from '@maxim/contracts/marketplace-integration';
import { ApiRequestError } from '../lib/api-request-error';
import {
  marketplaceButtonLabels,
  marketplaceModuleLabels,
  marketplaceButtonStatus,
  marketplaceEntityPath,
  mergeMarketplaceButtonPolicy,
} from '../lib/marketplace-button-policy';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';
import { MarketplaceEditorActions } from './marketplace-editor-actions';

type WithoutRequest<T> = T extends unknown ? Omit<T, 'requestId'> : never;
type PolicyChange = WithoutRequest<MarketplaceButtonPolicyMutation>;
type PolicyFailure = {
  change: PolicyChange;
  reason: 'conflict' | 'access' | 'unconfirmed';
};

export default function MarketplaceButtonPolicy({
  api,
  entityId,
  entityType,
  profile,
  canEnable,
  onBusyChange,
  enableUnavailableReason,
  onRecheckProfile,
  recheckingProfile = false,
  module,
  onDirtyChange,
  active = true,
  resetDraftVersion = 0,
  onDraftChange,
  onOpenProfile,
}: MarketplaceProfileCardProps & {
  canEnable: boolean;
  onBusyChange: (value: boolean) => void;
  enableUnavailableReason?: string;
  onRecheckProfile?: () => void;
  recheckingProfile?: boolean;
  module?: MarketplaceButtonModule;
  onDirtyChange?: (dirty: boolean) => void;
  active?: boolean;
  resetDraftVersion?: number;
  onDraftChange?: () => void;
  onOpenProfile?: () => void;
}) {
  const cache = useQueryClient();
  const queryKey = ['marketplace-button-policy', profile, entityType, entityId];
  const path = marketplaceEntityPath(profile, entityType, entityId, 'button-policy');
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const writing = useRef(false);
  const [failure, setFailure] = useState<PolicyFailure | null>(null);
  const [captionDraft, setCaptionDraft] = useState<{ value: string; revision: number } | null>(
    null,
  );
  const [expandedGroups, setExpandedGroups] = useState<
    Partial<Record<MarketplaceButtonContext, boolean>>
  >({});
  const [savedGroup, setSavedGroup] = useState<MarketplaceButtonContext | null>(null);
  const [captionSaved, setCaptionSaved] = useState(false);
  const [captionReadRequired, setCaptionReadRequired] = useState(false);
  const captionReadBaseline = useRef(0);
  const previousResetDraftVersion = useRef(resetDraftVersion);
  const formId = useId();
  useEffect(() => {
    if (!savedGroup) return;
    const timer = window.setTimeout(() => setSavedGroup(null), 2500);
    return () => window.clearTimeout(timer);
  }, [savedGroup]);
  useEffect(() => {
    if (!captionSaved) return;
    const timer = window.setTimeout(() => setCaptionSaved(false), 2500);
    return () => window.clearTimeout(timer);
  }, [captionSaved]);
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      mergeMarketplaceButtonPolicy(
        marketplaceButtonPolicyStateSchema.parse(await api.request(path)),
        cache.getQueryData<MarketplaceButtonPolicyState>(queryKey),
      ),
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) =>
      q.state.error instanceof ApiRequestError && q.state.error.status === 403 ? false : 60_000,
  });
  const mutation = useMutation({
    mutationFn: async (change: PolicyChange) => {
      const fingerprint = JSON.stringify(change);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      const input = marketplaceButtonPolicyMutationSchema.parse({
        ...change,
        requestId: attempt.current.id,
      });
      return marketplaceButtonPolicyStateSchema.parse(
        await api.request(path, { method: 'POST', body: JSON.stringify(input) }),
      );
    },
    onMutate: () => {
      setFailure(null);
      setSavedGroup(null);
      setCaptionSaved(false);
    },
    onSuccess: (result, change) => {
      cache.setQueryData(queryKey, (previous: MarketplaceButtonPolicyState | undefined) =>
        mergeMarketplaceButtonPolicy(result, previous),
      );
      attempt.current = null;
      setFailure(null);
      if ('caption' in change) {
        setCaptionDraft(null);
        setCaptionSaved(true);
      } else setSavedGroup(change.context);
      void cache.invalidateQueries({ queryKey: ['marketplace-button-policy'] });
    },
    onError: async (error, change) => {
      setFailure({
        change,
        reason:
          error instanceof ApiRequestError && error.status === 409
            ? 'conflict'
            : error instanceof ApiRequestError && [401, 403].includes(error.status)
              ? 'access'
              : 'unconfirmed',
      });
      // FLAG: A lost response does not establish whether the write committed. Keep
      // its idempotency key and reread before allowing another choice.
      await cache.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      writing.current = false;
    },
  });
  const refreshPolicy = () => {
    const resetVersion = previousResetDraftVersion.current;
    void query.refetch().then((result) => {
      if (
        resetVersion === previousResetDraftVersion.current &&
        result.isSuccess &&
        !result.isFetching
      )
        setCaptionReadRequired(false);
    });
  };
  useEffect(() => {
    if (resetDraftVersion <= previousResetDraftVersion.current) return;
    previousResetDraftVersion.current = resetDraftVersion;
    setCaptionDraft(null);
    setCaptionSaved(false);
    // FLAG: Explicit discard retires only the caption retry. A lost response may
    // still commit, so require a fresh read before another caption write. Keep
    // independent consent failures and their idempotency keys intact.
    if (!failure || !('caption' in failure.change)) return;
    const reread = failure.reason === 'unconfirmed';
    attempt.current = null;
    setFailure(null);
    mutation.reset();
    if (!reread) return;
    captionReadBaseline.current = query.dataUpdatedAt;
    setCaptionReadRequired(true);
    void query.refetch().then((result) => {
      if (
        resetDraftVersion === previousResetDraftVersion.current &&
        result.isSuccess &&
        !result.isFetching
      )
        setCaptionReadRequired(false);
    });
  }, [resetDraftVersion, failure, mutation.reset, query.dataUpdatedAt, query.refetch]);
  useEffect(() => {
    if (
      captionReadRequired &&
      query.isSuccess &&
      !query.isFetching &&
      query.dataUpdatedAt !== captionReadBaseline.current
    )
      setCaptionReadRequired(false);
  }, [captionReadRequired, query.isSuccess, query.isFetching, query.dataUpdatedAt]);
  useEffect(() => {
    onBusyChange(mutation.isPending);
  }, [mutation.isPending, onBusyChange]);
  const accessDenied =
    query.error instanceof ApiRequestError && [401, 403].includes(query.error.status);
  const changedContext =
    failure && 'context' in failure.change
      ? query.data?.contexts.find(
          (item) =>
            item.context ===
            (failure.change as Extract<PolicyChange, { context: MarketplaceButtonContext }>)
              .context,
        )
      : undefined;
  const reconciled =
    failure?.reason === 'unconfirmed' &&
    !query.isError &&
    !!query.data &&
    ('caption' in failure.change
      ? query.data.captionRevision > failure.change.expectedCaptionRevision &&
        query.data.caption === failure.change.caption
      : query.data.revision > failure.change.expectedRevision &&
        (failure.change.module
          ? changedContext?.modules.some(
              (item) =>
                item.module ===
                  (failure.change as Extract<PolicyChange, { context: MarketplaceButtonContext }>)
                    .module &&
                item.enabled ===
                  (failure.change as Extract<PolicyChange, { context: MarketplaceButtonContext }>)
                    .enabled &&
                !item.needsConfirmation,
            )
          : changedContext?.enabled === failure.change.enabled &&
            !changedContext?.partial &&
            (!failure.change.enabled || changedContext.status !== 'CONFIRM_REQUIRED')));
  // FLAG: Once a reread confirms an uncertain write, retire that attempt.
  // A later permission change must not resurrect its already-resolved error.
  useEffect(() => {
    if (!reconciled) return;
    if (failure && 'caption' in failure.change) {
      setCaptionDraft(null);
      setCaptionSaved(true);
    } else if (failure && 'context' in failure.change) setSavedGroup(failure.change.context);
    attempt.current = null;
    setFailure(null);
  }, [reconciled, failure]);
  const showFailure = !!failure && !reconciled && !mutation.isPending;
  const uncertain = showFailure && failure.reason === 'unconfirmed';
  const caption = captionDraft?.value ?? query.data?.caption ?? '';
  const dirty = !!captionDraft && captionDraft.value !== query.data?.caption;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const submit = (change: PolicyChange) => {
    if (writing.current || accessDenied) return;
    writing.current = true;
    mutation.mutate(change);
  };
  const change = (
    context: MarketplaceButtonContext,
    enabled: boolean,
    selectedModule?: MarketplaceButtonModule,
    reconfirm = false,
  ) => {
    if (
      !query.data ||
      (uncertain && enabled && !reconfirm) ||
      (enabled && (!canEnable || query.isError))
    )
      return;
    submit({ context, enabled, module: selectedModule, expectedRevision: query.data.revision });
  };
  const contextLabel = (context: MarketplaceButtonContext) =>
    context === 'PUBLICATIONS' && profile === 'publisher'
      ? 'В публикациях Публика'
      : marketplaceButtonLabels[context];
  return (
    <section className="marketplace-button-policy" aria-label="Кнопка в сообщениях">
      {query.isPending && <p role="status">Проверяем настройки кнопки…</p>}
      {!module && query.data && (
        <form
          id={formId}
          className="marketplace-button-policy__caption"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = marketplaceButtonCaptionSchema.safeParse(caption);
            if (parsed.success && dirty && !uncertain && !captionReadRequired)
              submit({
                caption: parsed.data,
                expectedCaptionRevision:
                  failure?.reason === 'conflict' && !query.isError && !query.isFetching
                    ? query.data!.captionRevision
                    : (captionDraft?.revision ?? query.data!.captionRevision),
              });
          }}
        >
          <label>
            Текст кнопки
            <input
              aria-label="Текст рекламной кнопки"
              data-marketplace-field="button-caption"
              value={caption}
              maxLength={48}
              disabled={mutation.isPending || accessDenied || uncertain || captionReadRequired}
              onChange={(event) => {
                setCaptionSaved(false);
                setCaptionDraft({
                  value: event.target.value,
                  revision: captionDraft?.revision ?? query.data!.captionRevision,
                });
                onDraftChange?.();
              }}
            />
          </label>
          <div
            className="marketplace-button-policy__preview"
            role="group"
            aria-label="Предпросмотр кнопки"
          >
            <div className="marketplace-button-policy__sample">{caption}</div>
            <p className="marketplace-profile-card__intro">Для новых сообщений</p>
            {captionSaved && <p role="status">Текст сохранён</p>}
          </div>
          {dirty && active && (
            <MarketplaceEditorActions>
              <div className="marketplace-profile__actions">
                <button
                  type="submit"
                  form={formId}
                  className="button button--accent"
                  disabled={
                    mutation.isPending ||
                    accessDenied ||
                    uncertain ||
                    captionReadRequired ||
                    !marketplaceButtonCaptionSchema.safeParse(caption).success
                  }
                >
                  {mutation.isPending && 'caption' in (mutation.variables ?? {})
                    ? 'Сохраняем…'
                    : 'Сохранить текст'}
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={mutation.isPending || uncertain}
                  onClick={() => setCaptionDraft(null)}
                >
                  Отмена
                </button>
              </div>
            </MarketplaceEditorActions>
          )}
        </form>
      )}
      <div className="marketplace-button-policy__choices">
        {query.data?.contexts
          .filter((item) => !module || item.modules.some((child) => child.module === module))
          .map((group) => {
            const child = module ? group.modules.find((item) => item.module === module) : undefined;
            const item = child
              ? {
                  ...group,
                  ...child,
                  partial: false,
                  status: child.needsConfirmation
                    ? ('CONFIRM_REQUIRED' as const)
                    : child.effective
                      ? ('READY' as const)
                      : child.enabled
                        ? group.status
                        : ('OFF' as const),
                }
              : group;
            const label = module ? 'Кнопка рекламы' : contextLabel(item.context);
            const saving =
              mutation.isPending &&
              mutation.variables &&
              'context' in mutation.variables &&
              mutation.variables.context === item.context;
            const modulesId = `${formId}-${item.context}-modules`;
            return (
              <div className="marketplace-button-policy__group" key={item.context}>
                <label className="marketplace-profile__toggle">
                  <span>
                    <strong>{label}</strong>
                    {item.partial && (
                      <small>
                        Включено {item.modules.filter((child) => child.enabled).length} из{' '}
                        {item.modules.length}
                      </small>
                    )}
                    {marketplaceButtonStatus[item.status] && (
                      <small>{marketplaceButtonStatus[item.status]}</small>
                    )}
                  </span>
                  <span className="marketplace-profile__switch">
                    <input
                      type="checkbox"
                      aria-label={label}
                      aria-checked={item.partial ? 'mixed' : item.enabled}
                      ref={(node) => {
                        if (node) node.indeterminate = item.partial;
                      }}
                      checked={item.enabled && !item.partial}
                      disabled={
                        mutation.isPending ||
                        (uncertain && !item.enabled) ||
                        accessDenied ||
                        (!item.enabled && (!canEnable || query.isError))
                      }
                      onChange={(event) => change(item.context, event.target.checked, module)}
                    />
                    <span className="marketplace-profile__track" aria-hidden />
                  </span>
                </label>
                <p className="marketplace-button-policy__group-feedback" role="status">
                  {saving ? 'Сохраняем…' : savedGroup === item.context ? 'Сохранено' : ''}
                </p>
                {item.enabled && item.status === 'CONFIRM_REQUIRED' && (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={mutation.isPending || !canEnable || query.isError}
                    onClick={() => change(item.context, true, module, true)}
                  >
                    Подтвердить включение
                  </button>
                )}
                {item.partial && (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={mutation.isPending || accessDenied}
                    onClick={() => change(item.context, false)}
                  >
                    Выключить все
                  </button>
                )}
                {!module && item.modules.length > 1 && (
                  <button
                    type="button"
                    className="button button--ghost marketplace-button-policy__group-disclosure"
                    aria-expanded={!!expandedGroups[item.context]}
                    aria-controls={modulesId}
                    onClick={() =>
                      setExpandedGroups((current) => ({
                        ...current,
                        [item.context]: !current[item.context],
                      }))
                    }
                  >
                    По модулям
                  </button>
                )}
                {!module && item.modules.length > 1 && (
                  <div
                    className="marketplace-button-policy__modules"
                    id={modulesId}
                    hidden={!expandedGroups[item.context]}
                  >
                    {item.modules.map((child) => (
                      <label className="marketplace-profile__toggle" key={child.module}>
                        <span>{marketplaceModuleLabels[child.module]}</span>
                        <span className="marketplace-profile__switch">
                          <input
                            type="checkbox"
                            aria-label={marketplaceModuleLabels[child.module]}
                            checked={child.enabled}
                            disabled={
                              mutation.isPending ||
                              (uncertain && !child.enabled) ||
                              accessDenied ||
                              (!child.enabled && (!canEnable || query.isError))
                            }
                            onChange={(event) =>
                              change(item.context, event.target.checked, child.module)
                            }
                          />
                          <span className="marketplace-profile__track" aria-hidden />
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
      {uncertain && (
        <button
          type="button"
          className="button button--ghost"
          disabled={mutation.isPending || accessDenied}
          onClick={() => submit(failure.change)}
        >
          Повторить сохранение
        </button>
      )}
      {mutation.isPending && mutation.variables && 'caption' in mutation.variables && (
        <p role="status">{failure ? 'Проверяем сохранение…' : 'Сохраняем…'}</p>
      )}
      {!canEnable && !query.isPending && (
        <div>
          <p className="marketplace-profile-card__intro">
            {enableUnavailableReason ?? 'Для кнопки нужен опубликованный профиль.'}
          </p>
          {enableUnavailableReason && onRecheckProfile && (
            <button
              type="button"
              className="button button--ghost"
              disabled={recheckingProfile}
              onClick={onRecheckProfile}
            >
              Проверить профиль
            </button>
          )}
          {!module && !enableUnavailableReason && onOpenProfile && (
            <button
              type="button"
              className="button button--ghost"
              disabled={mutation.isPending || accessDenied}
              onClick={onOpenProfile}
            >
              Настроить профиль
            </button>
          )}
        </div>
      )}
      {query.data?.buttonDiagnostic === 'KEYBOARD_FULL' && (
        <p role="status">Под сообщением нет места для ещё одной кнопки.</p>
      )}
      {showFailure && failure.reason === 'conflict' && 'caption' in failure.change && (
        <p>Сейчас сохранено: «{query.data?.caption}»</p>
      )}
      {showFailure && (
        <p role="alert">
          {failure.reason === 'conflict'
            ? 'Настройки изменил другой администратор. Проверьте их и повторите выбор.'
            : failure.reason === 'access'
              ? 'Доступ к настройкам не подтверждён. Проверьте права администратора.'
              : 'Сохранение не подтверждено. Проверьте настройки и повторите.'}
        </p>
      )}
      {query.isError && !showFailure && !mutation.isPending && (
        <p role="alert">
          {accessDenied
            ? 'Доступ к настройкам не подтверждён. Проверьте права администратора.'
            : 'Не удалось обновить настройки кнопки.'}
        </p>
      )}
      {(query.isError || showFailure || captionReadRequired) && !mutation.isPending && (
        <button
          className="button button--ghost"
          disabled={query.isFetching || mutation.isPending}
          onClick={refreshPolicy}
        >
          Проверить настройки
        </button>
      )}
    </section>
  );
}
