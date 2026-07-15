import type { ReactNode } from 'react';
import type { ChatSettings } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { GlassCard } from '../../components/ui/glass-card';
import { cn } from '../../lib/cn';
import { DeleteDelayStepper, type FieldErrors, type HintKey } from './settings-page-helpers';

type SettingsExtraSectionProps = {
  draft: Pick<
    ChatSettings,
    'deleteBotMessagesEnabled' | 'deleteBotMessagesDelayMinutes' | 'removeBotsFromGroupEnabled'
  >;
  expanded: boolean;
  summary: string;
  status: string;
  openHintKey: HintKey | null;
  fieldErrors: FieldErrors;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onToggleHint: (key: HintKey) => void;
  onFieldChange: (
    key: 'deleteBotMessagesEnabled' | 'removeBotsFromGroupEnabled',
    value: boolean,
  ) => void;
  onAdjustDeleteBotMessagesDelay: (direction: number) => void;
};

export function SettingsExtraSection({
  draft,
  expanded,
  summary,
  status,
  openHintKey,
  fieldErrors,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onToggleHint,
  onFieldChange,
  onAdjustDeleteBotMessagesDelay,
}: SettingsExtraSectionProps) {
  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '372ms', order: 31 }}
      aria-label="Сервис"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Сервис"
          summary={summary}
          status={status}
          icon="tools"
          tone="amber"
          open={expanded}
          controls="settings-extra-content"
          onClick={onToggleSection}
          hideChevron
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-extra-content"
        open={expanded}
        title="Сервис"
        summary={summary}
        tone="amber"
        className="settings-drilldown__panel--notice settings-drilldown__panel--extra"
        onClose={onToggleSection}
        confirmCloseWhen={hasChanges}
        onDiscardChanges={onDiscardChanges}
        footer={hasChanges ? footer : null}
      >
        <div
          id="settings-extra-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner">
              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">Удалять свои сообщения</span>
                    <button
                      type="button"
                      className={cn(
                        'settings-info-button',
                        openHintKey === 'deleteBotMessages' && 'is-open',
                      )}
                      aria-label="Пояснение для удаления своих сообщений ботом"
                      aria-controls="delete-bot-messages-hint"
                      aria-expanded={openHintKey === 'deleteBotMessages'}
                      onClick={() => onToggleHint('deleteBotMessages')}
                    >
                      <span aria-hidden>i</span>
                    </button>
                  </div>

                  <label
                    className="settings-native-switch"
                    aria-label="Включить удаление собственных сообщений бота"
                  >
                    <input
                      type="checkbox"
                      checked={draft.deleteBotMessagesEnabled}
                      onChange={(event) =>
                        onFieldChange('deleteBotMessagesEnabled', event.target.checked)
                      }
                    />
                    <span className="toggle-switch" aria-hidden>
                      <span className="toggle-switch__thumb" />
                    </span>
                  </label>
                </div>

                {openHintKey === 'deleteBotMessages' ? (
                  <p id="delete-bot-messages-hint" className="settings-native-toggle__hint">
                    Бот будет автоматически удалять собственные сообщения через выбранное время.
                  </p>
                ) : null}
              </div>

              {draft.deleteBotMessagesEnabled ? (
                <DeleteDelayStepper
                  title="Через сколько удалять"
                  value={draft.deleteBotMessagesDelayMinutes}
                  fieldError={fieldErrors.deleteBotMessagesDelayMinutes}
                  groupAriaLabel="Задержка удаления сообщений бота"
                  decreaseAriaLabel="Уменьшить задержку удаления сообщений бота"
                  increaseAriaLabel="Увеличить задержку удаления сообщений бота"
                  onAdjust={onAdjustDeleteBotMessagesDelay}
                />
              ) : null}

              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">Удалять ботов из группы</span>
                    <button
                      type="button"
                      className={cn(
                        'settings-info-button',
                        openHintKey === 'removeBotsFromGroup' && 'is-open',
                      )}
                      aria-label="Пояснение для удаления ботов из группы"
                      aria-controls="remove-bots-hint"
                      aria-expanded={openHintKey === 'removeBotsFromGroup'}
                      onClick={() => onToggleHint('removeBotsFromGroup')}
                    >
                      <span aria-hidden>i</span>
                    </button>
                  </div>

                  <label
                    className="settings-native-switch"
                    aria-label="Включить удаление ботов из группы"
                  >
                    <input
                      type="checkbox"
                      checked={draft.removeBotsFromGroupEnabled}
                      onChange={(event) =>
                        onFieldChange('removeBotsFromGroupEnabled', event.target.checked)
                      }
                    />
                    <span className="toggle-switch" aria-hidden>
                      <span className="toggle-switch__thumb" />
                    </span>
                  </label>
                </div>

                {openHintKey === 'removeBotsFromGroup' ? (
                  <p id="remove-bots-hint" className="settings-native-toggle__hint">
                    Если включено, бот-аккаунты будут автоматически удаляться из группы.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
