import { NavArrowRight } from 'iconoir-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  NetworkNavigationAllowlistIntent,
  NetworkSettingsReadResponse,
} from '@maxim/contracts/network-settings';
import { networkNavigationAllowlistIntentSchema } from '@maxim/contracts/network-settings-read';
import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS } from '@maxim/contracts/settings-field-schemas';
import {
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
  type NavigationAllowlistKind,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import { getAdminContactLabel } from '../../lib/admin-contact-profile-url';
import {
  readNetworkAdminContacts,
  resolveNetworkAdminContact,
  resolveNetworkRequiredSubscription,
  readNetworkNavigationAllowlist,
} from '../../lib/api/network-settings-client';
import type { SharedChatSettingsContext } from '../../pages/settings/shared-chat-settings-section';
import type {
  ChatSettingsFieldAdapter,
  ChatScalarFieldPath,
  SettingsFieldState,
} from './field-model';
import { FieldText, FieldToggle } from './settings-field-controls';
import { canonicalNetworkValue } from './network-settings-controller';
type Scope = {
  entityType: 'chat';
  target: NetworkSettingsReadResponse['target'];
  section: NetworkSettingsReadResponse['section'];
  compositionVersion: string;
  requestId: string;
};
type Props = {
  api: ApiTransport;
  scopeId: string;
  read: NetworkSettingsReadResponse;
  fields: ChatSettingsFieldAdapter;
  navigationAllowlist?: NetworkNavigationAllowlistIntent;
  onNavigationAllowlist: (intent: NetworkNavigationAllowlistIntent | undefined) => void;
  children: (context: SharedChatSettingsContext) => ReactNode;
};
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Не удалось проверить данные. Повторите поиск.';
export function NetworkSettingsMetadataFields(props: Props) {
  const key = canonicalNetworkValue({
    scopeId: props.scopeId,
    type: props.read.entityType,
    section: props.read.section,
    target: props.read.target,
    version: props.read.compositionVersion,
  });
  const scope = useMemo<Scope>(
    () => ({
      entityType: 'chat',
      target: props.read.target,
      section: props.read.section,
      compositionVersion: props.read.compositionVersion,
      requestId: crypto.randomUUID(),
    }),
    [key],
  );
  const context: SharedChatSettingsContext = {
    mode: 'network',
    api: props.api,
    navigationAllowlist:
      props.read.section === 'links' ? <Allowlist key={key} {...props} scope={scope} /> : undefined,
    requiredSubscriptionSources:
      props.read.section === 'requiredSubscription' ? (
        <SubscriptionSources key={key} api={props.api} scope={scope} fields={props.fields} />
      ) : undefined,
    renderAdminContact: (input) => (
      <AdminContact
        key={key + input.urlPath}
        api={props.api}
        scope={scope}
        fields={props.fields}
        recipients={props.read.recipients}
        {...input}
      />
    ),
    invitationActivationAvailable: false,
  };
  return <>{props.children(context)}</>;
}
function SubscriptionSources({
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
  const invalidateLookup = () => {
    generation.current++;
    setBusy(false);
    setError(null);
  };
  const resolve = async () => {
    const revision = ++generation.current;
    const originalListVersion = listVersion.current;
    const query = value.trim();
    if (!query || fields.readOnly) return;
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
      const next = [
        ...new Set([
          ...(currentList.kind === 'common' ? currentList.value : []),
          result.channel.id,
        ]),
      ];
      if (next.length > REQUIRED_SUBSCRIPTION_MAX_CHANNELS)
        throw new Error('Достигнут предел обязательных каналов.');
      current.replaceList('requiredSubscriptionChannelIds', next);
      setValue('');
      setAuthored(true);
    } catch (cause) {
      if (alive.current && generation.current === revision) setError(message(cause));
    } finally {
      if (alive.current && generation.current === revision) setBusy(false);
    }
  };
  return (
    <section className="network-settings-metadata" aria-label="Каналы обязательной подписки">
      <p>
        {state.kind === 'mixed'
          ? 'Списки каналов различаются. Для замены составьте общий список.'
          : 'Обязательных каналов: ' + items.length}
      </p>
      {state.kind === 'mixed' && !authored ? (
        <button type="button" disabled={fields.readOnly} onClick={() => setAuthored(true)}>
          Составить общий список каналов
        </button>
      ) : (
        <>
          <ul>
            {items.map((id) => (
              <li key={id}>
                <span>Канал · {id}</span>
                <button
                  type="button"
                  disabled={fields.readOnly}
                  onClick={() => {
                    invalidateLookup();
                    fields.replaceList(
                      'requiredSubscriptionChannelIds',
                      items.filter((item) => item !== id),
                    );
                  }}
                >
                  Убрать из общего списка
                </button>
              </li>
            ))}
          </ul>
          <label>
            Ссылка или ID чата/канала
            <input
              value={value}
              disabled={fields.readOnly || busy}
              onChange={(event) => {
                generation.current++;
                setBusy(false);
                setValue(event.target.value);
                setError(null);
              }}
            />
          </label>
          <button
            type="button"
            disabled={fields.readOnly || busy || !value.trim()}
            onClick={() => void resolve()}
          >
            {busy ? 'Проверяем канал…' : 'Проверить и добавить'}
          </button>
        </>
      )}
      <button
        type="button"
        disabled={fields.readOnly}
        onClick={() => {
          invalidateLookup();
          fields.replaceList('requiredSubscriptionChannelIds', []);
        }}
      >
        Очистить обязательные каналы у выбранных
      </button>
      {fields.isDirty('requiredSubscriptionChannelIds') ? (
        <button
          type="button"
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
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
type Contact = Awaited<ReturnType<typeof readNetworkAdminContacts>>['items'][number];
function AdminContact({
  api,
  scope,
  fields,
  recipients,
  enabledPath,
  urlPath,
  label,
  ariaLabel = label,
  presentation,
}: {
  api: ApiTransport;
  scope: Scope;
  fields: ChatSettingsFieldAdapter;
  recipients: NetworkSettingsReadResponse['recipients'];
  enabledPath: ChatScalarFieldPath;
  urlPath: ChatScalarFieldPath;
  label: string;
  ariaLabel?: string;
  presentation?: 'rules';
}) {
  const latestFields = useRef(fields);
  latestFields.current = fields;
  const enabled = fields.read(enabledPath) as SettingsFieldState<boolean>;
  const url = fields.read(urlPath) as SettingsFieldState<string>;
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (toggle.current) toggle.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  const contactLabel =
    url.kind === 'mixed'
      ? 'Разные администраторы'
      : url.kind === 'loading'
        ? 'Загрузка…'
        : url.value
          ? getAdminContactLabel(url.value)
          : 'Администратор не выбран';
  const enabledSummary =
    enabled.kind === 'mixed'
      ? 'Разные значения'
      : enabled.kind === 'loading'
        ? 'Загрузка…'
        : enabled.value
          ? 'Включено'
          : 'Выключено';
  const urlKey = canonicalNetworkValue(url);
  const latestUrlKey = useRef(urlKey);
  const urlVersion = useRef(0);
  if (latestUrlKey.current !== urlKey) urlVersion.current++;
  latestUrlKey.current = urlKey;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Contact[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    scanned: number;
    total: number;
    incomplete: number;
    unavailable: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const load = async () => {
    if (fields.readOnly || busy) return;
    const revision = ++generation.current;
    setBusy(true);
    setError(null);
    setOpen(true);
    try {
      const result = await readNetworkAdminContacts(api, {
        ...scope,
        ...(cursor ? { cursor } : {}),
      });
      if (generation.current !== revision) return;
      if (
        result.requestId !== scope.requestId ||
        result.compositionVersion !== scope.compositionVersion
      )
        throw new Error('Состав изменился. Откройте выбор заново.');
      setItems((old) => [
        ...new Map([...old, ...result.items].map((item) => [item.userId, item])).values(),
      ]);
      setSessionId(result.sessionId);
      setCursor(result.nextCursor);
      setProgress({
        scanned: result.scannedSources,
        total: result.totalSources,
        incomplete: result.incompleteSources.length,
        unavailable: result.unavailableSources.length,
      });
    } catch (cause) {
      if (generation.current === revision) setError(message(cause));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const choose = async (contact: Contact, sourceEntityId: string) => {
    if (!sessionId || busy || fields.readOnly) return;
    const revision = ++generation.current;
    const originalUrlVersion = urlVersion.current;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveNetworkAdminContact(api, {
        ...scope,
        cursor: sessionId,
        sourceEntityId,
        userId: contact.userId,
      });
      if (generation.current !== revision) return;
      if (
        result.requestId !== scope.requestId ||
        result.compositionVersion !== scope.compositionVersion ||
        result.contact.userId !== contact.userId
      )
        throw new Error('Выбор изменился. Откройте его заново.');
      const current = latestFields.current;
      if (current.readOnly) return;
      if (urlVersion.current !== originalUrlVersion)
        throw new Error('Ссылка изменена. Выберите администратора заново.');
      current.setScalar(urlPath, result.contact.url as never);
      setOpen(false);
    } catch (cause) {
      if (generation.current === revision) setError(message(cause));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const urlField = (
    <FieldText
      label="Ссылка для связи с администратором"
      state={url}
      onChange={(value) => fields.setScalar(urlPath, value as never)}
      onError={(value) => fields.setError(urlPath, value)}
      error={fields.error(urlPath)}
      disabled={fields.readOnly}
    />
  );
  return (
    <section
      className={
        presentation === 'rules'
          ? 'settings-native-toggle rules-native-card'
          : 'network-settings-metadata'
      }
    >
      {presentation === 'rules' ? (
        <>
          <div className="settings-native-toggle__row">
            <div className="settings-native-toggle__title-wrap">
              <div className="rules-native-card__copy">
                <span className="settings-native-toggle__title">{label}</span>
                <span className="rules-native-card__meta">{enabledSummary}</span>
              </div>
            </div>
            <label className="settings-native-switch" aria-label={ariaLabel}>
              <input
                ref={toggle}
                type="checkbox"
                checked={enabled.kind === 'common' && enabled.value}
                aria-checked={
                  enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value
                }
                disabled={fields.readOnly || enabled.kind === 'loading'}
                onChange={(event) => fields.setScalar(enabledPath, event.target.checked as never)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>
          {enabled.kind === 'mixed' || (enabled.kind === 'common' && enabled.value) ? (
            <button
              type="button"
              className="admin-contact-selection"
              disabled={fields.readOnly || busy || url.kind === 'loading'}
              onClick={() => void load()}
              aria-label={`Выбрать администратора: ${contactLabel}`}
              aria-haspopup="dialog"
            >
              <span>{contactLabel}</span>
              <NavArrowRight aria-hidden />
            </button>
          ) : null}
        </>
      ) : (
        <>
          <FieldToggle
            label={label}
            state={enabled}
            onChange={(value) => fields.setScalar(enabledPath, value as never)}
            disabled={fields.readOnly}
          />
          {urlField}
          <button type="button" disabled={fields.readOnly || busy} onClick={() => void load()}>
            Выбрать администратора сетки
          </button>
        </>
      )}
      {open ? (
        <div className="network-settings-metadata__picker">
          {presentation === 'rules' ? urlField : null}
          <p>
            Показываем подтверждённых администраторов выбранных чатов. Список может быть неполным.
          </p>
          {progress ? (
            <p>
              Проверено чатов: {progress.scanned} из {progress.total}. Неполные ответы:{' '}
              {progress.incomplete}; недоступно: {progress.unavailable}.
            </p>
          ) : null}
          <ul>
            {items.map((item) => (
              <li key={item.userId}>
                <strong>{item.displayName ?? 'Администратор'}</strong>
                {item.sources.map((source) => (
                  <button
                    type="button"
                    key={source}
                    disabled={fields.readOnly || busy}
                    onClick={() => void choose(item, source)}
                  >
                    Выбрать ·{' '}
                    {recipients.find((recipient) => recipient.entityId === source)?.title ||
                      'Подтверждённый чат'}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          {cursor ? (
            <button type="button" disabled={fields.readOnly || busy} onClick={() => void load()}>
              Проверить следующие чаты
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              generation.current++;
              setBusy(false);
              setOpen(false);
            }}
          >
            Закрыть выбор
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
const KINDS: Record<NavigationAllowlistKind, string> = {
  WEB_EXACT: 'Точная веб-ссылка',
  WEB_DOMAIN: 'Веб-домен',
  MAX_PROFILE: 'Профиль MAX',
  MAX_ENTITY: 'Чат или канал MAX',
  MINI_APP: 'Мини-приложение',
};
function Allowlist({
  api,
  read,
  fields,
  scope,
  navigationAllowlist,
  onNavigationAllowlist,
}: Props & { scope: Scope }) {
  const [entityId, setEntityId] = useState(read.recipients[0]?.entityId ?? '');
  const selectedEntityId = useId();
  const selectedEntity = read.recipients.find((recipient) => recipient.entityId === entityId);
  const [entries, setEntries] = useState<
    Awaited<ReturnType<typeof readNetworkNavigationAllowlist>>['entries']
  >([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<NavigationAllowlistKind>('WEB_DOMAIN');
  const [expiry, setExpiry] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const load = async () => {
    const revision = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await readNetworkNavigationAllowlist(api, {
        ...scope,
        entityId,
        ...(cursor ? { cursor } : {}),
      });
      if (generation.current !== revision) return;
      if (result.entityId !== entityId || result.compositionVersion !== scope.compositionVersion)
        throw new Error('Состав изменился. Загрузите список заново.');
      setEntries((old) => (cursor ? [...old, ...result.entries] : result.entries));
      setCursor(result.nextCursor);
      setTotal(result.totalEntries);
      setLoaded(true);
    } catch (cause) {
      if (generation.current === revision) setError(message(cause));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const author = (op: 'add' | 'remove' | 'setExpiry' | 'replace') => {
    try {
      const removeAfterAt = expiry ? new Date(expiry).toISOString() : null;
      const stored = normalizeStoredAllowlistEntry(value, kind);
      const normalized = stored ? parseStoredAllowlistEntry(stored) : null;
      if (!normalized) throw new Error('Укажите корректную ссылку выбранного вида.');
      const target = { value: normalized.target, kind };
      const next =
        op === 'replace'
          ? {
              mode: 'replace',
              entries: [
                ...(navigationAllowlist?.mode === 'replace' ? navigationAllowlist.entries : []),
                { ...target, removeAfterAt },
              ],
            }
          : {
              mode: 'edit',
              actions: [
                ...(navigationAllowlist?.mode === 'edit' ? navigationAllowlist.actions : []),
                op === 'remove' ? { op, target } : { op, target, removeAfterAt },
              ],
            };
      onNavigationAllowlist(networkNavigationAllowlistIntentSchema.parse(next));
      setValue('');
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <section className="network-settings-metadata" aria-label="Разрешённые ссылки">
      <h3>Разрешённые ссылки</h3>
      <p>
        Добавление и удаление сохраняют остальные записи каждого чата. Полная замена задаёт
        одинаковый список всем получателям.
      </p>
      <label>
        Просмотреть сохранённый список
        <select
          value={entityId}
          aria-describedby={selectedEntityId}
          disabled={busy}
          onChange={(event) => {
            generation.current++;
            setBusy(false);
            setEntityId(event.target.value);
            setEntries([]);
            setCursor(null);
            setLoaded(false);
            setError(null);
          }}
        >
          {read.recipients.map((row) => (
            <option key={row.entityId} value={row.entityId}>
              {row.title}
            </option>
          ))}
        </select>
      </label>
      <p id={selectedEntityId} className="network-settings-metadata__selected">
        Выбранный чат: <strong>{selectedEntity?.title || 'Чат'}</strong>
      </p>
      <button type="button" disabled={busy || !entityId} onClick={() => void load()}>
        {cursor ? 'Загрузить следующие записи' : loaded ? 'Обновить список' : 'Показать список'}
      </button>
      {loaded ? (
        <>
          <p>
            Записей: {total}. Загружено: {entries.length}.
          </p>
          <ul>
            {entries.map((entry) => (
              <li key={entry.kind + entry.value}>
                {KINDS[entry.kind]} · {entry.value} ·{' '}
                {entry.removeAfterAt
                  ? 'до ' + new Date(entry.removeAfterAt).toLocaleString('ru-RU')
                  : 'без срока'}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <label>
        Вид ссылки
        <select
          value={kind}
          disabled={fields.readOnly}
          onChange={(event) => setKind(event.target.value as NavigationAllowlistKind)}
        >
          {Object.entries(KINDS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Значение
        <input
          value={value}
          disabled={fields.readOnly}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <label>
        Удалить после (пусто — без срока)
        <input
          type="datetime-local"
          value={expiry}
          disabled={fields.readOnly}
          onChange={(event) => setExpiry(event.target.value)}
        />
      </label>
      {(['add', 'remove', 'setExpiry', 'replace'] as const).map((op) => (
        <button
          type="button"
          key={op}
          disabled={fields.readOnly || !value.trim()}
          onClick={() => author(op)}
        >
          {op === 'add'
            ? 'Добавить во все списки'
            : op === 'remove'
              ? 'Удалить из всех списков'
              : op === 'setExpiry'
                ? 'Изменить срок во всех списках'
                : 'Добавить в список для полной замены'}
        </button>
      ))}
      <button
        type="button"
        disabled={fields.readOnly}
        onClick={() => onNavigationAllowlist({ mode: 'replace', entries: [] })}
      >
        Заменить все списки пустым
      </button>
      {navigationAllowlist ? (
        <>
          <p>
            {navigationAllowlist.mode === 'replace'
              ? 'Полная замена · записей: ' + navigationAllowlist.entries.length
              : 'Выбрано действий: ' + navigationAllowlist.actions.length}
          </p>
          <button
            type="button"
            disabled={fields.readOnly}
            onClick={() => onNavigationAllowlist(undefined)}
          >
            Отменить все изменения разрешённых ссылок
          </button>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
