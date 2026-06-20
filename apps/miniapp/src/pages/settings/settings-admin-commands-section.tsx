import type { ReactNode } from 'react';
import {
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
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
  | 'adminMuteCommandName'
  | 'adminPermanentMuteCommandName'
  | 'adminRulesCommandName';

type AdminCommandConfig = {
  key: AdminCommandNameKey;
  hintKey: Extract<
    HintKey,
    'adminBanCommand' | 'adminMuteCommand' | 'adminPermanentMuteCommand' | 'adminRulesCommand'
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
        caption: 'Постоянный системный бан.',
        defaultValue: ADMIN_BAN_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: (value) =>
          `Ответьте на сообщение или перешлите его в чат с командой ${value}. Команда не принимает часы.`,
      },
      {
        key: 'adminMuteCommandName',
        hintKey: 'adminMuteCommand',
        title: 'Мут',
        caption: 'Временный мут на 6 часов по умолчанию.',
        defaultValue: ADMIN_MUTE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `${value} 12`],
        hint: (value) =>
          `Команда ${value} ставит мут на 6 часов. Число после команды задает срок от 1 до 336 часов.`,
      },
      {
        key: 'adminPermanentMuteCommandName',
        hintKey: 'adminPermanentMuteCommand',
        title: 'Бессрочный мут',
        caption: 'Отдельная команда без таймера.',
        defaultValue: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: (value) =>
          `Команда ${value} ставит бессрочный мут. Это отдельное действие, а не вариант временного мута.`,
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
        caption: 'Привязка сообщения как правил чата.',
        defaultValue: ADMIN_RULES_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `ответ + ${value}`],
        hint: (value) =>
          `Ответьте на сообщение с командой ${value} или перешлите сообщение вместе с ней. Бот сохранит его как правила.`,
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
  onToggleSection,
  onToggleHint,
  onFieldChange,
}: SettingsAdminCommandsSectionProps) {
  const filledCount = commandCategories
    .flatMap((category) => category.items)
    .filter((item) => readCommandName(draft[item.key], '').length > 0).length;
  const headerSummary = filledCount === 4 ? '4 команды настроены' : 'Нужно заполнить команды';
  const cardStatus = `${filledCount}/4`;

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
        footer={footer}
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
                            <p id={hintId} className="settings-native-toggle__hint">
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
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
