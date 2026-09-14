import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RequiredSubscriptionExternalSource,
  RequiredSubscriptionHelp,
  RequiredSubscriptionSourceDisclosure,
} from '../src/pages/settings/settings-required-subscription-ui';

test('subscription help is labeled and keeps the explanation hidden until requested', () => {
  const html = renderToStaticMarkup(createElement(RequiredSubscriptionHelp));
  assert.match(html, /aria-label="Как работает обязательная подписка"/u);
  assert.match(html, /title="Как работает обязательная подписка"/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /aria-controls="settings-hint-requiredSubscriptionEnabled"/u);
  assert.doesNotMatch(html, /role="note"|Помогает привлекать/u);
});

test('source discovery starts open for an empty subscription', () => {
  const html = renderToStaticMarkup(
    createElement(RequiredSubscriptionSourceDisclosure, {
      initiallyOpen: true,
      children: createElement('input', { 'aria-label': 'Найти чат или канал' }),
    }),
  );
  assert.match(html, /aria-expanded="true"/u);
  assert.match(html, /Найти чат или канал/u);
  assert.doesNotMatch(html, /hidden=""/u);
  const controlledId = html.match(/aria-controls="([^"]+)"/u)?.[1];
  assert.ok(controlledId);
  assert.ok(html.includes(`id="${controlledId}"`));
});

test('configured subscriptions defer the source picker until it is expanded', () => {
  const html = renderToStaticMarkup(
    createElement(RequiredSubscriptionSourceDisclosure, {
      initiallyOpen: false,
      children: createElement('input', { 'aria-label': 'Найти чат или канал' }),
    }),
  );
  assert.match(html, /Добавить источник/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /hidden=""/u);
  assert.doesNotMatch(html, /<input/u);
});

function renderExternalSource(
  overrides: Partial<Parameters<typeof RequiredSubscriptionExternalSource>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(RequiredSubscriptionExternalSource, {
      value: 'https://max.ru/example',
      error: '',
      loading: false,
      limitReached: false,
      onChange: () => undefined,
      onSubmit: () => undefined,
      ...overrides,
    }),
  );
}

test('external source submission is unavailable while empty, loading or at the limit', () => {
  assert.doesNotMatch(renderExternalSource(), /disabled=""/u);
  for (const overrides of [{ value: '  ' }, { loading: true }, { limitReached: true }]) {
    assert.match(renderExternalSource(overrides), /<button[^>]*disabled=""/u);
  }
  assert.match(renderExternalSource({ loading: true }), /aria-busy="true"/u);
});

test('external source errors are associated with a mobile URL input', () => {
  const html = renderExternalSource({ error: 'Источник недоступен' });
  assert.match(html, /inputMode="url"/u);
  assert.match(html, /aria-invalid="true"/u);
  assert.match(html, /role="alert">Источник недоступен/u);
  const describedId = html.match(/aria-describedby="([^"]+)"/u)?.[1];
  assert.ok(describedId);
  assert.ok(html.includes(`id="${describedId}"`));
});
