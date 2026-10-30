import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  resolveKaravanStorefrontTexts,
  type KaravanStorefrontTexts,
} from '@maxim/contracts/karavan-storefront';
import type { ChatSettingsFieldAdapter } from '../src/features/network-settings/field-model';
import { SettingsStorefrontTextEditor } from '../src/pages/settings/settings-storefront-text-editor';
import { StorefrontAudience } from '../src/pages/settings/storefront-audience';
import { StorefrontPublicationPreviewContext } from '../src/pages/settings/storefront-publication-preview';

const draft: KaravanStorefrontTexts = {
  karavanStorefrontMessageText: '',
  karavanStorefrontOpenButtonText: '',
  karavanStorefrontCatalogButtonText: '',
  karavanStorefrontCreateButtonText: '',
};

test('the bot response example stays visible while text editing starts collapsed', () => {
  const changes: unknown[] = [];
  const html = renderToStaticMarkup(
    createElement(
      StorefrontPublicationPreviewContext.Provider,
      { value: { mode: 'chat_marketplace' } },
      createElement(SettingsStorefrontTextEditor, {
        draft,
        onChange: (...change) => changes.push(change),
      }),
    ),
  );
  const preview = html.indexOf('class="settings-storefront-editor__preview"');
  const scenarios = html.indexOf('aria-label="Сценарий примера"');
  const editing = html.indexOf('<details');
  const input = html.indexOf('id="karavanStorefrontMessageText"');
  assert.ok(preview >= 0 && preview < scenarios && scenarios < editing && editing < input);
  assert.match(html, /<details[^>]*><summary[^>]*>Изменить текст<\/summary>/u);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/u);
  const defaults = resolveKaravanStorefrontTexts(draft);
  assert.ok(html.includes(`<p>${defaults.karavanStorefrontMessageText}</p>`));
  assert.ok(html.includes(`<span>${defaults.karavanStorefrontOpenButtonText}</span>`));
  assert.match(html, /id="karavanStorefrontOpenButtonText"/u);
  assert.match(html, /id="karavanStorefrontCatalogButtonText"/u);
  assert.doesNotMatch(html, /id="karavanStorefrontCreateButtonText"/u);
  assert.deepEqual(changes, []);
});

test('network edits keep mixed values and validation errors without inventing a chat example', () => {
  const fields: ChatSettingsFieldAdapter = {
    read: () => ({ kind: 'mixed' }),
    setScalar: () => assert.fail('rendering cannot change settings'),
    replaceList: () => assert.fail('rendering cannot change settings'),
    clearMedia: () => assert.fail('rendering cannot change settings'),
    revert: () => assert.fail('rendering cannot change settings'),
    transact: () => assert.fail('rendering cannot change settings'),
    isDirty: () => false,
    error: (field) => (field === 'karavanStorefrontMessageText' ? 'Проверьте текст ответа.' : null),
    setError: () => undefined,
    readOnly: true,
  };
  const html = renderToStaticMarkup(
    createElement(SettingsStorefrontTextEditor, { fields, scope: 'network' }),
  );
  assert.doesNotMatch(html, /settings-storefront-editor__preview|Сценарий примера/u);
  assert.match(html, /<details[^>]*\bopen=""/u);
  assert.match(html, /role="alert">Проверьте текст ответа\./u);
  for (const field of Object.keys(draft)) {
    assert.match(
      html,
      new RegExp(`id="${field}"[^>]*placeholder="Разные значения"[^>]*disabled=""`, 'u'),
    );
  }
});

test('response permissions describe invoking the bot, separately from marketplace admission', () => {
  const html = renderToStaticMarkup(
    createElement(StorefrontAudience, {
      state: { kind: 'mixed' },
      onChange: () => assert.fail('rendering cannot change permissions'),
    }),
  );
  assert.match(html, /<legend>Кто может вызвать ответ на \$<\/legend>/u);
  assert.match(html, /Все участники/u);
  assert.match(html, /Администраторы и выбранные пользователи/u);
  assert.match(html, /Разные значения/u);
  assert.doesNotMatch(html, /добавить ссылку|продавц|покупател/u);
});
