import { useEffect, useRef, type ReactNode } from 'react';
import type { SettingsFieldState } from '../../features/network-settings/field-model';
import { cn } from '../../lib/cn';
import '../../styles/broadcast-studio-base.css';
import '../../styles/settings-rules-studio.css';
import './settings-rules-publication.css';
import '../../styles/broadcast-studio.css';
import '../../styles/broadcast-autopost-polish.css';

function RulesToggle({
  title,
  label,
  summary,
  state,
  disabled,
  onChange,
}: {
  title: string;
  label: string;
  summary?: string;
  state: SettingsFieldState<boolean>;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <div className="settings-native-toggle rules-native-card">
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <div className="rules-native-card__copy">
            <span className="settings-native-toggle__title">{title}</span>
            <span className="rules-native-card__meta">
              {state.kind === 'mixed'
                ? 'Разные значения'
                : state.kind === 'loading'
                  ? 'Загрузка…'
                  : (summary ?? (state.value ? 'Включено' : 'Выключено'))}
            </span>
          </div>
        </div>
        <label className="settings-native-switch" aria-label={label}>
          <input
            ref={input}
            type="checkbox"
            checked={state.kind === 'common' && state.value}
            aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
            disabled={disabled || state.kind === 'loading'}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
    </div>
  );
}

export function SharedRulesSettingsStudio({
  header,
  composer,
  beforeComposer,
  hasContent,
  contentStatus,
  autoText,
  autoTextSummary,
  onAutoTextChange,
  adminContact,
  attachViolations,
  violationsSummary,
  onAttachViolationsChange,
  disabled,
  attachDisabled,
}: {
  header: ReactNode;
  composer: ReactNode;
  beforeComposer?: ReactNode;
  hasContent: boolean;
  contentStatus?: string;
  autoText: SettingsFieldState<boolean>;
  autoTextSummary?: string;
  onAutoTextChange: (enabled: boolean) => void;
  adminContact?: ReactNode;
  attachViolations: SettingsFieldState<boolean>;
  violationsSummary?: string;
  onAttachViolationsChange: (enabled: boolean) => void;
  disabled?: boolean;
  attachDisabled?: boolean;
}) {
  return (
    <div className="rules-studio broadcast-studio-screen rules-studio-screen">
      <div className="broadcast-studio-screen__chrome">{header}</div>
      <div className="broadcast-compose-flow broadcast-compose-flow--screen rules-compose-flow">
        <div className="broadcast-stage-card broadcast-stage-card--message broadcast-stage-card--primary">
          <div className="broadcast-stage-card__head">
            <div className="broadcast-stage-card__title-wrap">
              <strong>Пост</strong>
            </div>
            <span
              className={cn('broadcast-stage-card__status', hasContent ? 'is-ready' : 'is-pending')}
            >
              {contentStatus ?? (hasContent ? 'Готов' : 'Пусто')}
            </span>
          </div>
          <div className="broadcast-stage-card__body">
            {beforeComposer}
            {composer}
          </div>
        </div>
        <div className="broadcast-stage-card broadcast-stage-card--rules-settings rules-settings-stack">
          <div className="broadcast-stage-card__head">
            <div className="broadcast-stage-card__title-wrap">
              <strong>Настройки</strong>
            </div>
          </div>
          <div className="broadcast-stage-card__body">
            <RulesToggle
              title="Составлять из настроек"
              label="Включить автотекст правил из настроек"
              state={autoText}
              summary={autoTextSummary}
              disabled={disabled}
              onChange={onAutoTextChange}
            />
            {adminContact}
            <RulesToggle
              title="Показывать при нарушении"
              label="Включить кнопку Правила в сообщениях о нарушениях"
              state={attachViolations}
              summary={violationsSummary}
              disabled={attachDisabled}
              onChange={onAttachViolationsChange}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
