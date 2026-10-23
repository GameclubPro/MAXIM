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
        Для каждой кнопки добавьте в новом посте отдельную строку «Название = ссылка».
        <span className="channel-quick-buttons-source">
          <br />
          <code>Подробнее = https://example.com</code>
        </span>
        <br />
        Бот уберёт эту строку и добавит кнопку под постом. Вложения и оформление текста сохранятся.
      </p>
      <figure className="channel-quick-buttons-example">
        <figcaption>Пример строки в посте</figcaption>
        <code>Подробнее = https://example.com</code>
        <span className="channel-quick-buttons-example__label">Кнопка под постом</span>
        <span className="channel-quick-buttons-example__button">
          Подробнее <span aria-hidden>↗</span>
        </span>
      </figure>
    </>
  );
}
