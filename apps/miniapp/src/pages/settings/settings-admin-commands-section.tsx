import type { ReactNode } from 'react';
import { InfoCircleSolid } from 'iconoir-react';
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
  onToggleSection: () => void;
  onToggleHint: (key: HintKey) => void;
  onFieldChange: (key: AdminCommandNameKey, value: string) => void;
};

function readCommandName(value: string | null | undefined, fallback: string) {
  return value?.trim().replace(/\s+/g, ' ') || fallback;
}

function commandLabel(value: string) {
  return `«${value}»`;
}

function appendCaseNote(text: string) {
  return `${text} Пишите как удобно: бот поймет и маленькие, и большие буквы.`;
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
        hint: (value) =>
          appendCaseNote(
            `${commandLabel(value)} быстро закрывает доступ человеку только здесь. Ответьте командой на сообщение нарушителя или перешлите это сообщение в чат.`,
          ),
      },
      {
        key: 'adminBanAllCommandName',
        hintKey: 'adminBanAllCommand',
        title: 'Бан!',
        caption: 'Во всех чатах, где вы админ.',
        defaultValue: ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: (value) =>
          appendCaseNote(
            `${commandLabel(value)} - усиленная команда для одного и того же нарушителя во всех ваших чатах с ботом. Восклицательный знак помогает не перепутать ее с обычным баном.`,
          ),
      },
      {
        key: 'adminMuteCommandName',
        hintKey: 'adminMuteCommand',
        title: 'Мут',
        caption: 'Пауза в сообщениях, обычно на 6 часов.',
        defaultValue: ADMIN_MUTE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `${value} 12`],
        hint: (value) =>
          appendCaseNote(
            `${commandLabel(value)} мягче бана: человек остается в чате, но временно не пишет. Без числа будет 6 часов, с числом - выбранный срок, например ${commandLabel(`${value} 12`)}.`,
          ),
      },
      {
        key: 'adminPermanentMuteCommandName',
        hintKey: 'adminPermanentMuteCommand',
        title: 'Бессрочный мут',
        caption: 'Молчание без срока окончания.',
        defaultValue: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: (value) =>
          appendCaseNote(
            `${commandLabel(value)} оставляет человека в чате, но закрывает ему возможность писать без таймера. Удобно, когда удалять из чата не хочется.`,
          ),
      },
      {
        key: 'adminSilenceCommandName',
        hintKey: 'adminSilenceCommand',
        title: 'Тишина',
        caption: 'Временно закрывает чат для участников.',
        defaultValue: ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
        examples: (value) => [value, `${value} 12`],
        hint: (value) =>
          appendCaseNote(
            `${commandLabel(value)} включает тихий режим: сообщения участников будут удаляться, а админы смогут писать как обычно. Без числа - 6 часов, с числом - нужный срок.`,
          ),
      },
      {
        key: 'adminOpenChatCommandName',
        hintKey: 'adminOpenChatCommand',
        title: 'Открыть чат',
        caption: 'Возвращает чат в обычный режим.',
        defaultValue: ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
        examples: (value) => [value],
        hint: (value) =>
          appendCaseNote(
            `${commandLabel(value)} снимает тишину сразу. Участники снова смогут писать, а остальные правила продолжат работать как раньше.`,
          ),
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
        hint: (value) =>
          appendCaseNote(
            `Ответьте ${commandLabel(value)} на сообщение с правилами или перешлите его вместе с командой. Бот сохранит текст и покажет кнопку "Правила" в предупреждениях.`,
          ),
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
                              <InfoCircleSolid aria-hidden focusable="false" />
                            </button>
                          </div>

                          <label className="field settings-command-card__field">
                            <span>Команда</span>
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
                            <span className="settings-command-card__examples-label">Примеры</span>
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
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
