import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { MouseEvent } from 'react';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../../api/src/publisher/publisher-bot-descriptor';
import { openPublikBot, PUBLIK_BOT_URL } from '../src/lib/publik-bot';
import { isRetiredPublishingSettingsRoute } from '../src/lib/retired-publishing-route';

const source = readFileSync(
  new URL('../src/components/publik-handoff.tsx', import.meta.url),
  'utf8',
);
const app = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const originalWindow = globalThis.window;
test.afterEach(() => Object.assign(globalThis, { window: originalWindow }));

function event(overrides: object = {}) {
  let prevented = false;
  return {
    click: {
      button: 0,
      preventDefault: () => {
        prevented = true;
      },
      ...overrides,
    } as unknown as MouseEvent<HTMLAnchorElement>,
    prevented: () => prevented,
  };
}

test('Publik opens its real bot dialog with a native MAX link', () => {
  const opened: string[] = [];
  Object.assign(globalThis, {
    window: {
      location: { href: 'https://major-maksimov.ru/app/' },
      WebApp: { initData: 'query_id=test', openMaxLink: (url: string) => opened.push(url) },
      setTimeout: () => 0,
    },
  });
  const click = event();
  openPublikBot(click.click);
  assert.equal(PUBLIK_BOT_URL, 'https://max.ru/' + DEFAULT_MAX_PUBLISHER_BOT_ID);
  assert.deepEqual(opened, [PUBLIK_BOT_URL]);
  assert.equal(click.prevented(), true);
  assert.ok(source.includes('href={PUBLIK_BOT_URL}'));
  assert.doesNotMatch(source, /profile=|startapp=/u);
});

test('browser navigation survives missing or broken MAX bridges', () => {
  const opened: string[] = [];
  Object.assign(globalThis, {
    window: { location: { assign: (url: string) => opened.push(url) } },
  });
  openPublikBot(event().click);
  assert.deepEqual(opened, [PUBLIK_BOT_URL]);
  Object.assign(globalThis, {
    window: {
      location: { href: 'https://major-maksimov.ru/app/' },
      WebApp: {
        initData: 'query_id=test',
        openMaxLink: () => {
          throw new Error('unavailable');
        },
      },
    },
  });
  const click = event();
  openPublikBot(click.click);
  assert.equal(click.prevented(), false);
});

test('modifier and middle clicks keep ordinary browser behavior', () => {
  for (const overrides of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const click = event(overrides);
    openPublikBot(click.click);
    assert.equal(click.prevented(), false);
  }
});

test('Major retired routes show only a bot handoff', () => {
  assert.doesNotMatch(app, /LazyPublicationsPage[^>]*profile="moderation"/u);
  assert.ok(app.includes('path="/autoposts" element={<LazyPublikHandoff />}'));
  for (const search of [
    '?focus=broadcast&handoff=1',
    '?focus=mailing',
    '?workspace=autoposts',
    '?legacyKind=autopost&legacyId=old',
  ]) {
    assert.equal(isRetiredPublishingSettingsRoute(search), true);
  }
  for (const search of ['', '?focus=links', '?focus=giveaway&handoff=1']) {
    assert.equal(isRetiredPublishingSettingsRoute(search), false);
  }
  assert.doesNotMatch(source, /старые|ранее созданные|расписания/iu);
});
