import { useId } from 'react';
import type { SettingsFieldState } from '../../features/network-settings/field-model';

export function StorefrontAudience({
  state,
  disabled = false,
  onChange,
}: {
  state: SettingsFieldState<boolean>;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const name = useId();
  return (
    <fieldset className="storefront-audience" disabled={disabled || state.kind === 'loading'}>
      <legend>Кто может вызвать ответ на $</legend>
      {([false, true] as const).map((adminsOnly) => (
        <label key={String(adminsOnly)}>
          <input
            type="radio"
            name={name}
            checked={state.kind === 'common' && state.value === adminsOnly}
            onChange={() => onChange(adminsOnly)}
          />
          <span>{adminsOnly ? 'Администраторы и выбранные пользователи' : 'Все участники'}</span>
        </label>
      ))}
      {state.kind === 'mixed' ? <p className="field__hint">Разные значения</p> : null}
    </fieldset>
  );
}
