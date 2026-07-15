import type { ReactNode } from 'react';
import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
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
  hintKey: Extract<
    HintKey,
    | 'adminBanCommand'
    | 'adminBanAllCommand'
    | 'adminMuteCommand'
    | 'adminPermanentMuteCommand'
    | 'adminRulesCommand'
    | 'adminSilenceCommand'
    | 'adminOpenChatCommand'
  >;
  title: string;
  caption: string;
  defaultValue: string;
  examples: (value: string) => string[];
  hint: (value: string) => string;
};

type AdminCommandCategory = {
  title: string;
  items: AdminCommandConfig[];
};

type SettingsAdminCommandsSectionProps = {
  draft: ChatSettings;
  expanded: boolean;
  fieldErrors: FieldErrors;
  openHintKey: HintKey | null;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onToggleHint: (key: HintKey) => void;
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
        hintKey: 'adminBanCommand',
        title: 'Бан',
        caption: 'Для нарушителя в текущем чате.',
        defaultValue: ADMIN_BAN_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: () =>
          'Ответьте этой командой на сообщение нарушителя или перешлите его сообщение в чат. Бот забанит пользователя только в этом чате.',
      },
      {
        key: 'adminBanAllCommandName',
        hintKey: 'adminBanAllCommand',
        title: 'Бан!',
        caption: 'Во всех чатах, где вы админ.',
        defaultValue: ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: () =>
          'Команда для серьезных случаев: бот забанит пользователя во всех чатах, где вы админ и где бот может выполнять действия.',
      },
      {
        key: 'adminMuteCommandName',
        hintKey: 'adminMuteCommand',
        title: 'Мут',
        caption: 'Пауза в сообщениях, обычно на 6 часов.',
        defaultValue: ADMIN_MUTE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `${value} 12`],
        hint: () =>
          'Ограничивает сообщения пользователя на время. Без числа мут длится 6 часов, с числом можно выбрать срок от 1 до 336 часов.',
      },
      {
        key: 'adminPermanentMuteCommandName',
        hintKey: 'adminPermanentMuteCommand',
        title: 'Бессрочный мут',
        caption: 'Молчание без срока окончания.',
        defaultValue: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: () =>
          'Оставляет пользователя в чате, но закрывает ему возможность писать без срока окончания.',
      },
      {
        key: 'adminSilenceCommandName',
        hintKey: 'adminSilenceCommand',
        title: 'Тишина',
        caption: 'Временно закрывает чат для участников.',
        defaultValue: ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `${value} 12`],
        hint: () =>
          'Временно закрывает чат для участников: их сообщения будут удаляться, а админы смогут писать как обычно. Без числа включается на 6 часов.',
      },
      {
        key: 'adminOpenChatCommandName',
        hintKey: 'adminOpenChatCommand',
        title: 'Открыть чат',
        caption: 'Возвращает чат в обычный режим.',
        defaultValue: ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: () => 'Снимает тишину сразу. После этого участники снова смогут писать в чат.',
      },
    ],
  },
  {
    title: 'Правила',
    items: [
      {
        key: 'adminRulesCommandName',
        hintKey: 'adminRulesCommand',
        title: 'Правило',
        caption: 'Сохраняет сообщение как правила чата.',
        defaultValue: ADMIN_RULES_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `ответ + ${value}`],
        hint: () =>
          'Ответьте этой командой на сообщение с правилами или перешлите его вместе с командой. Бот сохранит сообщение как правила чата.',
      },
    ],
  },
];

export function SettingsAdminCommandsSection({
  draft,
  expanded,
  fieldErrors,
  openHintKey,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onToggleHint,
  onFieldChange,
}: SettingsAdminCommandsSectionProps) {
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
          hideChevron
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
                      const value = readCommandName(draft[item.key], item.defaultValue);
                      const hintId = `${item.key}-hint`;
                      const isHintOpen = openHintKey === item.hintKey;
                      const error = fieldErrors[item.key];

                      return (
                        <div
                          className={cn('settings-command-card', error && 'field--error')}
                          key={item.key}
                        >
                          <div className="settings-command-card__head">
                            <div className="settings-command-card__copy">
                              <strong>{item.title}</strong>
                              <span>{item.caption}</span>
                            </div>
                            <button
                              type="button"
                              className={cn('settings-info-button', isHintOpen && 'is-open')}
                              aria-label={`Пояснение: ${item.title}`}
                              aria-controls={hintId}
                              aria-expanded={isHintOpen}
                              onClick={() => onToggleHint(item.hintKey)}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label className="field settings-command-card__field">
                            <span>Название команды</span>
                            <input
                              value={draft[item.key]}
                              onChange={(event) => onFieldChange(item.key, event.target.value)}
                              placeholder={item.defaultValue}
                            />
                          </label>

                          <div
                            className="settings-command-card__examples"
                            aria-label={`Примеры: ${item.title}`}
                          >
                            {item.examples(value).map((example) => (
                              <code key={example}>{example}</code>
                            ))}
                          </div>

                          {isHintOpen ? (
                            <p
                              id={hintId}
                              className="settings-native-toggle__hint settings-command-card__hint"
                            >
                              {item.hint(value)}
                            </p>
                          ) : null}

                          {error ? <small className="field__hint">{error}</small> : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              <p className="settings-admin-commands__case-note">
                Команды можно писать маленькими или большими буквами.
              </p>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
