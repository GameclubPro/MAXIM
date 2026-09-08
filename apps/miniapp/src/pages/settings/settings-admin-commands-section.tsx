import { useEffect, useState, type ReactNode } from 'react';
import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_COMMAND_NAME_MAX_LENGTH,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
  type ChatSettings,
} from '@maxim/contracts/settings';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { cn } from '../../lib/cn';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import { SettingsHintAnchor } from './settings-hint-anchor';
import type { FieldErrors, HintKey } from './settings-page-helpers';
import '../../styles/settings-admin-commands.css';

type AdminCommandNameKey =
  | 'adminBanCommandName'
  | 'adminBanAllCommandName'
  | 'adminMuteCommandName'
  | 'adminPermanentMuteCommandName'
  | 'adminRulesCommandName'
  | 'adminSilenceCommandName'
  | 'adminOpenChatCommandName';

type AdminCommandConfig = {
  key: AdminCommandNameKey;
  title: string;
  caption: string;
  hintKey: HintKey;
  defaultValue: string;
};

type AdminCommandCategory = {
  title: string;
  items: AdminCommandConfig[];
};

type SettingsAdminCommandsSectionProps = {
  draft: ChatSettings;
  expanded: boolean;
  fieldErrors: FieldErrors;
  headerAction?: ReactNode;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onFieldChange: (key: AdminCommandNameKey, value: string) => void;
};

function readCommandName(value: string | null | undefined, fallback: string) {
  return value?.trim().replace(/\s+/g, ' ') || fallback;
}

const commandCategories: AdminCommandCategory[] = [
  {
    title: 'Модерация',
    items: [
      {
        key: 'adminBanCommandName',
        title: 'Заблокировать',
        caption: 'Блокирует участника в текущем чате. В остальных чатах его доступ не меняется.',
        hintKey: 'adminBanCommand',
        defaultValue: ADMIN_BAN_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminBanAllCommandName',
        title: 'Заблокировать во всех чатах',
        caption:
          'Блокирует участника во всех подключённых чатах, где у вас есть права администратора. Это действие затрагивает не только текущий чат.',
        hintKey: 'adminBanAllCommand',
        defaultValue: ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminMuteCommandName',
        title: 'Запретить писать',
        caption:
          'Временно запрещает участнику писать. По умолчанию запрет действует 6 часов, при этом участник остаётся в чате.',
        hintKey: 'adminMuteCommand',
        defaultValue: ADMIN_MUTE_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminPermanentMuteCommandName',
        title: 'Запретить писать навсегда',
        caption:
          'Запрещает участнику писать без автоматического окончания. Участник остаётся в чате.',
        hintKey: 'adminPermanentMuteCommand',
        defaultValue: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminSilenceCommandName',
        title: 'Закрыть чат',
        caption:
          'Временно закрывает чат: бот удаляет новые сообщения участников. Администраторы могут продолжать писать.',
        hintKey: 'adminSilenceCommand',
        defaultValue: ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
      },
      {
        key: 'adminOpenChatCommandName',
        title: 'Открыть чат',
        caption:
          'Отменяет ручное закрытие чата. Ночное расписание, если оно включено, продолжает действовать.',
        hintKey: 'adminOpenChatCommand',
        defaultValue: ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
      },
    ],
  },
  {
    title: 'Правила',
    items: [
      {
        key: 'adminRulesCommandName',
        title: 'Сохранить правила',
        caption: 'Сохраняет сообщение как правила чата.',
        hintKey: 'adminRulesCommand',
        defaultValue: ADMIN_RULES_COMMAND_NAME_DEFAULT,
      },
    ],
  },
];

export function SettingsAdminCommandsSection({
  draft,
  expanded,
  fieldErrors,
  headerAction,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onFieldChange,
}: SettingsAdminCommandsSectionProps) {
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const activeHintKey = expanded ? openHintKey : null;
  const toggleHint = (key: HintKey) => setOpenHintKey((current) => (current === key ? null : key));
  useHintPopoverAutoPosition(activeHintKey !== null, activeHintKey, () => setOpenHintKey(null));
  useEffect(() => {
    if (!expanded) setOpenHintKey(null);
  }, [expanded]);
  const filledCount = commandCategories
    .flatMap((category) => category.items)
    .filter((item) => readCommandName(draft[item.key], '').length > 0).length;
  const commandCount = commandCategories.reduce(
    (count, category) => count + category.items.length,
    0,
  );
  const headerSummary =
    filledCount === commandCount ? `${commandCount} команд настроено` : 'Нужно заполнить команды';
  const cardStatus = `${filledCount}/${commandCount}`;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '344ms', order: 30 }}
      aria-label="Команды"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Команды"
          summary={headerSummary}
          status={cardStatus}
          icon="commands"
          tone="ink"
          open={expanded}
          controls="settings-commands-content"
          onClick={onToggleSection}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-commands-content"
        open={expanded}
        title="Команды"
        summary={headerSummary}
        tone="ink"
        className="settings-drilldown__panel--notice settings-drilldown__panel--commands"
        onClose={onToggleSection}
        headerAction={headerAction}
        confirmCloseWhen={hasChanges}
        onDiscardChanges={onDiscardChanges}
        footer={hasChanges ? footer : null}
      >
        <div
          id="settings-commands-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner settings-admin-commands">
              {commandCategories.map((category) => (
                <section className="settings-admin-commands__category" key={category.title}>
                  <h3>{category.title}</h3>
                  <div className="settings-admin-commands__grid">
                    {category.items.map((item) => {
                      const error = fieldErrors[item.key];

                      return (
                        <div
                          className={cn('settings-command-card', error && 'field--error')}
                          key={item.key}
                        >
                          <div className="settings-command-card__row">
                            <span className="settings-command-card__copy">
                              <span className="settings-native-toggle__title-wrap">
                                <label htmlFor={`settings-command-${item.key}`}>
                                  <strong>{item.title}</strong>
                                </label>
                                <SettingsHintAnchor
                                  hintKey={item.hintKey}
                                  openHintKey={activeHintKey}
                                  onToggleHint={toggleHint}
                                  label={`Что делает команда «${item.title}»`}
                                >
                                  {item.caption}
                                </SettingsHintAnchor>
                              </span>
                            </span>
                            <input
                              id={`settings-command-${item.key}`}
                              value={draft[item.key]}
                              onChange={(event) => onFieldChange(item.key, event.target.value)}
                              placeholder={item.defaultValue}
                              aria-label={`Команда «${item.title}»`}
                              aria-invalid={Boolean(error)}
                              aria-describedby={
                                error ? `settings-command-${item.key}-error` : undefined
                              }
                              maxLength={ADMIN_COMMAND_NAME_MAX_LENGTH}
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                            />
                          </div>

                          {error ? (
                            <small
                              id={`settings-command-${item.key}-error`}
                              className="field__hint"
                              role="alert"
                            >
                              {error}
                            </small>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
