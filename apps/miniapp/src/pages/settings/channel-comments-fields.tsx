import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { ChannelSettingsToggleCard } from './channel-settings-toggle-card';
import { ChannelSettingsTextField } from './channel-settings-text-field';
export function ChannelCommentsFields({ fields }: { fields: ChannelSettingsFieldAdapter }) {
  const enabled = fields.read('commentsEnabled');
  const moderation = fields.read('commentsModerationEnabled');
  const toggle = (
    path:
      | 'commentsEnabled'
      | 'commentsModerationEnabled'
      | 'commentsBlockLinksEnabled'
      | 'commentsAntiSpamEnabled'
      | 'commentsLimitTwoInRowEnabled',
    title: string,
  ) => (
    <ChannelSettingsToggleCard
      title={title}
      state={fields.read(path)}
      disabled={fields.readOnly}
      onChange={(value) => fields.setScalar(path, value)}
      error={fields.error(path)}
    />
  );
  return (
    <>
      {toggle('commentsEnabled', 'Комментарии под постами')}
      {enabled.kind !== 'common' || enabled.value ? (
        <div className="channel-settings-stack channel-settings-stack--form">
          <ChannelSettingsTextField
            fields={fields}
            path="commentsMessageText"
            label="Сообщение перед комментариями"
            placeholder="Например: поделитесь мнением о публикации"
            rows={2}
            className="channel-settings-field--wide"
          />
          {toggle('commentsModerationEnabled', 'Проверять комментарии')}
          {moderation.kind !== 'common' || moderation.value ? (
            <div className="channel-settings-stack channel-settings-toggle-grid">
              {toggle('commentsBlockLinksEnabled', 'Запрещать ссылки')}
              {toggle('commentsAntiSpamEnabled', 'Защита от повторов')}
              {toggle('commentsLimitTwoInRowEnabled', 'Не больше двух подряд')}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
