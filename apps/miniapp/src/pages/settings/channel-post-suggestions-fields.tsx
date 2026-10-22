import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { ChannelSettingsToggleCard } from './channel-settings-toggle-card';
import { ChannelSettingsTextField } from './channel-settings-text-field';
import { SegmentedControl } from '../../components/ui/segmented-control';

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
    <ChannelSettingsToggleCard
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
  ) => (
    <ChannelSettingsTextField
      fields={fields}
      path={path}
      label={label}
      placeholder={placeholder}
      rows={rows}
      maxLength={rows ? undefined : 32}
      className={rows ? 'channel-settings-field--wide' : undefined}
    />
  );
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
                {
                  value: 'MINIAPP',
                  label: 'В приложении',
                  disabled: fields.readOnly || mode.kind === 'loading',
                },
                {
                  value: 'BOT',
                  label: 'В боте',
                  disabled: fields.readOnly || mode.kind === 'loading',
                },
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
