import { PlusCircle, Trash } from 'iconoir-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ChatSettings } from '@maxim/contracts/settings';
import type { KaravanStorefrontAllowlistEntry } from '@maxim/contracts/karavan-storefront';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getKaravanStorefrontAllowlist,
  handoffKaravanStorefrontAllowlist,
  revokeKaravanStorefrontAllowlistEntry,
} from '../../lib/api/chat-settings-client';
import { cn } from '../../lib/cn';
import { maxNotify, openMaxBotLinkAndClose } from '../../lib/max-bridge';
import { describeUserFacingError } from '../../lib/user-facing-error';
import '../../styles/settings-storefront.css';

type SettingsStorefrontSectionProps = {
  draft: Pick<ChatSettings, 'karavanStorefrontEnabled' | 'karavanStorefrontAdminsOnly'>;
  api: ApiTransport;
  chatId?: string | null;
  expanded: boolean;
  summary: string;
  status: string;
  headerAction?: ReactNode;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onFieldChange: (value: boolean) => void;
  onAdminsOnlyChange: (value: boolean) => void;
};

function formatAllowlistExpiry(expiresAt: string | null): string {
  if (!expiresAt) {
    return 'Бессрочно';
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return 'Срок не указан';
  }

  return `до ${new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(parsed)}`;
}

function allowlistEntryLabel(entry: KaravanStorefrontAllowlistEntry): string {
  return entry.displayName?.trim() || `Пользователь ${entry.userId}`;
}

