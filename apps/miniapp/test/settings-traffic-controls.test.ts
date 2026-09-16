import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import { SettingsTrafficControls } from '../src/pages/settings/settings-traffic-controls';

test('traffic controls show intervals only for enabled rules', () => {
  const render = (enabled: boolean) =>
    renderToStaticMarkup(
      createElement(SettingsTrafficControls, {
        draft: chatSettingsSchema.parse({
          slowModeEnabled: enabled,
          mediaMessageCooldownEnabled: enabled,
        }),
        fieldErrors: {},
        setFieldValue: () => undefined,
      }),
    );
  assert.equal(render(false).match(/type="checkbox"/gu)?.length, 2);
  assert.doesNotMatch(render(false), /type="number"/u);
  assert.equal(render(true).match(/type="number"/gu)?.length, 2);
  assert.doesNotMatch(render(true), /<h[1-6]|<p|GlassCard|settings-info-button/u);
});

test('interval validation is linked to its input', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsTrafficControls, {
      draft: chatSettingsSchema.parse({ slowModeEnabled: true }),
      fieldErrors: { slowModeIntervalSeconds: 'От 10 до 86400 секунд' },
      setFieldValue: () => undefined,
    }),
  );
  assert.match(html, /aria-invalid="true"/u);
  assert.match(html, /aria-describedby="slowModeIntervalSeconds-error"/u);
  assert.match(html, /id="slowModeIntervalSeconds-error"/u);
});
