import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import {
  publicationDraftNeedsAttention,
  publicationDraftProblem,
  publicationDraftSaveLabel,
} from '../src/features/publications/publication-draft-presentation';
import { formatTimezoneLabel } from '../src/lib/timezone-label';
import type { DraftSaveState } from '../src/features/publications/publication-draft-autosave';
import {
  getPublicationRecurrenceIntervalUnit,
  getPublicationRecurrenceIntervalNotice,
} from '../src/features/publications/publication-model';

test('draft status is short without claiming unsaved changes were saved', () => {
  const state = (status: DraftSaveState['status']): DraftSaveState => ({ status, error: null });
  assert.equal(publicationDraftSaveLabel(state('idle'), false), '');
  assert.equal(publicationDraftSaveLabel(state('saved'), false), 'Сохранено');
  assert.equal(publicationDraftSaveLabel(state('saved'), true), 'Не сохранено');
  assert.equal(publicationDraftSaveLabel(state('saving'), true), 'Сохраняется...');
  for (const status of ['error', 'conflict', 'unavailable'] as const) {
    assert.equal(publicationDraftNeedsAttention(state(status)), true);
    assert.equal(publicationDraftSaveLabel(state(status), false), 'Не сохранено');
  }
});

test('conflict messages explain the user consequence without internal version terms', () => {
  for (const status of ['conflict', 'unavailable'] as const) {
    const problem = publicationDraftProblem({
      status,
      error: new Error('server snapshot revision'),
    });
    assert.doesNotMatch(`${problem.title} ${problem.detail}`, /сервер|синхрон|snapshot|revision/iu);
    assert.ok(problem.detail.length > 0);
  }
  const problem = publicationDraftProblem({
    status: 'error',
    error: new Error('Prisma database failure'),
  });
  assert.doesNotMatch(problem.detail, /prisma|database/iu);
});

test('time zone presentation uses readable names without changing stored zones', () => {
  assert.equal(formatTimezoneLabel('Europe/Moscow'), 'Московское время');
  assert.equal(formatTimezoneLabel('UTC'), 'Всемирное время');
  for (const zone of ['Asia/Vladivostok', 'Europe/Berlin', 'America/New_York']) {
    const label = formatTimezoneLabel(zone);
    assert.ok(label.length > 0);
    assert.doesNotMatch(label, /[/_]/u);
  }
  assert.equal(formatTimezoneLabel('Invalid/Zone'), 'Часовой пояс не определён');
});

test('Publisher workspace styling cannot leak to Major after route navigation', () => {
  const stylesheet = readFileSync(
    new URL('../src/styles/publisher-workspace.css', import.meta.url),
    'utf8',
  );
  const root = postcss.parse(stylesheet);
  root.walkRules((rule) => {
    for (const selector of rule.selectors)
      assert.match(selector, /body\[data-miniapp-profile='publisher'\]/u);
  });
  assert.match(stylesheet, /@layer workspace/u);
  assert.doesNotMatch(stylesheet, /linear-gradient|backdrop-filter:\s*blur|font-size:[^;]*vw/u);
});

test('Publisher warnings, placeholders and inactive switches follow the theme', () => {
  const stylesheet = readFileSync(
    new URL('../src/styles/publisher-workspace.css', import.meta.url),
    'utf8',
  );
  const entities = readFileSync(
    new URL('../src/pages/publisher-entities-page.css', import.meta.url),
    'utf8',
  );
  assert.match(entities, /--publisher-attention: var\(--color-warning\)/u);
  assert.match(stylesheet, /--color-warning: var\(--publication-warning-ink\)/u);
  assert.match(stylesheet, /--vk-warning: var\(--publication-warning-ink\)/u);
  assert.match(stylesheet, /--text-muted: var\(--color-ink-subtle\)/u);
  assert.match(stylesheet, /::placeholder \{\s*color: var\(--color-ink-subtle\);\s*opacity: 1;/u);
  assert.match(
    stylesheet,
    /\.publisher-module-switch__thumb \{\s*background: var\(--color-ink-subtle\);/u,
  );
});

test('editor dates use the shared readable date control', () => {
  const source = readFileSync(
    new URL('../src/features/publications/publication-zoned-fields.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /<DateField/u);
  assert.doesNotMatch(source, /type="date"/u);
  assert.match(source, /parsePublicationScheduleField/u);
});

test('recurrence units read naturally for one, few and many periods', () => {
  assert.equal(getPublicationRecurrenceIntervalUnit('weekly', 1), 'неделю');
  assert.equal(getPublicationRecurrenceIntervalUnit('weekly', 2), 'недели');
  assert.equal(getPublicationRecurrenceIntervalUnit('weekly', 5), 'недель');
  assert.equal(getPublicationRecurrenceIntervalUnit('daily', 1), 'день');
  assert.equal(getPublicationRecurrenceIntervalUnit('daily', 22), 'дня');
  assert.equal(
    getPublicationRecurrenceIntervalNotice('weekly', 12)?.title,
    '84 дня между публикациями',
  );
});
