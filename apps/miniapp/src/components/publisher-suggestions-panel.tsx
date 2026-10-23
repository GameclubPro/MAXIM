import type { UpdatePublisherEntityModuleSettingsRequest } from '@maxim/contracts/publisher';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';

type PublisherSuggestionsPanelProps = {
  entityTitle: string;
  enabled: boolean;
  requireSubscription: boolean;
  deleteOnUnsubscribe: boolean;
  pending: boolean;
  onChange: (change: Omit<UpdatePublisherEntityModuleSettingsRequest, 'expectedRevision'>) => void;
  onClose: () => void;
};

function SuggestionsSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="publisher-module-switch">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="publisher-module-switch__track" aria-hidden>
        <span className="publisher-module-switch__thumb" />
      </span>
    </label>
  );
}

export default function PublisherSuggestionsPanel({
  entityTitle,
  enabled,
  requireSubscription,
  deleteOnUnsubscribe,
  pending,
  onChange,
  onClose,
}: PublisherSuggestionsPanelProps) {
  return (
    <SettingsDrilldownPanel
      id="publisher-suggestions-workspace"
      open
      title="Предложения"
      summary={entityTitle}
      variant="screen"
      overlayClassName="publisher-comments-overlay publisher-comments-workspace-overlay"
      className="publisher-comments-dialog publisher-comments-workspace publisher-suggestions-workspace"
      headerAction={
        <SuggestionsSwitch
          label={`${enabled ? 'Выключить' : 'Включить'} предложения`}
          checked={enabled}
          disabled={pending}
          onChange={(channelSuggestionsEnabled) => onChange({ channelSuggestionsEnabled })}
        />
      }
      onClose={onClose}
    >
      <div id="publisher-suggestions-workspace" className="publisher-entity-module__settings">
        <div className="publisher-entity-module__setting">
          <span>Требовать подписку</span>
          <SuggestionsSwitch
            label="Требовать подписку"
            checked={requireSubscription}
            disabled={pending || !enabled}
            onChange={(channelSuggestionsRequireSubscription) =>
              onChange({ channelSuggestionsRequireSubscription })
            }
          />
        </div>
        <div className="publisher-entity-module__setting">
          <span>Удалять посты после отписки</span>
          <SuggestionsSwitch
            label="Удалять посты после отписки"
            checked={deleteOnUnsubscribe}
            disabled={pending || !enabled}
            onChange={(channelSuggestionsDeleteOnUnsubscribe) =>
              onChange({ channelSuggestionsDeleteOnUnsubscribe })
            }
          />
        </div>
      </div>
    </SettingsDrilldownPanel>
  );
}
