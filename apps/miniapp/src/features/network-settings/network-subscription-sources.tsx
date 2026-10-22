import { useEffect, useRef, useState } from 'react';
import { AppIcon } from '../../components/ui/app-icon';
import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS } from '@maxim/contracts/settings-field-schemas';
import type { ManagedEntityHeader } from '@maxim/contracts/managed-entities';
import type { ApiTransport } from '../../lib/api/transport';
import { resolveNetworkRequiredSubscription } from '../../lib/api/network-settings-client';
import { useManagedEntitiesSync } from '../../lib/use-managed-entities-sync';
import { buildRequiredSubscriptionChannelCollections } from '../../pages/settings-required-subscription-state';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { RequiredSubscriptionSourcePicker } from '../../components/required-subscription-source-picker';
import {
  RequiredSubscriptionSourceDisclosure,
  RequiredSubscriptionExternalSource,
} from '../../pages/settings/settings-required-subscription-ui';
import type { ChatSettingsFieldAdapter } from './field-model';
import { canonicalNetworkValue } from './network-settings-controller';
import type { Scope } from './network-settings-metadata-fields';
import './network-subscription-sources.css';
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Не удалось проверить данные. Повторите поиск.';
export function NetworkSubscriptionSources({
  api,
  scope,
  fields,
}: {
  api: ApiTransport;
  scope: Scope;
  fields: ChatSettingsFieldAdapter;
}) {
  const latestFields = useRef(fields);
  latestFields.current = fields;
  const state = fields.read('requiredSubscriptionChannelIds');
  const listKey = canonicalNetworkValue(state);
  const latestListKey = useRef(listKey);
  const listVersion = useRef(0);
  if (latestListKey.current !== listKey) listVersion.current++;
  latestListKey.current = listKey;
  const [authored, setAuthored] = useState(false);
  const [resolvedChannels, setResolvedChannels] = useState<ManagedEntityHeader[]>([]);
  const [refresh, setRefresh] = useState<{ nonce: number; behavior: 'default' | 'manual' }>({
    nonce: 0,
    behavior: 'default',
  });
  const catalogOptions = {
    api,
    enabled: !fields.readOnly,
    reloadNonce: refresh.nonce,
    reloadBehavior: refresh.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  };
  const chats = useManagedEntitiesSync({ ...catalogOptions, entityType: 'chat' });
  const channels = useManagedEntitiesSync({ ...catalogOptions, entityType: 'channel' });

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const items = state.kind === 'common' ? state.value : [];
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: chats.data,
    managedChannels: channels.data,
    resolvedChannels,
    selectedChannelIds: items,
  });
  const catalogLoading = chats.isLoading || channels.isLoading;
  const catalogSyncing = chats.isRefreshing || channels.isRefreshing;
  const catalogError = chats.error ?? channels.error;

  const invalidateLookup = () => {
    generation.current++;
    setBusy(false);
    setError(null);
  };
  const resolve = async (inputValue = value) => {
    const revision = ++generation.current;
    const originalListVersion = listVersion.current;
    const query = inputValue.trim();
    if (!query || fields.readOnly || state.kind === 'loading' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveNetworkRequiredSubscription(api, { ...scope, value: query });
      if (!alive.current || generation.current !== revision) return;
      if (
        result.requestId !== scope.requestId ||
        result.compositionVersion !== scope.compositionVersion
      )
        throw new Error('Состав изменился. Откройте поиск заново.');
      const current = latestFields.current;
      if (current.readOnly) return;
      if (listVersion.current !== originalListVersion)
        throw new Error('Список каналов изменился. Повторите поиск.');
      const currentList = current.read('requiredSubscriptionChannelIds');
      if (currentList.kind === 'loading')
        throw new Error('Настройки ещё загружаются. Повторите добавление.');
      const next = [
        ...new Set([
          ...(currentList.kind === 'common' ? currentList.value : []),
          result.channel.id,
        ]),
      ];
      if (next.length > REQUIRED_SUBSCRIPTION_MAX_CHANNELS)
        throw new Error('Достигнут предел обязательных каналов.');
      setResolvedChannels((old) => [
        ...old.filter((item) => item.id !== result.channel.id),
        result.channel,
      ]);
      current.replaceList('requiredSubscriptionChannelIds', next);
      setValue('');
      setAuthored(true);
    } catch (cause) {
      if (alive.current && generation.current === revision) setError(message(cause));
    } finally {
      if (alive.current && generation.current === revision) setBusy(false);
    }
  };
  const remove = (id: string) => {
    invalidateLookup();
    fields.replaceList(
      'requiredSubscriptionChannelIds',
      items.filter((item) => item !== id),
    );
  };
  return (
    <div
      className="managed-giveaway__section required-subscription__board"
      aria-label="Каналы обязательной подписки"
    >
      <div className="managed-giveaway__title-row">
        <div className="managed-giveaway__section-copy required-subscription__heading">
          <strong>Куда подписаться</strong>
          <small
            className="required-subscription__count"
            data-state={items.length ? 'active' : 'empty'}
            aria-label={`Выбрано источников: ${state.kind === 'mixed' ? 'разные значения' : items.length} из ${REQUIRED_SUBSCRIPTION_MAX_CHANNELS}`}
          >
            {state.kind === 'mixed' ? '—' : items.length}/{REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
          </small>
        </div>
      </div>
      {state.kind === 'mixed' ? (
        <p className="settings-native-toggle__hint">
          Списки каналов различаются. Для замены составьте общий список.
        </p>
      ) : null}
      {state.kind === 'mixed' && !authored ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={fields.readOnly}
          onClick={() => setAuthored(true)}
        >
          Составить общий список каналов
        </button>
      ) : (
        <>
          {items.length === 0 ? (
            <div className="required-subscription__selection-empty">
              <strong>Источники пока не выбраны</strong>
            </div>
          ) : null}
          {collections.selectedChannels.length ? (
            <div className="required-subscription__selection-list">
              {collections.selectedChannels.map((channel) => (
                <div key={channel.id} className="required-subscription__selection-card">
                  <EntityAvatar
                    title={channel.title}
                    entityType={channel.entityType}
                    avatarUrl={channel.avatarUrl}
                    className="required-subscription__selection-avatar"
                  />
                  <div
                    className="required-subscription__selection-body"
                    title={channel.link || channel.title}
                  >
                    <strong className="required-subscription__selection-title">
                      {channel.title}
                    </strong>
                    <div className="required-subscription__selection-meta">
                      <span className="required-subscription__selection-kind">
                        {channel.entityType === 'chat' ? 'Чат' : 'Канал'}
                      </span>
                      {channel.link ? (
                        <span className="required-subscription__selection-link">
                          {channel.link.replace(/^https?:\/\//u, '')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="required-subscription__selection-remove"
                    disabled={fields.readOnly}
                    onClick={() => remove(channel.id)}
                    aria-label={`Удалить ${channel.entityType === 'chat' ? 'чат' : 'канал'} ${channel.title}`}
                  >
                    <AppIcon
                      icon="Trash"
                      width="1.5em"
                      height="1.5em"
                      style={{ strokeWidth: 1.5 }}
                      aria-hidden
                    />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {collections.selectedUnavailableChannels.length ? (
            <div className="required-subscription__selection-list">
              {collections.selectedUnavailableChannels.map((channel, index) => (
                <div key={channel.id} className="required-subscription__selection-card is-warning">
                  <span className="required-subscription__selection-rank">
                    {collections.selectedChannels.length + index + 1}
                  </span>
                  <div className="required-subscription__selection-body">
                    <strong className="required-subscription__selection-title">
                      Сохранённый источник
                    </strong>
                    <small className="required-subscription__selection-detail">
                      {channel.description} ID: {channel.id}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="required-subscription__selection-remove"
                    disabled={fields.readOnly}
                    onClick={() => remove(channel.id)}
                    aria-label={`Удалить сохранённый источник ${index + 1}`}
                  >
                    <AppIcon
                      icon="Trash"
                      width="1.5em"
                      height="1.5em"
                      style={{ strokeWidth: 1.5 }}
                      aria-hidden
                    />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <RequiredSubscriptionSourceDisclosure initiallyOpen={items.length === 0}>
            <RequiredSubscriptionSourcePicker
              choices={collections.availableChoices}
              selectedCount={items.length}
              maxSelectedCount={REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
              loading={catalogLoading}
              syncing={catalogSyncing || busy}
              disabled={fields.readOnly || busy || state.kind === 'loading'}
              error={catalogError ? message(catalogError) : null}
              backoffActive={chats.isBackoffActive || channels.isBackoffActive}
              emptyState="Добавьте чат или канал по ссылке ниже."
              onAdd={(id) => {
                const choice = collections.availableChoices.find((item) => item.id === id);
                if (choice && !busy && !fields.readOnly) void resolve(choice.link || choice.id);
              }}
              onRefresh={() => setRefresh((old) => ({ nonce: old.nonce + 1, behavior: 'manual' }))}
            />
            <RequiredSubscriptionExternalSource
              value={value}
              error={error ?? ''}
              loading={busy || fields.readOnly}
              limitReached={items.length >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
              onChange={(next) => {
                invalidateLookup();
                setValue(next);
              }}
              onSubmit={() => void resolve()}
            />
          </RequiredSubscriptionSourceDisclosure>
        </>
      )}
      <div className="managed-giveaway__section-actions">
        <button
          type="button"
          className="button button--ghost"
          disabled={fields.readOnly || state.kind === 'loading'}
          onClick={() => {
            invalidateLookup();
            fields.replaceList('requiredSubscriptionChannelIds', []);
            setAuthored(true);
          }}
        >
          Очистить обязательные каналы у выбранных
        </button>
        {fields.isDirty('requiredSubscriptionChannelIds') ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={fields.readOnly}
            onClick={() => {
              invalidateLookup();
              fields.revert('requiredSubscriptionChannelIds');
              setAuthored(false);
            }}
          >
            Отменить изменение списка
          </button>
        ) : null}
      </div>
      {fields.error('requiredSubscriptionChannelIds') ? (
        <small className="field__hint" role="alert">
          {fields.error('requiredSubscriptionChannelIds')}
        </small>
      ) : null}
    </div>
  );
}
