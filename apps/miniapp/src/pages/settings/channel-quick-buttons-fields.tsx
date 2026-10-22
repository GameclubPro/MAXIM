import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { FieldToggle } from '../../features/network-settings/settings-field-controls';
export function ChannelQuickButtonsFields({ fields }: { fields: ChannelSettingsFieldAdapter }) {
  return (
    <>
      <FieldToggle
        label="Быстрые кнопки"
        state={fields.read('quickButtonsEnabled')}
        onChange={(value) => fields.setScalar('quickButtonsEnabled', value)}
        disabled={fields.readOnly}
        error={fields.error('quickButtonsEnabled')}
      />
      <p className="settings-native-toggle__hint">
        В новом посте добавьте отдельную строку:
        <br />
        <code>Подробнее = https://example.com</code>
        <br />
        Бот уберёт эту строку и добавит кнопку под постом. Вложения и оформление текста сохранятся.
        Для каждой кнопки нужна отдельная строка.
      </p>
    </>
  );
}
