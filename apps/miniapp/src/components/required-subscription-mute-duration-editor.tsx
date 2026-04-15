export type RequiredSubscriptionMuteDurationEditorProps = {
  id: string;
  label: string;
  daysValue: number;
  maxDays: number;
  minDays: number;
  presetDays: readonly number[];
  onSelectDays: (days: number) => void;
};

function formatDayLabel(value: number): string {
  const safeValue = Math.max(1, Math.trunc(value));
  const mod10 = safeValue % 10;
  const mod100 = safeValue % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${safeValue} день`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${safeValue} дня`;
  }
  return `${safeValue} дней`;
}

function SubscriptionDaysIcon({ days, maxDays }: { days: number; maxDays: number }) {
  const safeDays = Math.min(maxDays, Math.max(1, Math.trunc(days)));

  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden focusable="false" width="20" height="20">
      <circle
        cx="12.5"
        cy="14"
        r="7.25"
        stroke="currentColor"
        strokeWidth="1.8"
        opacity="0.92"
      />
      <path
        d="M12.5 10.2v4.25l3.1 1.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20.5" cy="8.3" r="5.4" fill="currentColor" opacity="0.12" />
      <circle cx="20.5" cy="8.3" r="5.05" stroke="currentColor" strokeWidth="1.4" />
      <text
        x="20.5"
        y="10.35"
        textAnchor="middle"
        fontSize="6.2"
        fontWeight="800"
        fill="currentColor"
      >
        {safeDays}
      </text>
    </svg>
  );
}

export default function RequiredSubscriptionMuteDurationEditor({
  id,
  label,
  daysValue,
  maxDays,
  minDays,
  presetDays,
  onSelectDays,
}: RequiredSubscriptionMuteDurationEditorProps) {
  return (
    <div id={id} className="logs-violation-item__ban-config required-subscription__duration-card">
      <div className="required-subscription__duration-hero">
        <div className="required-subscription__duration-pill">
          <span className="required-subscription__duration-icon" aria-hidden="true">
            <SubscriptionDaysIcon days={daysValue} maxDays={maxDays} />
          </span>
          <div className="required-subscription__duration-copy">
            <strong>{formatDayLabel(daysValue)}</strong>
            <small>{label} после повторного обхода подписки</small>
          </div>
        </div>

        <div className="ban-duration-stepper required-subscription__duration-stepper">
          <button
            type="button"
            className="ban-duration-stepper__button"
            onClick={() => onSelectDays(daysValue - 1)}
            disabled={daysValue <= minDays}
          >
            -
          </button>
          <output className="ban-duration-stepper__value" aria-live="polite">
            {formatDayLabel(daysValue)}
          </output>
          <button
            type="button"
            className="ban-duration-stepper__button"
            onClick={() => onSelectDays(daysValue + 1)}
            disabled={daysValue >= maxDays}
          >
            +
          </button>
        </div>
      </div>

      <div className="logs-violation-item__ban-presets required-subscription__duration-presets">
        {presetDays.map((days) => (
          <button
            key={days}
            type="button"
            className={`logs-violation-item__ban-preset${daysValue === days ? ' is-active' : ''}`}
            onClick={() => onSelectDays(days)}
          >
            {formatDayLabel(days)}
          </button>
        ))}
      </div>

      <div className="required-subscription__days-slider-shell">
        <div className="required-subscription__slider-head">
          <span>Точный срок</span>
          <output aria-live="polite">
            {daysValue}/{maxDays}
          </output>
        </div>
        <input
          className="settings-length-limit__slider required-subscription__days-slider"
          type="range"
          min={minDays}
          max={maxDays}
          step={1}
          value={daysValue}
          onChange={(event) => onSelectDays(Number(event.target.value))}
          aria-label="Срок мута в днях"
        />
        <div className="required-subscription__slider-labels" aria-hidden="true">
          <span>{formatDayLabel(minDays)}</span>
          <span>{formatDayLabel(maxDays)}</span>
        </div>
      </div>
    </div>
  );
}
