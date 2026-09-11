import { ArrowUpRight, Undo } from 'iconoir-react';
import { useState } from 'react';
import {
  KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH,
  KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH,
  KARAVAN_STOREFRONT_TEXT_DEFAULTS,
  resolveKaravanStorefrontTexts,
  type KaravanStorefrontTextField,
  type KaravanStorefrontTexts,
} from '@maxim/contracts/karavan-storefront';

const buttonFields = [
  ['karavanStorefrontOpenButtonText', 'Кнопка продавца'],
  ['karavanStorefrontCatalogButtonText', 'Кнопка каталога'],
  ['karavanStorefrontCreateButtonText', 'Кнопка создания витрины'],
] as const;

export function SettingsStorefrontTextEditor({
  draft,
  onChange,
}: {
  draft: KaravanStorefrontTexts;
  onChange: (field: KaravanStorefrontTextField, value: string) => void;
}) {
  const [variant, setVariant] = useState<'storefront' | 'directory'>('storefront');
  const texts = resolveKaravanStorefrontTexts(draft);
  const hasCustomText = Object.keys(KARAVAN_STOREFRONT_TEXT_DEFAULTS).some((field) =>
    Boolean(draft[field as KaravanStorefrontTextField]),
  );
  const previewButtons =
    variant === 'storefront'
      ? [texts.karavanStorefrontOpenButtonText]
      : [texts.karavanStorefrontCatalogButtonText, texts.karavanStorefrontCreateButtonText];

  return (
    <section className="settings-storefront-editor" aria-labelledby="storefront-text-title">
      <div className="settings-storefront-editor__head">
        <h3 id="storefront-text-title">Сообщение и кнопки</h3>
        <button
          type="button"
          className="settings-storefront-editor__reset"
          aria-label="Вернуть стандартные тексты витрины"
          title="Вернуть стандартные тексты"
          disabled={!hasCustomText}
          onClick={() => {
            for (const field of Object.keys(KARAVAN_STOREFRONT_TEXT_DEFAULTS)) {
              onChange(field as KaravanStorefrontTextField, '');
            }
          }}
        >
          <Undo aria-hidden />
        </button>
      </div>

      <label className="settings-storefront-editor__field" htmlFor="karavanStorefrontMessageText">
        <span className="settings-storefront-editor__label">
          <span>Текст сообщения</span>
          <span className="settings-storefront-editor__counter">
            {draft.karavanStorefrontMessageText.length}/{KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH}
          </span>
        </span>
        <textarea
          id="karavanStorefrontMessageText"
          value={draft.karavanStorefrontMessageText}
          placeholder={KARAVAN_STOREFRONT_TEXT_DEFAULTS.karavanStorefrontMessageText}
          maxLength={KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH}
          rows={3}
          onChange={(event) => onChange('karavanStorefrontMessageText', event.target.value)}
        />
      </label>

      <div className="settings-storefront-editor__buttons">
        {buttonFields.map(([field, label]) => (
          <label key={field} className="settings-storefront-editor__field" htmlFor={field}>
            <span className="settings-storefront-editor__label">
              <span>{label}</span>
              <span className="settings-storefront-editor__counter">
                {draft[field].length}/{KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH}
              </span>
            </span>
            <input
              id={field}
              type="text"
              value={draft[field]}
              placeholder={KARAVAN_STOREFRONT_TEXT_DEFAULTS[field]}
              maxLength={KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH}
              onChange={(event) =>
                onChange(field, event.target.value.replace(/[\r\n\u2028\u2029]+/gu, ' '))
              }
            />
          </label>
        ))}
      </div>

      <div className="settings-storefront-editor__preview-head">
        <h4>Предпросмотр</h4>
        <div
          className="settings-storefront-editor__modes"
          role="group"
          aria-label="Вариант витрины"
        >
          {(
            [
              ['storefront', 'Есть витрина'],
              ['directory', 'Нет витрины'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={variant === value}
              onClick={() => setVariant(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="settings-storefront-editor__preview"
        aria-label="Предпросмотр сообщения витрины"
      >
        <div className="settings-storefront-editor__message">
          <span className="settings-storefront-editor__sender">Бот</span>
          <p>{texts.karavanStorefrontMessageText}</p>
        </div>
        <div className="settings-storefront-editor__preview-buttons">
          {previewButtons.map((label, index) => (
            <div className="settings-storefront-editor__preview-button" key={index}>
              <span>{label}</span>
              <ArrowUpRight aria-hidden />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
