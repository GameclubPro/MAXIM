import {
  MAX_PUBLICATION_DELETE_AFTER_MINUTES,
  type PublicationPostPublish,
} from '@maxim/contracts/publication';
import { Bell, Pin, Timer } from 'iconoir-react';
import { useId, useState, type ReactNode } from 'react';
import { PublicationNumberInput } from './publication-number-input';
import './publication-post-publish-fields.css';

function PostActionSwitch({
  label,
  icon,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="publication-post-publish__toggle">
      {icon}
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="publication-post-publish__track" aria-hidden="true" />
    </label>
  );
}

const PRESETS = [60, 360, 1440, 10080];

export function PublicationPostPublishFields({
  value,
  disabled,
  onChange,
}: {
  value: PublicationPostPublish;
  disabled: boolean;
  onChange: (value: PublicationPostPublish) => void;
}) {
  const id = useId();
  const minutes = value.deleteAfterMinutes ?? 1440;
  const [custom, setCustom] = useState(!PRESETS.includes(minutes));
  const [unit, setUnit] = useState(minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1);
  const [lastDelay, setLastDelay] = useState(minutes);
  const [notify, setNotify] = useState(value.pin !== 'silent');
  const effectiveUnit = minutes % unit === 0 ? unit : 1;
  return (
    <section className="publication-editor-section publication-post-publish" aria-labelledby={id}>
      <div className="publication-editor-section__head">
        <strong id={id}>После публикации</strong>
      </div>
      <PostActionSwitch
        label="Закрепить пост"
        icon={<Pin aria-hidden="true" />}
        checked={value.pin !== 'none'}
        disabled={disabled}
        onChange={(enabled) => {
          if (!enabled) setNotify(value.pin === 'notify');
          onChange({ ...value, pin: enabled ? (notify ? 'notify' : 'silent') : 'none' });
        }}
      />
      {value.pin !== 'none' ? (
        <div className="publication-post-publish__nested">
          <PostActionSwitch
            label="С уведомлением"
            icon={<Bell aria-hidden="true" />}
            checked={value.pin === 'notify'}
            disabled={disabled}
            onChange={(enabled) => {
              setNotify(enabled);
              onChange({ ...value, pin: enabled ? 'notify' : 'silent' });
            }}
          />
        </div>
      ) : null}
      <PostActionSwitch
        label="Удалить автоматически"
        icon={<Timer aria-hidden="true" />}
        checked={value.deleteAfterMinutes !== null}
        disabled={disabled}
        onChange={(enabled) => {
          setLastDelay(minutes);
          onChange({ ...value, deleteAfterMinutes: enabled ? lastDelay : null });
        }}
      />
      {value.deleteAfterMinutes !== null ? (
        <div className="publication-post-publish__duration">
          <select
            aria-label="Срок автоудаления"
            value={custom || !PRESETS.includes(minutes) ? 'custom' : String(minutes)}
            disabled={disabled}
            onChange={(event) => {
              const isCustom = event.target.value === 'custom';
              setCustom(isCustom);
              if (!isCustom) onChange({ ...value, deleteAfterMinutes: Number(event.target.value) });
              else setUnit(minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1);
            }}
          >
            <option value="60">Через 1 час</option>
            <option value="360">Через 6 часов</option>
            <option value="1440">Через 24 часа</option>
            <option value="10080">Через 7 дней</option>
            <option value="custom">Свой срок</option>
          </select>
          {custom || !PRESETS.includes(minutes) ? (
            <div className="publication-post-publish__custom">
              <PublicationNumberInput
                label="Период до удаления"
                value={minutes / effectiveUnit}
                min={1}
                max={MAX_PUBLICATION_DELETE_AFTER_MINUTES / effectiveUnit}
                disabled={disabled}
                onChange={(count) =>
                  onChange({ ...value, deleteAfterMinutes: count * effectiveUnit })
                }
              />
              <select
                aria-label="Единица срока удаления"
                value={effectiveUnit}
                disabled={disabled}
                onChange={(event) => {
                  const nextUnit = Number(event.target.value);
                  const nextMinutes = Math.min(
                    MAX_PUBLICATION_DELETE_AFTER_MINUTES,
                    (minutes / effectiveUnit) * nextUnit,
                  );
                  setUnit(nextUnit);
                  onChange({ ...value, deleteAfterMinutes: nextMinutes });
                }}
              >
                <option value="1">минут</option>
                <option value="60">часов</option>
                <option value="1440">дней</option>
              </select>
            </div>
          ) : null}
          <small>После отправки · до 30 дней</small>
        </div>
      ) : null}
    </section>
  );
}
