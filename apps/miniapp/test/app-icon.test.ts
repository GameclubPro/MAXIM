import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, createRef, type SVGProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as iconoir from 'iconoir-react';
import { AppIcon } from '../src/components/ui/app-icon';
import { APP_ICON_NAMES, APP_LAZY_ICON_NAMES } from '../src/components/ui/app-icon-names';

function rootAttributes(markup: string): Array<[string, string]> {
  const tag = markup.match(/^<svg\b([^>]*)>/u)?.[1];
  assert.ok(tag, 'Expected an SVG root');
  return [...tag.matchAll(/([^\s=]+)="([^"]*)"/gu)]
    .map((match): [string, string] => [match[1]!, match[2]!])
    .sort(([left], [right]) => left.localeCompare(right));
}

test('sprite icons preserve Iconoir dimensions, strokes, styling and caller accessibility', () => {
  const cases: SVGProps<SVGSVGElement>[] = [
    {},
    {
      width: 28,
      height: 29,
      strokeWidth: 2,
      color: '#f08512',
      className: 'sample',
      'aria-hidden': true,
      focusable: 'false',
    },
    {
      width: '2em',
      height: '2em',
      style: { color: '#553399' },
      role: 'img',
      'aria-label': 'Информация',
      id: 'custom',
    },
  ];
  for (const icon of [...APP_ICON_NAMES, ...APP_LAZY_ICON_NAMES]) {
    for (const props of cases) {
      const original = renderToStaticMarkup(createElement(iconoir[icon], props));
      const actual = renderToStaticMarkup(
        createElement(AppIcon, { ...props, icon, variant: 'iconoir' }),
      );
      assert.deepEqual(rootAttributes(actual), rootAttributes(original), icon);
    }
  }
});

test('the startup sprite stays separate from icons introduced by lazy screens', () => {
  const startup = new Set<string>(APP_ICON_NAMES);
  assert.equal(startup.size, 45);
  assert.equal(new Set(APP_LAZY_ICON_NAMES).size, APP_LAZY_ICON_NAMES.length);
  for (const icon of APP_ICON_NAMES) {
    const html = renderToStaticMarkup(createElement(AppIcon, { icon }));
    assert.match(html, new RegExp(`iconoir-ui\\.svg#${icon}`));
    assert.doesNotMatch(html, /iconoir-route/u);
  }
  for (const icon of APP_LAZY_ICON_NAMES) {
    assert.ok(!startup.has(icon), icon);
    const html = renderToStaticMarkup(createElement(AppIcon, { icon, variant: 'iconoir' }));
    assert.match(html, new RegExp(`iconoir-route\\.svg#${icon}`));
  }
});

test('the existing AppIcon style and SVG refs remain compatible', () => {
  const ref = createRef<SVGSVGElement>();
  const element = AppIcon({ icon: 'Check', className: 'custom', ref });
  assert.equal(element.props.ref, ref);
  assert.deepEqual(rootAttributes(renderToStaticMarkup(element)), [
    ['aria-hidden', 'true'],
    ['class', 'app-icon custom'],
    ['fill', 'none'],
    ['focusable', 'false'],
    ['height', '24'],
    ['stroke-width', '1.8'],
    ['viewBox', '0 0 24 24'],
    ['width', '24'],
  ]);
});
