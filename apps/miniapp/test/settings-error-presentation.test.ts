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
