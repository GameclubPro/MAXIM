import type { ReactNode } from 'react';
import {
  ADMIN_MUTE_COMMAND_ALIASES_DEFAULT,
  ADMIN_RULES_COMMAND_ALIASES_DEFAULT,
  type ChatSettings,
} from '@maxim/contracts/settings';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { cn } from '../../lib/cn';
import type { FieldErrors, HintKey } from './settings-page-helpers';
import '../../styles/settings-admin-commands.css';

type AdminCommandAliasKey = 'adminMuteCommandAliases' | 'adminRulesCommandAliases';

type SettingsAdminCommandsSectionProps = {
  draft: ChatSettings;
  expanded: boolean;
  fieldErrors: FieldErrors;
  openHintKey: HintKey | null;
  footer: ReactNode;
  onToggleSection: () => void;
  onToggleHint: (key: HintKey) => void;
  onFieldChange: (key: AdminCommandAliasKey, value: string) => void;
};

function getFirstAdminCommandAlias(value: string | null | undefined, fallback: string) {
  return (
    value
      ?.split(',')
      .map((item) => item.trim().replace(/\s+/g, ' '))
      .find((item) => item.length > 0) ?? fallback
  );
}

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
  const enabledCount = [
    draft.adminMuteCommandAliases.trim(),
    draft.adminRulesCommandAliases.trim(),
  ].filter(Boolean).length;
  const headerSummary = enabledCount === 2 ? 'Мут и правила настроены' : 'Нужно заполнить команды';
  const cardStatus = `${enabledCount}/2`;
  const muteCommandExample = getFirstAdminCommandAlias(
    draft.adminMuteCommandAliases,
    ADMIN_MUTE_COMMAND_ALIASES_DEFAULT.split(',')[0] ?? 'мут',
  );
  const rulesCommandExample = getFirstAdminCommandAlias(
    draft.adminRulesCommandAliases,
    ADMIN_RULES_COMMAND_ALIASES_DEFAULT.split(',')[0] ?? 'правило',
  );

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
            <div className="settings-section__collapse-inner settings-command-aliases">
              <div
                className={cn(
                  'settings-command-card',
                  fieldErrors.adminMuteCommandAliases && 'field--error',
                )}
              >
                <div className="settings-command-card__head">
                  <div className="settings-command-card__copy">
                    <strong>Мут</strong>
                    <span>Команда в ответ на сообщение нарушителя.</span>
                  </div>
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      openHintKey === 'adminMuteCommand' && 'is-open',
                    )}
                    aria-label="Пояснение для команды мута"
                    aria-controls="admin-mute-command-hint"
                    aria-expanded={openHintKey === 'adminMuteCommand'}
                    onClick={() => onToggleHint('adminMuteCommand')}
                  >
                    <span aria-hidden>i</span>
                  </button>
                </div>

                <label className="field settings-command-card__field">
                  <span>Тексты команды</span>
                  <input
                    value={draft.adminMuteCommandAliases}
                    onChange={(event) =>
                      onFieldChange('adminMuteCommandAliases', event.target.value)
                    }
                    placeholder={ADMIN_MUTE_COMMAND_ALIASES_DEFAULT}
                  />
                </label>

                <div className="settings-command-card__examples" aria-label="Примеры мута">
                  <code>{muteCommandExample}</code>
                  <code>{muteCommandExample} 12</code>
                  <code>{muteCommandExample} 88</code>
                </div>

                {openHintKey === 'adminMuteCommand' ? (
                  <p id="admin-mute-command-hint" className="settings-native-toggle__hint">
                    Без числа бот ставит мут на 6 часов. Число задает часы от 1 до 336, а 88
                    включает бессрочный мут.
                  </p>
                ) : null}

                {fieldErrors.adminMuteCommandAliases ? (
                  <small className="field__hint">{fieldErrors.adminMuteCommandAliases}</small>
                ) : null}
              </div>

              <div
                className={cn(
                  'settings-command-card',
                  fieldErrors.adminRulesCommandAliases && 'field--error',
                )}
              >
                <div className="settings-command-card__head">
                  <div className="settings-command-card__copy">
                    <strong>Правила</strong>
                    <span>Привязка сообщения как правил чата.</span>
                  </div>
                  <button
                    type="button"
                    className={cn(
                      'settings-info-button',
                      openHintKey === 'adminRulesCommand' && 'is-open',
                    )}
                    aria-label="Пояснение для команды правил"
                    aria-controls="admin-rules-command-hint"
                    aria-expanded={openHintKey === 'adminRulesCommand'}
                    onClick={() => onToggleHint('adminRulesCommand')}
                  >
                    <span aria-hidden>i</span>
                  </button>
                </div>

                <label className="field settings-command-card__field">
                  <span>Тексты команды</span>
                  <input
                    value={draft.adminRulesCommandAliases}
                    onChange={(event) =>
                      onFieldChange('adminRulesCommandAliases', event.target.value)
                    }
                    placeholder={ADMIN_RULES_COMMAND_ALIASES_DEFAULT}
                  />
                </label>

                <div className="settings-command-card__examples" aria-label="Примеры правил">
                  <code>{rulesCommandExample}</code>
                  <code>ответ + {rulesCommandExample}</code>
                  <code>пересылка + {rulesCommandExample}</code>
                </div>

                {openHintKey === 'adminRulesCommand' ? (
                  <p id="admin-rules-command-hint" className="settings-native-toggle__hint">
                    Бот берет сообщение из ответа или пересылки, сохраняет его как правила и
                    включает кнопку “Правила” в нарушениях.
                  </p>
                ) : null}

                {fieldErrors.adminRulesCommandAliases ? (
                  <small className="field__hint">{fieldErrors.adminRulesCommandAliases}</small>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
