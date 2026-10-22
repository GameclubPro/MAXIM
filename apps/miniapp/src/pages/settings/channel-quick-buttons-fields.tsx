import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { ChannelSettingsToggleCard } from './channel-settings-toggle-card';
export function ChannelQuickButtonsFields({ fields }: { fields: ChannelSettingsFieldAdapter }) {
  return (
    <>
      <ChannelSettingsToggleCard
        title="Быстрые кнопки"
        describedBy="channel-quick-buttons-help"
        state={fields.read('quickButtonsEnabled')}
        onChange={(value) => fields.setScalar('quickButtonsEnabled', value)}
        disabled={fields.readOnly}
        error={fields.error('quickButtonsEnabled')}
      />
      <p id="channel-quick-buttons-help" className="settings-native-toggle__hint">
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
