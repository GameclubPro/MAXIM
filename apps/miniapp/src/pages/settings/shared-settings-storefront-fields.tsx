import { StorefrontAudience } from './storefront-audience';
import { useEffect, useRef } from 'react';
import type {
  ChatSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import { SettingsStorefrontTextEditor } from './settings-storefront-text-editor';
import '../../styles/settings-storefront.css';
function StorefrontToggle({
  state,
  title,
  label,
  description,
  disabled,
  nested = false,
  onChange,
}: {
  state: SettingsFieldState<boolean>;
  title: string;
  label: string;
  description?: string;
  disabled: boolean;
  nested?: boolean;
  onChange: (value: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <div className={`settings-native-toggle${nested ? ' settings-native-toggle--nested' : ''}`}>
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <span className="settings-native-toggle__title">{title}</span>
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
      {state.kind === 'mixed' ? <p className="field__hint">Разные значения</p> : null}
      {description ? <p className="settings-native-toggle__hint">{description}</p> : null}
    </div>
  );
}
export function SharedSettingsStorefrontFields({
  fields,
  scope,
}: {
  fields: ChatSettingsFieldAdapter;
  scope: 'single' | 'network';
}) {
  const enabled = fields.read('karavanStorefrontEnabled');
  return (
    <>
      <StorefrontToggle
        title="Ответ бота на $"
        label="Ответ бота на $"
        state={enabled}
        disabled={fields.readOnly}
        onChange={(value) => fields.setScalar('karavanStorefrontEnabled', value)}
      />
      {enabled.kind !== 'common' || enabled.value ? (
        <>
          <SettingsStorefrontTextEditor fields={fields} scope={scope} />
          <StorefrontAudience
            state={fields.read('karavanStorefrontAdminsOnly')}
            disabled={fields.readOnly}
            onChange={(value) => fields.setScalar('karavanStorefrontAdminsOnly', value)}
          />
        </>
      ) : null}
    </>
  );
}
