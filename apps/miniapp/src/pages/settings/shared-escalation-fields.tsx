import { useEffect, useState } from 'react';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import type { ChatNumberField } from '../../features/network-settings/chat-field-intents';

function EscalationNumber({
  fields,
  path,
  title,
  label,
  suffix,
  max,
}: {
  fields: ChatSettingsFieldAdapter;
  path: ChatNumberField;
  title: string;
  label: string;
  suffix: string;
  max: number;
}) {
  const state = fields.read(path);
  const [buffer, setBuffer] = useState<string | null>(null);
  const key = state.kind === 'common' ? state.value : state.kind;
  useEffect(() => setBuffer(null), [key]);
  const error = fields.error(path);
  return (
    <label className={`duplicate-stage__field${error ? ' field--error' : ''}`}>
      <span className="duplicate-stage__field-label">{label}</span>
      <div className="duplicate-stage__input-wrap">
        <input
          type="number"
          min={1}
          max={max}
          step={1}
          value={buffer ?? (state.kind === 'common' ? String(state.value) : '')}
          placeholder={state.kind === 'mixed' ? 'Разные значения' : undefined}
          disabled={fields.readOnly || state.kind === 'loading'}
          aria-label={`${title}: ${label.toLowerCase()}`}
          onChange={(event) => {
            const raw = event.target.value;
            setBuffer(raw);
            const next = Number(raw);
            if (!raw.trim() || !Number.isInteger(next) || next < 1 || next > max) {
              fields.setError(path, `Укажите число от 1 до ${max}.`);
              return;
            }
            fields.setError(path, null);
            fields.setScalar(path, next);
          }}
        />
        <span className="duplicate-stage__suffix" aria-hidden="true">
          {suffix}
        </span>
      </div>
    </label>
  );
}
export function SharedEscalationFields({
  fields,
  prefix,
  title,
}: {
  fields: ChatSettingsFieldAdapter;
  prefix: 'link' | 'phoneNumbers';
  title: string;
}) {
  const specs = [
    ['EscalationWindowHours', 'Период', 'ч', 168],
    ['WarnMaxCount', 'Предупреждение', 'раз', 20],
    ['MuteMaxCount', 'Ограничение', 'раз', 20],
    ['BanMaxCount', 'Блокировка', 'раз', 20],
  ] as const;
  const errors = specs
    .map(([suffix]) => fields.error((prefix + suffix) as ChatNumberField))
    .filter(Boolean);
  return (
    <article className={`duplicate-stage${errors.length ? ' field--error' : ''}`}>
      <div className="duplicate-stage__top">
        <span className="duplicate-stage__title">{title}</span>
      </div>
      <div className="duplicate-stage__controls">
        {specs.map(([suffix, label, unit, max]) => (
          <EscalationNumber
            key={suffix}
            fields={fields}
            path={(prefix + suffix) as ChatNumberField}
            title={title}
            label={label}
            suffix={unit}
            max={max}
          />
        ))}
      </div>
      {errors.length ? (
        <div className="duplicate-stage__errors">
          {errors.map((error, index) => (
            <small key={index} className="field__hint" role="alert">
              {error}
            </small>
          ))}
        </div>
      ) : null}
    </article>
  );
}