export function SettingsStorefrontSection({
  draft,
  api,
  chatId,
  expanded,
  summary,
  status,
  headerAction,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onFieldChange,
  onAdminsOnlyChange,
}: SettingsStorefrontSectionProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [entryToRevoke, setEntryToRevoke] = useState<KaravanStorefrontAllowlistEntry | null>(null);
  const allowlistQueryKey = ['karavan-storefront-allowlist', chatId] as const;
  const allowlistVisible =
    expanded && draft.karavanStorefrontEnabled && draft.karavanStorefrontAdminsOnly;
  const allowlistQuery = useQuery({
    queryKey: allowlistQueryKey,
    queryFn: ({ signal }) =>
      getKaravanStorefrontAllowlist(api, chatId ?? '', {
        signal,
        limit: 100,
      }),
    enabled: Boolean(chatId) && allowlistVisible,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const handoffMutation = useMutation({
    mutationFn: () => handoffKaravanStorefrontAllowlist(api, chatId ?? ''),
    onSuccess: ({ botUrl }) => {
      if (!openMaxBotLinkAndClose(botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
          description: 'Повторите попытку из MAX.',
        });
        maxNotify('error');
        return;
      }

      pushToast({
        tone: 'info',
        title: 'Открываем бота',
        description: 'Перешлите ему сообщение пользователя и выберите срок доступа.',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить добавление',
        description: describeUserFacingError(error, 'Повторите попытку.'),
      });
      maxNotify('error');
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (entryId: string) =>
      revokeKaravanStorefrontAllowlistEntry(api, chatId ?? '', entryId),
    onSuccess: () => {
      setEntryToRevoke(null);
      void queryClient.invalidateQueries({ queryKey: allowlistQueryKey });
      pushToast({ tone: 'success', title: 'Доступ отозван' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отозвать доступ',
        description: describeUserFacingError(error, 'Повторите попытку.'),
      });
      maxNotify('error');
    },
  });

  const entries = allowlistQuery.data?.items ?? [];

  return (
    <>
      <GlassCard
        className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
        style={{ animationDelay: '386ms', order: 31 }}
        aria-label="Интернет-витрина"
      >
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <SettingsSectionToggle
            title="Интернет-витрина"
            summary={summary}
            status={status}
            icon="storefront"
            tone="sky"
            open={expanded}
            controls="settings-storefront-content"
            onClick={onToggleSection}
          />
        </div>

        <SettingsDrilldownPanel
          id="settings-storefront-content"
          open={expanded}
          title="Интернет-витрина"
          summary={summary}
          tone="sky"
          className="settings-drilldown__panel--notice"
          onClose={onToggleSection}
          headerAction={headerAction}
          confirmCloseWhen={hasChanges}
          onDiscardChanges={onDiscardChanges}
          footer={hasChanges ? footer : null}
        >
          <div
            id="settings-storefront-collapse"
            className={cn('settings-section__collapse', expanded && 'is-open')}
          >
            {expanded ? (
              <div className="settings-section__collapse-inner">
                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <div className="settings-native-toggle__title-wrap">
                      <span className="settings-native-toggle__title">Караван</span>
                    </div>

                    <label
                      className="settings-native-switch"
                      aria-label="Включить кнопку витрины Караван"
                    >
                      <input
                        type="checkbox"
                        checked={draft.karavanStorefrontEnabled}
                        onChange={(event) => onFieldChange(event.target.checked)}
                      />
                      <span className="toggle-switch" aria-hidden>
                        <span className="toggle-switch__thumb" />
                      </span>
                    </label>
                  </div>
                  <p className="settings-native-toggle__hint">
                    Одиночный $ без витрины покажет кнопки витрин.
                  </p>
                </div>

                {draft.karavanStorefrontEnabled ? (
                  <>
                    <div className="settings-native-toggle settings-native-toggle--nested">
                      <div className="settings-native-toggle__row">
                        <div className="settings-native-toggle__title-wrap">
                          <span className="settings-native-toggle__title">
                            Только администраторы
                          </span>
                        </div>

                        <label
                          className="settings-native-switch"
                          aria-label="Разрешать витрину только администраторам и пользователям из списка"
                        >
                          <input
                            type="checkbox"
                            checked={draft.karavanStorefrontAdminsOnly}
                            onChange={(event) => onAdminsOnlyChange(event.target.checked)}
                          />
                          <span className="toggle-switch" aria-hidden>
                            <span className="toggle-switch__thumb" />
                          </span>
                        </label>
                      </div>
                      <p className="settings-native-toggle__hint">
                        Кнопка будет доступна администраторам и выданным пользователям.
                      </p>
                    </div>

                    {draft.karavanStorefrontAdminsOnly ? (
                      <section
                        className="settings-storefront__allowlist"
                        aria-labelledby="settings-storefront-allowlist-title"
                      >
                        <div className="settings-storefront__allowlist-head">
                          <div>
                            <h3 id="settings-storefront-allowlist-title">
                              Разрешённые пользователи
                            </h3>
                            <p>Доступ действует только в этом чате.</p>
                          </div>
                          <button
                            type="button"
                            className="settings-storefront__add-button"
                            onClick={() => handoffMutation.mutate()}
                            disabled={!chatId || handoffMutation.isPending}
                          >
                            <PlusCircle aria-hidden />
                            <span>
                              {handoffMutation.isPending ? 'Открываем...' : 'Добавить пользователя'}
                            </span>
                          </button>
                        </div>

                        {allowlistQuery.isLoading ? (
                          <div className="settings-storefront__state" role="status">
                            <Spinner size="sm" label="Загружаем список" />
                            <span>Загружаем список...</span>
                          </div>
                        ) : allowlistQuery.isError ? (
                          <div className="settings-storefront__state settings-storefront__state--error">
                            <p>
                              {describeUserFacingError(
                                allowlistQuery.error,
                                'Не удалось загрузить список.',
                              )}
                            </p>
                            <button type="button" onClick={() => void allowlistQuery.refetch()}>
                              Повторить
                            </button>
                          </div>
                        ) : entries.length === 0 ? (
                          <p className="settings-storefront__empty">Список пока пуст.</p>
                        ) : (
                          <div className="settings-storefront__list" aria-live="polite">
                            {entries.map((entry) => (
                              <div className="settings-storefront__entry" key={entry.id}>
                                <div className="settings-storefront__entry-copy">
                                  <strong>{allowlistEntryLabel(entry)}</strong>
                                  <span>
                                    ID: {entry.userId} · {formatAllowlistExpiry(entry.expiresAt)}
                                  </span>
                                </div>
                                {entryToRevoke?.id === entry.id ? (
                                  <span className="settings-storefront__revoke-confirm">
                                    <button
                                      type="button"
                                      className="settings-storefront__revoke-confirm-button"
                                      onClick={() => revokeMutation.mutate(entry.id)}
                                      disabled={revokeMutation.isPending}
                                    >
                                      {revokeMutation.isPending ? '...' : 'Отозвать'}
                                    </button>
                                    <button
                                      type="button"
                                      className="settings-storefront__revoke-cancel-button"
                                      onClick={() => setEntryToRevoke(null)}
                                      disabled={revokeMutation.isPending}
                                    >
                                      Отмена
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="settings-storefront__revoke-button"
                                    aria-label={`Отозвать доступ: ${allowlistEntryLabel(entry)}`}
                                    title="Отозвать доступ"
                                    onClick={() => setEntryToRevoke(entry)}
                                    disabled={revokeMutation.isPending}
                                  >
                                    <Trash aria-hidden />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsDrilldownPanel>
      </GlassCard>
    </>
  );
}
