import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { FieldToggle, FieldText } from '../../features/network-settings/settings-field-controls';
const toggles = [
  ['commentsEnabled', 'Комментарии под постами'],
  ['commentsModerationEnabled', 'Проверять комментарии'],
  ['commentsBlockLinksEnabled', 'Запрещать ссылки'],
  ['commentsAntiSpamEnabled', 'Защита от повторов'],
  ['commentsLimitTwoInRowEnabled', 'Не больше двух подряд'],
] as const;
export function ChannelCommentsFields({ fields }: { fields: ChannelSettingsFieldAdapter }) {
  const enabled = fields.read('commentsEnabled'),
    moderation = fields.read('commentsModerationEnabled');
  return (
    <div className="channel-settings-stack channel-settings-stack--form">
      {toggles.map(([path, label], index) => {
        if (index > 0 && enabled.kind === 'common' && !enabled.value) return null;
        if (index > 1 && moderation.kind === 'common' && !moderation.value) return null;
        return (
          <FieldToggle
            key={path}
            label={label}
            state={fields.read(path)}
            onChange={(value) => fields.setScalar(path, value)}
            disabled={fields.readOnly}
            error={fields.error(path)}
          />
        );
      })}
      {enabled.kind !== 'common' || enabled.value ? (
        <FieldText
          label="Сообщение перед комментариями"
          placeholder="Например: поделитесь мнением о публикации"
          multiline
          state={fields.read('commentsMessageText')}
          onChange={(value) => fields.setScalar('commentsMessageText', value)}
          onError={(error) => fields.setError('commentsMessageText', error)}
          disabled={fields.readOnly}
          error={fields.error('commentsMessageText')}
        />
      ) : null}
    </div>
  );
}
