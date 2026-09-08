import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pollWorkspaceSource = readFileSync(
  new URL('../src/components/managed-poll-workspace.tsx', import.meta.url),
  'utf8',
);
const giveawayCardSource = readFileSync(
  new URL('../src/components/managed-giveaway-card.tsx', import.meta.url),
  'utf8',
);

test('managed polls sanitize every user-visible API error', () => {
  assert.match(
    pollWorkspaceSource,
    /import \{ describeUserFacingError \} from '\.\.\/lib\/user-facing-error';/u,
  );
  assert.doesNotMatch(pollWorkspaceSource, /describeApiError/u);
});

test('moderation home and statistics never display raw backend errors', () => {
  for (const page of ['chats-page', 'events-page', 'channel-stats-page']) {
    const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), 'utf8');
    if (page === 'chats-page') {
      assert.match(source, /await import\('\.\.\/lib\/user-facing-error'\)/u);
      assert.match(source, /queryErrorPresentation\?\.error === queryError/u);
      assert.doesNotMatch(source, /import \{ describeUserFacingError \} from/u);
    } else if (page === 'events-page') {
      assert.match(
        source,
        /import \{ describeUserFacingError \} from '\.\.\/lib\/user-facing-error';/u,
      );
    } else {
      assert.match(
        source,
        /title: 'Не удалось открыть профиль',\s*description: 'Попробуйте ещё раз\.'/u,
      );
    }
    assert.doesNotMatch(source, /return error instanceof Error && error\.message/u);
    assert.doesNotMatch(source, /description: error instanceof Error \? error\.message/u);
    assert.doesNotMatch(source, /raw\.startsWith\('API request failed:'/u);
  }
});

test('giveaway finish date only receives finish-date validation errors', () => {
  assert.match(
    giveawayCardSource,
    /function isFinishAtValidationMessage\(message: string\): boolean/u,
  );
  assert.match(
    giveawayCardSource,
    /const finishAtValidationError =[\s\S]*?!basicsValidation\.valid && isFinishAtValidationMessage\(validationHint\)[\s\S]*?\? validationHint : '';/u,
  );
  assert.match(giveawayCardSource, /error=\{finishAtValidationError \|\| undefined\}/u);
  assert.match(
    giveawayCardSource,
    /validationHint && !\(editorStep === 'basics' && finishAtValidationError\)/u,
  );
});
