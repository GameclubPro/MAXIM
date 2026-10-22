import { useEffect, useRef } from 'react';
import type {
  ChannelSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import { SegmentedControl } from '../../components/ui/segmented-control';

function SuggestionToggle({
  title,
  state,
  disabled,
  onChange,
}: {
  title: string;
  state: SettingsFieldState<boolean>;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  const checked = state.kind === 'common' && state.value;
  const blocked = disabled || state.kind === 'loading';
  return (
    <div
      className={
        'channel-settings-toggle-card' + (checked ? ' is-on' : '') + (blocked ? ' is-disabled' : '')
      }
      onClick={(event) => {
        if (!blocked && !(event.target as HTMLElement).closest('button, input, label'))
          onChange(!checked);
      }}
    >
      <div className="channel-settings-toggle-card__copy">
        <div className="channel-settings-toggle-card__title-row">
          <strong>{title}</strong>
        </div>
        {state.kind === 'mixed' ? <span>Разные значения</span> : null}
      </div>
      <label className="settings-native-switch">
        <input
          ref={input}
          type="checkbox"
          checked={checked}
          aria-label={title}
          aria-checked={state.kind === 'mixed' ? 'mixed' : checked}
          disabled={blocked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </label>
    </div>
  );
}

export function ChannelPostSuggestionsFields({ fields }: { fields: ChannelSettingsFieldAdapter }) {
  const enabled = fields.read('postSuggestionsEnabled');
  const mode = fields.read('postSuggestionsEntryMode');
  const dailyLimit = fields.read('postSuggestionsDailyLimit');
  const toggle = (
    path:
      | 'postSuggestionsEnabled'
      | 'postSuggestionsRequireSubscription'
      | 'postSuggestionsDeleteOnUnsubscribe',
    title: string,
  ) => (
    <SuggestionToggle
      title={title}
      state={fields.read(path)}
      disabled={fields.readOnly}
      onChange={(value) => fields.setScalar(path, value)}
    />
  );
  const text = (
    path: 'postSuggestionsButtonText' | 'postSuggestionsText' | 'engagementMessageText',
    label: string,
    placeholder: string,
    rows?: number,
  ) => {
    const state = fields.read(path);
    const props = {
      value: state.kind === 'common' ? state.value : '',
      placeholder: state.kind === 'mixed' ? 'Разные значения' : placeholder,
      'aria-label': label,
      disabled: fields.readOnly || state.kind === 'loading',
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        try {
          fields.setScalar(path, event.target.value);
          fields.setError(path, null);
        } catch (cause) {
          fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
        }
      },
    };
    return (
      <label className={'field' + (rows ? ' channel-settings-field--wide' : '')}>
        <span>{label}</span>
        {rows ? (
          <textarea {...props} rows={rows} />
        ) : (
          <input {...props} type="text" maxLength={32} />
        )}
        {fields.error(path) ? <small role="alert">{fields.error(path)}</small> : null}
      </label>
    );
  };
  return (
    <>
      {toggle('postSuggestionsEnabled', 'Принимать предложения')}
      {enabled.kind !== 'common' || enabled.value ? (
        <>
          {toggle('postSuggestionsRequireSubscription', 'Требовать подписку')}
          {toggle('postSuggestionsDeleteOnUnsubscribe', 'Удалять посты после отписки')}
          <div className="channel-settings-mode-card channel-settings-mode-card--suggestion">
            <span className="channel-settings-mode-card__label">Отправка</span>
            {mode.kind === 'mixed' ? <small>Разные значения</small> : null}
            <SegmentedControl
              value={mode.kind === 'common' ? mode.value : ''}
              options={[
                { value: 'MINIAPP', label: 'В приложении', disabled: fields.readOnly },
                { value: 'BOT', label: 'В боте', disabled: fields.readOnly },
              ]}
              onChange={(value) => {
                if (value === 'MINIAPP' || value === 'BOT')
                  fields.setScalar('postSuggestionsEntryMode', value);
              }}
              className="channel-settings-mode-card__control"
              ariaLabel="Способ отправки предложения"
            />
          </div>
          <div className="channel-settings-stack channel-settings-form-grid">
            {text('postSuggestionsButtonText', 'Текст кнопки', 'Предложить пост')}
            {text(
              'postSuggestionsText',
              'Что нужно прислать',
              'Например: идея поста или важная новость',
              4,
            )}
            {text(
              'engagementMessageText',
              'Текст перед кнопками',
              'Есть идея или обратная связь? Нажмите кнопку ниже.',
              3,
            )}
            <label className="field">
              <span>От одного пользователя</span>
              <div className="field__number-wrap">
                <select
                  aria-label="От одного пользователя"
                  value={dailyLimit.kind === 'common' ? String(dailyLimit.value) : ''}
                  disabled={fields.readOnly || dailyLimit.kind === 'loading'}
                  onChange={(event) =>
                    fields.setScalar('postSuggestionsDailyLimit', Number(event.target.value))
                  }
                >
                  {dailyLimit.kind !== 'common' ? (
                    <option value="" disabled>
                      {dailyLimit.kind === 'mixed' ? 'Разные значения' : 'Загрузка…'}
                    </option>
                  ) : null}
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <small>в сутки</small>
              </div>
            </label>
          </div>
        </>
      ) : null}
    </>
  );
}
